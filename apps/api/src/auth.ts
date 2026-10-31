import { createMiddleware } from "hono/factory";
import {
  CoreError,
  getDeskAgent,
  getMockCustomer,
  type Db,
  type DeskAgent,
  type MockCustomer,
} from "@repo/core";
import {
  loadDeskCredentials,
  verifyDeskToken,
} from "./desk-auth.js";

export type DeskRole = "agent" | "approver" | "admin";

export type DeskActor = {
  actorId: string;
  role: DeskRole;
};

export type AppVariables = {
  db: Db;
  customer?: MockCustomer;
  desk?: DeskActor;
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

/** HMAC desk session (approve/reject/demo clock / workflows). */
export const requireDesk = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  const header = c.req.header("authorization")?.trim();
  const bearer = header?.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : null;
  const token = bearer || c.req.header("x-desk-token")?.trim() || null;

  if (!token) {
    return c.json(
      { error: "Missing desk session token", code: "UNAUTHORIZED" },
      401,
    );
  }

  const creds = loadDeskCredentials();
  const actor = verifyDeskToken(token, creds.password);
  if (!actor) {
    return c.json(
      { error: "Invalid or expired desk session", code: "UNAUTHORIZED" },
      401,
    );
  }

  c.set("desk", actor);
  await next();
});

/** Named desk agent from DESK_AGENTS (queue / takeover / hand-back). */
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

/** Customer header, HMAC desk token, or desk agent id — shared read surfaces. */
export const requireCustomerOrDesk = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  const customerId = c.req.header("x-customer-id")?.trim();
  if (customerId) {
    try {
      const customer = await getMockCustomer(c.get("db"), customerId);
      c.set("customer", customer);
      await next();
      return;
    } catch (error) {
      if (!(error instanceof CoreError && error.code === "NOT_FOUND")) {
        throw error;
      }
    }
  }

  const header = c.req.header("authorization")?.trim();
  const bearer = header?.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : null;
  const token = bearer || c.req.header("x-desk-token")?.trim() || null;
  if (token) {
    const creds = loadDeskCredentials();
    const actor = verifyDeskToken(token, creds.password);
    if (actor) {
      c.set("desk", actor);
      await next();
      return;
    }
  }

  const agentId = c.req.header("x-desk-agent-id")?.trim();
  if (agentId) {
    try {
      const agent = getDeskAgent(agentId);
      c.set("deskAgent", agent);
      await next();
      return;
    } catch (error) {
      if (!(error instanceof CoreError && error.code === "NOT_FOUND")) {
        throw error;
      }
    }
  }

  return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
});

/** Desk HMAC token or named desk agent — promote / ops controls. */
export const requireAnyDesk = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  const header = c.req.header("authorization")?.trim();
  const bearer = header?.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : null;
  const token = bearer || c.req.header("x-desk-token")?.trim() || null;
  if (token) {
    const creds = loadDeskCredentials();
    const actor = verifyDeskToken(token, creds.password);
    if (actor) {
      c.set("desk", actor);
      await next();
      return;
    }
  }

  const agentId = c.req.header("x-desk-agent-id")?.trim();
  if (agentId) {
    try {
      const agent = getDeskAgent(agentId);
      c.set("deskAgent", agent);
      await next();
      return;
    } catch (error) {
      if (error instanceof CoreError && error.code === "NOT_FOUND") {
        return c.json(
          { error: "Unknown desk agent", code: "UNAUTHORIZED" },
          401,
        );
      }
      throw error;
    }
  }

  return c.json({ error: "Desk auth required", code: "UNAUTHORIZED" }, 401);
});
