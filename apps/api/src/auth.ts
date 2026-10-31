import { createMiddleware } from "hono/factory";
import {
  CoreError,
  getMockCustomer,
  type Db,
  type MockCustomer,
} from "@repo/core";

export type DeskRole = "agent" | "approver" | "admin";

export type DeskActor = {
  actorId: string;
  role: DeskRole;
};

export type AppVariables = {
  db: Db;
  customer?: MockCustomer;
  desk?: DeskActor;
};

export const requireCustomer = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  const customerId = c.req.header("x-customer-id")?.trim();
  if (!customerId) {
    return c.json(
      { error: "Missing X-Customer-Id header", code: "UNAUTHORIZED" },
      401,
    );
  }

  try {
    const customer = await getMockCustomer(c.get("db"), customerId);
    c.set("customer", customer);
    await next();
  } catch (error) {
    if (error instanceof CoreError && error.code === "NOT_FOUND") {
      return c.json({ error: "Unknown customer", code: "UNAUTHORIZED" }, 401);
    }
    throw error;
  }
});

const DESK_ROLES = new Set<DeskRole>(["agent", "approver", "admin"]);

export const requireDesk = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  const roleRaw = c.req.header("x-desk-role")?.trim().toLowerCase();
  const actorId = c.req.header("x-desk-actor")?.trim();
  if (!roleRaw || !actorId) {
    return c.json(
      {
        error: "Missing X-Desk-Role or X-Desk-Actor header",
        code: "UNAUTHORIZED",
      },
      401,
    );
  }
  if (!DESK_ROLES.has(roleRaw as DeskRole)) {
    return c.json({ error: "Invalid desk role", code: "UNAUTHORIZED" }, 401);
  }
  c.set("desk", { actorId, role: roleRaw as DeskRole });
  await next();
});
