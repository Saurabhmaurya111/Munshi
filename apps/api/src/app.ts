import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  CoreError,
  advanceVirtualClock,
  appendHumanMessage,
  applyDeskCommand,
  checkDb,
  createCase,
  createCaseAndAppendMessage,
  emitCaseEventNotice,
  forcePromoteWorkflow,
  getCaseForCustomer,
  getCaseForDesk,
  getVirtualNow,
  getWorkflowStatus,
  handBackCase,
  listCaseEvents,
  listDeskQueue,
  listPendingApprovals,
  listWorkflowStatuses,
  requestHumanTransfer,
  setVirtualClock,
  setWorkflowLevel,
  takeoverCase,
  type Db,
  type WorkflowLevel,
} from "@repo/core";
import { createInvokeTool } from "@repo/gateway";
import {
  requireCustomer,
  requireAnyDesk,
  requireCustomerOrDesk,
  requireDesk,
  requireDeskAgent,
  type AppVariables,
} from "./auth.js";
import {
  authenticateDeskLogin,
  loadDeskCredentials,
  mintDeskToken,
} from "./desk-auth.js";

const createCaseBody = z.object({
  priority: z.number().int().min(0).max(100).optional(),
  customerId: z.string().optional(),
});

const messageBody = z.object({
  message: z.string().min(1),
  caseId: z.string().uuid().optional(),
  commandId: z.string().min(1).max(128).optional(),
  customerId: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

const deskCommandBody = z.object({
  type: z.enum(["approve", "reject", "takeover", "hand_back"]),
  commandId: z.string().min(1).max(128),
  stepId: z.string().min(1).max(256).optional(),
  note: z.string().max(500).optional(),
});

const clockBody = z
  .object({
    advanceByMs: z.number().int().nonnegative().optional(),
    setTo: z.string().datetime().optional(),
  })
  .refine((value) => value.advanceByMs !== undefined || value.setTo !== undefined, {
    message: "advanceByMs or setTo required",
  });

const transferBody = z.object({
  commandId: z.string().min(1).max(128),
  reason: z.string().min(1).max(500).optional(),
});

const deskTakeoverBody = z.object({
  commandId: z.string().min(1).max(128),
  note: z.string().max(1000).optional(),
});

const deskHandBackBody = z.object({
  commandId: z.string().min(1).max(128),
  note: z.string().min(1).max(2000),
  instruction: z.string().max(2000).optional(),
});

const deskMessageBody = z.object({
  message: z.string().min(1).max(4000),
  commandId: z.string().min(1).max(128),
});

const promoteBody = z.object({
  /** Jump straight to this level (0–2). Otherwise bump one level. */
  level: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
});

const deskLoginBody = z.object({
  id: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
});

function workflowJson(status: Awaited<ReturnType<typeof getWorkflowStatus>>) {
  return {
    name: status.name,
    level: status.level,
    consecutiveCleanRuns: status.consecutiveCleanRuns,
    writeCleanRuns: status.writeCleanRuns,
    promotionThreshold: status.promotionThreshold,
    progress: status.progress,
    nextLevel: status.nextLevel,
    runsToNext: status.runsToNext,
    updatedAt: status.updatedAt.toISOString(),
  };
}

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

function serializeEvents(
  events: Awaited<ReturnType<typeof listCaseEvents>>,
) {
  return events.map((event) => ({
    seq: Number(event.seq),
    type: event.type,
    audience: event.audience,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  }));
}

export function createApp(db: Db) {
  const app = new Hono<{ Variables: AppVariables }>();
  const tools = createInvokeTool({ db, timeoutMs: 8_000 });

  app.use(
    "*",
    cors({
      origin: [
        "http://localhost:3002",
        "http://127.0.0.1:3002",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Customer-Id",
        "X-Desk-Role",
        "X-Desk-Actor",
        "X-Desk-Agent-Id",
        "X-Desk-Token",
      ],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    const unreachable =
      code === "ETIMEDOUT" ||
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      /timeout|ECONNREFUSED|ETIMEDOUT/i.test(message);
    if (unreachable) {
      console.error(JSON.stringify({ msg: "db_unreachable", code, message }));
      return c.json(
        { error: "Database unreachable. Try again in a moment.", code: "DB_UNAVAILABLE" },
        503,
      );
    }
    console.error(error);
    return c.json({ error: "Internal server error", code: "INTERNAL" }, 500);
  });

  app.get("/health", async (c) => {
    const up = await checkDb(db);
    return c.json({ ok: up, db: up ? "up" : "down" }, up ? 200 : 503);
  });

  /**
   * Worker → API bridge when Postgres LISTEN is unavailable (transaction poolers).
   * Re-emits onto the in-process bus so Socket.io can fan out.
   */
  app.post("/v1/internal/case-events/fanout", async (c) => {
    const expected = process.env.CASE_EVENT_FANOUT_SECRET?.trim();
    if (expected) {
      const header = c.req.header("authorization")?.trim() ?? "";
      const token = header.toLowerCase().startsWith("bearer ")
        ? header.slice(7).trim()
        : header;
      if (token !== expected) {
        return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
      }
    }

    const body = (await c.req.json().catch(() => null)) as {
      caseId?: unknown;
      seq?: unknown;
    } | null;
    const caseId = typeof body?.caseId === "string" ? body.caseId.trim() : "";
    const seq = Number(body?.seq);
    if (!caseId || !Number.isFinite(seq) || seq < 1) {
      return c.json({ error: "Invalid notice", code: "BAD_REQUEST" }, 400);
    }

    emitCaseEventNotice({ caseId, seq });
    return c.json({ ok: true });
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
      const events = await listCaseEvents(db, {
        caseId,
        limit: 100,
        audience: "customer",
      });
      return c.json({
        conversationId: caseRow.id,
        status: caseRow.status,
        ownership: caseRow.ownership,
        customerId: caseRow.customerId,
        priority: caseRow.priority,
        runnable: caseRow.runnable,
        lastEventSeq: Number(caseRow.lastEventSeq),
        events: serializeEvents(events),
      });
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.post("/v1/cases/:caseId/transfer-to-human", requireCustomer, async (c) => {
    const customer = c.get("customer")!;
    const caseId = c.req.param("caseId");
    const parsed = transferBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "BAD_REQUEST" }, 400);
    }
    try {
      await getCaseForCustomer(db, {
        caseId,
        customerId: customer.id,
      });
      const result = await requestHumanTransfer(db, {
        caseId,
        customerId: customer.id,
        commandId: parsed.data.commandId,
        reason: parsed.data.reason,
      });
      return c.json(
        {
          conversationId: result.case.id,
          ownership: result.case.ownership,
          status: result.created ? "transferred" : "already_human",
          lastEventSeq: Number(result.case.lastEventSeq),
          ticketId: result.ticket?.complaintId ?? null,
          ticketStatus: result.ticket?.status ?? null,
        },
        result.created ? 201 : 200,
      );
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
          ownership: result.case.ownership,
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
          ownership: result.case.ownership,
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

  app.post("/v1/desk/login", async (c) => {
    const parsed = deskLoginBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "BAD_REQUEST" }, 400);
    }
    const creds = loadDeskCredentials();
    const actor = authenticateDeskLogin(
      parsed.data.id.trim(),
      parsed.data.password,
      creds,
    );
    if (!actor) {
      return c.json({ error: "Invalid id or password", code: "UNAUTHORIZED" }, 401);
    }
    const token = mintDeskToken(actor, creds.password);
    return c.json({
      token,
      actorId: actor.actorId,
      role: actor.role,
      expiresInHours: 12,
    });
  });

  app.get("/v1/desk/me", requireDeskAgent, (c) => {
    const agent = c.get("deskAgent")!;
    return c.json({
      agentId: agent.id,
      displayName: agent.displayName,
      role: agent.role,
      roles: ["desk", agent.role],
    });
  });

  app.get("/v1/desk/queue", requireDeskAgent, async (c) => {
    const queue = await listDeskQueue(db, { limit: 50 });
    return c.json({
      items: queue.map((item) => ({
        conversationId: item.case.id,
        ownership: item.case.ownership,
        status: item.case.status,
        customerId: item.case.customerId,
        priority: item.case.priority,
        waitingFor: item.waitingFor,
        updatedAt: item.case.updatedAt.toISOString(),
        latestCustomerText: item.latestCustomerText,
        escalationSummary: item.escalationSummary,
        recommendation: item.recommendation,
        ticketId: item.ticketId,
        ticketStatus: item.ticketStatus,
        parkedAtWorkflowName: item.parkedAtWorkflowName,
        parkedAtWorkflowLevel: item.parkedAtWorkflowLevel,
        currentWorkflowLevel: item.currentWorkflowLevel,
        promotionHint: item.promotionHint,
      })),
    });
  });

  app.get("/v1/desk/approvals", requireDesk, async (c) => {
    const items = await listPendingApprovals(db, 50);
    return c.json({
      items: items.map((item) => ({
        caseId: item.caseId,
        customerId: item.customerId,
        ownership: item.ownership,
        updatedAt: item.updatedAt.toISOString(),
        stepId: item.stepId,
        tool: item.tool,
        intentId: item.intentId,
        args: item.args,
        intentState: item.intentState,
        requestedAt: item.requestedAt.toISOString(),
        customerMessage: item.customerMessage,
        parkedAtWorkflowName: item.parkedAtWorkflowName,
        parkedAtWorkflowLevel: item.parkedAtWorkflowLevel,
        currentWorkflowLevel: item.currentWorkflowLevel,
        promotionHint: item.promotionHint,
      })),
    });
  });

  app.get("/v1/desk/cases/:caseId", requireDeskAgent, async (c) => {
    const caseId = c.req.param("caseId");
    try {
      const caseRow = await getCaseForDesk(db, { caseId });
      const events = await listCaseEvents(db, {
        caseId,
        limit: 200,
        audience: ["customer", "desk"],
      });
      return c.json({
        conversationId: caseRow.id,
        status: caseRow.status,
        ownership: caseRow.ownership,
        customerId: caseRow.customerId,
        priority: caseRow.priority,
        runnable: caseRow.runnable,
        lastEventSeq: Number(caseRow.lastEventSeq),
        events: serializeEvents(events),
      });
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.post("/v1/desk/cases/:caseId/commands", requireDesk, async (c) => {
    const desk = c.get("desk")!;
    const caseId = c.req.param("caseId");
    const parsed = deskCommandBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "BAD_REQUEST" }, 400);
    }

    try {
      const result = await applyDeskCommand(db, {
        caseId,
        commandId: parsed.data.commandId,
        type: parsed.data.type,
        stepId: parsed.data.stepId,
        note: parsed.data.note,
        actor: desk,
        executeWrite: async (write) => {
          const outcome = await tools.invoke({
            caseId: write.caseId,
            stepId: write.stepId,
            tool: write.tool,
            args: write.args,
            customerId: write.customerId,
            executeApproved: true,
            approvedBy: write.approvedBy,
          });
          return outcome;
        },
      });
      return c.json(
        {
          conversationId: result.case.id,
          ownership: result.case.ownership,
          runnable: result.case.runnable,
          status: result.created ? "accepted" : "duplicate",
          seq: Number(result.event.seq),
          execution: result.execution ?? null,
        },
        result.created ? 201 : 200,
      );
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.post("/v1/desk/cases/:caseId/approve", requireDeskAgent, async (c) => {
    const agent = c.get("deskAgent")!;
    if (agent.role !== "approver" && agent.role !== "admin") {
      return c.json({ error: "Approver role required", code: "FORBIDDEN" }, 403);
    }
    const caseId = c.req.param("caseId");
    const parsed = deskCommandBody
      .pick({ commandId: true, stepId: true, note: true })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || !parsed.data.stepId) {
      return c.json(
        { error: "commandId and stepId required", code: "BAD_REQUEST" },
        400,
      );
    }
    try {
      const result = await applyDeskCommand(db, {
        caseId,
        commandId: parsed.data.commandId,
        type: "approve",
        stepId: parsed.data.stepId,
        note: parsed.data.note,
        actor: { actorId: agent.id, role: agent.role },
        executeWrite: async (write) => {
          const outcome = await tools.invoke({
            caseId: write.caseId,
            stepId: write.stepId,
            tool: write.tool,
            args: write.args,
            customerId: write.customerId,
            executeApproved: true,
            approvedBy: write.approvedBy,
          });
          return outcome;
        },
      });
      return c.json(
        {
          conversationId: result.case.id,
          ownership: result.case.ownership,
          runnable: result.case.runnable,
          status: result.created ? "approved" : "duplicate",
          seq: Number(result.event.seq),
          execution: result.execution ?? null,
        },
        result.created ? 201 : 200,
      );
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.post("/v1/desk/cases/:caseId/reject", requireDeskAgent, async (c) => {
    const agent = c.get("deskAgent")!;
    if (agent.role !== "approver" && agent.role !== "admin") {
      return c.json({ error: "Approver role required", code: "FORBIDDEN" }, 403);
    }
    const caseId = c.req.param("caseId");
    const parsed = deskCommandBody
      .pick({ commandId: true, stepId: true, note: true })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || !parsed.data.stepId) {
      return c.json(
        { error: "commandId and stepId required", code: "BAD_REQUEST" },
        400,
      );
    }
    try {
      const result = await applyDeskCommand(db, {
        caseId,
        commandId: parsed.data.commandId,
        type: "reject",
        stepId: parsed.data.stepId,
        note: parsed.data.note ?? "Rejected from desk",
        actor: { actorId: agent.id, role: agent.role },
      });
      return c.json(
        {
          conversationId: result.case.id,
          ownership: result.case.ownership,
          runnable: result.case.runnable,
          status: result.created ? "rejected" : "duplicate",
          seq: Number(result.event.seq),
        },
        result.created ? 201 : 200,
      );
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.post("/v1/desk/cases/:caseId/takeover", requireDeskAgent, async (c) => {
    const agent = c.get("deskAgent")!;
    const caseId = c.req.param("caseId");
    const parsed = deskTakeoverBody.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "BAD_REQUEST" }, 400);
    }
    try {
      const result = await takeoverCase(db, {
        caseId,
        agentId: agent.id,
        commandId: parsed.data.commandId,
        note: parsed.data.note,
      });
      return c.json(
        {
          conversationId: result.case.id,
          ownership: result.case.ownership,
          status: result.created ? "taken_over" : "duplicate",
          lastEventSeq: Number(result.case.lastEventSeq),
          ticketId: result.ticket?.complaintId ?? null,
          ticketStatus: result.ticket?.status ?? null,
        },
        result.created ? 201 : 200,
      );
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.post("/v1/desk/cases/:caseId/hand-back", requireDeskAgent, async (c) => {
    const agent = c.get("deskAgent")!;
    const caseId = c.req.param("caseId");
    const parsed = deskHandBackBody.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "BAD_REQUEST" }, 400);
    }
    try {
      const result = await handBackCase(db, {
        caseId,
        agentId: agent.id,
        commandId: parsed.data.commandId,
        note: parsed.data.note,
        instruction: parsed.data.instruction,
      });
      return c.json(
        {
          conversationId: result.case.id,
          ownership: result.case.ownership,
          status: result.created ? "handed_back" : "duplicate",
          lastEventSeq: Number(result.case.lastEventSeq),
        },
        result.created ? 201 : 200,
      );
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.post("/v1/desk/cases/:caseId/messages", requireDeskAgent, async (c) => {
    const agent = c.get("deskAgent")!;
    const caseId = c.req.param("caseId");
    const parsed = deskMessageBody.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "BAD_REQUEST" }, 400);
    }
    try {
      const result = await appendHumanMessage(db, {
        caseId,
        agentId: agent.id,
        message: parsed.data.message,
        commandId: parsed.data.commandId,
      });
      return c.json(
        {
          conversationId: result.case.id,
          ownership: result.case.ownership,
          status: result.created ? "accepted" : "duplicate",
          seq: Number(result.events[0]?.seq ?? result.case.lastEventSeq),
        },
        result.created ? 201 : 200,
      );
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.get("/v1/workflows", requireCustomerOrDesk, async (c) => {
    const items = await listWorkflowStatuses(db);
    return c.json({ items: items.map(workflowJson) });
  });

  app.get("/v1/workflows/default", requireCustomerOrDesk, async (c) => {
    const status = await getWorkflowStatus(db);
    return c.json(workflowJson(status));
  });

  app.get("/v1/workflows/:name", requireCustomerOrDesk, async (c) => {
    const name = c.req.param("name")?.trim();
    if (!name || name.length > 64) {
      return c.json({ error: "Invalid workflow name", code: "BAD_REQUEST" }, 400);
    }
    try {
      const status = await getWorkflowStatus(db, name);
      return c.json(workflowJson(status));
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.post("/v1/workflows/:name/promote", requireAnyDesk, async (c) => {
    const name = c.req.param("name")?.trim();
    if (!name || name.length > 64) {
      return c.json({ error: "Invalid workflow name", code: "BAD_REQUEST" }, 400);
    }
    const parsed = promoteBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "BAD_REQUEST" }, 400);
    }
    try {
      const status =
        parsed.data.level !== undefined
          ? await setWorkflowLevel(db, parsed.data.level as WorkflowLevel, name)
          : await forcePromoteWorkflow(db, name);
      return c.json(workflowJson(status));
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  app.get("/v1/demo/clock", requireDesk, async (c) => {
    const now = await getVirtualNow(db);
    return c.json({ nowAt: now.toISOString() });
  });

  app.post("/v1/demo/clock", requireDesk, async (c) => {
    const desk = c.get("desk")!;
    if (desk.role !== "approver" && desk.role !== "admin") {
      return c.json({ error: "Approver role required", code: "FORBIDDEN" }, 403);
    }
    const parsed = clockBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid body", code: "BAD_REQUEST" }, 400);
    }
    try {
      const nowAt =
        parsed.data.setTo !== undefined
          ? await setVirtualClock(db, new Date(parsed.data.setTo))
          : await advanceVirtualClock(db, parsed.data.advanceByMs!);
      return c.json({ nowAt: nowAt.toISOString() });
    } catch (error) {
      const mapped = mapCoreError(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  return app;
}
