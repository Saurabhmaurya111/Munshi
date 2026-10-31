import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  CoreError,
  checkDb,
  createCase,
  createCaseAndAppendMessage,
  getCaseForCustomer,
  listCaseEvents,
  type Db,
} from "@repo/core";
import { requireCustomer, type AppVariables } from "./auth.js";

const createCaseBody = z.object({
  priority: z.number().int().min(0).max(100).optional(),
  customerId: z.string().optional(), // ignored; session wins
});

const messageBody = z.object({
  message: z.string().min(1),
  caseId: z.string().uuid().optional(),
  commandId: z.string().min(1).max(128).optional(),
  customerId: z.string().optional(), // ignored; session wins
  priority: z.number().int().min(0).max(100).optional(),
});

function mapCoreError(error: unknown): {
  status: 400 | 403 | 404 | 409;
  body: { error: string; code: string };
} | null {
  if (!(error instanceof CoreError)) return null;
  const status =
    error.code === "BAD_REQUEST"
      ? 400
      : error.code === "FORBIDDEN"
        ? 403
        : error.code === "NOT_FOUND"
          ? 404
          : 409;
  return { status, body: { error: error.message, code: error.code } };
}

export function createApp(db: Db) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use(
    "*",
    cors({
      origin: [
        "http://localhost:3002",
        "http://127.0.0.1:3002",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ],
      allowHeaders: ["Content-Type", "X-Customer-Id"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  app.get("/health", async (c) => {
    const up = await checkDb(db);
    return c.json({ ok: up, db: up ? "up" : "down" }, up ? 200 : 503);
  });

  app.get("/v1/me", requireCustomer, (c) => {
    const customer = c.get("customer")!;
    return c.json({
      customerId: customer.id,
      displayName: customer.displayName,
      accountType: customer.accountType,
      kycStatus: customer.kycStatus,
      roles: ["customer"],
    });
  });

  app.post("/v1/cases", requireCustomer, async (c) => {
    const parsed = createCaseBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "BAD_REQUEST" }, 400);
    }
    const customer = c.get("customer")!;
    const created = await createCase(db, {
      customerId: customer.id,
      priority: parsed.data.priority,
    });
    return c.json(
      {
        conversationId: created.id,
        status: created.status,
        ownership: created.ownership,
        customerId: created.customerId,
        priority: created.priority,
        lastEventSeq: Number(created.lastEventSeq),
      },
      201,
    );
  });

  app.get("/v1/cases/:caseId", requireCustomer, async (c) => {
    const customer = c.get("customer")!;
    const caseId = c.req.param("caseId");
    try {
      const caseRow = await getCaseForCustomer(db, {
        caseId,
        customerId: customer.id,
      });
      const events = await listCaseEvents(db, { caseId, limit: 50 });
      return c.json({
        conversationId: caseRow.id,
        status: caseRow.status,
        ownership: caseRow.ownership,
        customerId: caseRow.customerId,
        priority: caseRow.priority,
        runnable: caseRow.runnable,
        lastEventSeq: Number(caseRow.lastEventSeq),
        events: events.map((event) => ({
          seq: Number(event.seq),
          type: event.type,
          audience: event.audience,
          payload: event.payload,
          createdAt: event.createdAt.toISOString(),
        })),
      });
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.post("/v1/cases/:caseId/messages", requireCustomer, async (c) => {
    const customer = c.get("customer")!;
    const caseId = c.req.param("caseId");
    const parsed = messageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "BAD_REQUEST" }, 400);
    }
    try {
      const result = await createCaseAndAppendMessage(db, {
        customerId: customer.id,
        caseId,
        message: parsed.data.message,
        commandId: parsed.data.commandId,
      });
      return c.json(
        {
          conversationId: result.case.id,
          status: result.created ? "accepted" : "duplicate",
          seq: Number(result.event.seq),
          requiresCustomerInput: false,
        },
        result.created ? 201 : 200,
      );
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.post("/v1/cases/messages", requireCustomer, async (c) => {
    const customer = c.get("customer")!;
    const parsed = messageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "BAD_REQUEST" }, 400);
    }
    try {
      const result = await createCaseAndAppendMessage(db, {
        customerId: customer.id,
        caseId: parsed.data.caseId,
        message: parsed.data.message,
        commandId: parsed.data.commandId,
        priority: parsed.data.priority,
      });
      return c.json(
        {
          conversationId: result.case.id,
          status: result.created ? "accepted" : "duplicate",
          seq: Number(result.event.seq),
          requiresCustomerInput: false,
        },
        result.created ? 201 : 200,
      );
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  return app;
}
