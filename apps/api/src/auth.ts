import { createMiddleware } from "hono/factory";
import {
  CoreError,
  getDeskAgent,
  getMockCustomer,
  type Db,
  type DeskAgent,
  type MockCustomer,
} from "@repo/core";

export type AppVariables = {
  db: Db;
  customer?: MockCustomer;
  deskAgent?: DeskAgent;
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

export const requireDeskAgent = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  const agentId = c.req.header("x-desk-agent-id")?.trim();
  if (!agentId) {
    return c.json(
      { error: "Missing X-Desk-Agent-Id header", code: "UNAUTHORIZED" },
      401,
    );
  }

  try {
    const agent = getDeskAgent(agentId);
    c.set("deskAgent", agent);
    await next();
  } catch (error) {
    if (error instanceof CoreError && error.code === "NOT_FOUND") {
      return c.json(
        { error: "Unknown desk agent", code: "UNAUTHORIZED" },
        401,
      );
    }
    throw error;
  }
});
