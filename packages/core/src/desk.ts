import type { Db, DbClient } from "./db.js";
import { withTransaction } from "./db.js";
import { notifyCaseEvent } from "./notify.js";
import {
  CoreError,
  type Audience,
  type CaseEventRow,
  type CaseRow,
  type OwnershipState,
} from "./types.js";

type CaseDbRow = {
  id: string;
  status: string;
  ownership: OwnershipState;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  epoch: string;
  wake_at: Date | null;
  priority: number;
  customer_id: string;
  last_event_seq: string;
  runnable: boolean;
  created_at: Date;
  updated_at: Date;
};

type EventDbRow = {
  id: string;
  case_id: string;
  seq: string;
  type: string;
  audience: Audience;
  payload: Record<string, unknown>;
  created_at: Date;
};

type IntentDbRow = {
  id: string;
  case_id: string;
  step_id: string;
  tool: string;
  idempotency_key: string;
  state: string;
  args: Record<string, unknown>;
  result: unknown;
};

function mapCase(row: CaseDbRow): CaseRow {
  return {
    id: row.id,
    status: row.status,
    ownership: row.ownership,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    epoch: row.epoch,
    wakeAt: row.wake_at,
    priority: row.priority,
    customerId: row.customer_id,
    lastEventSeq: row.last_event_seq,
    runnable: row.runnable,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventDbRow): CaseEventRow {
  return {
    id: String(row.id),
    caseId: row.case_id,
    seq: row.seq,
    type: row.type,
    audience: row.audience,
    payload: row.payload ?? {},
    createdAt: row.created_at,
  };
}

async function appendEvent(
  client: DbClient,
  input: {
    caseId: string;
    type: string;
    audience: Audience;
    payload: Record<string, unknown>;
    ownership?: OwnershipState;
    runnable?: boolean;
    clearLease?: boolean;
    bumpEpoch?: boolean;
  },
): Promise<{ case: CaseRow; event: CaseEventRow }> {
  const caseResult = await client.query<CaseDbRow>(
    `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
    [input.caseId],
  );
  const caseRow = caseResult.rows[0];
  if (!caseRow) {
    throw new CoreError("Case not found", "NOT_FOUND");
  }

  const nextSeq = Number(caseRow.last_event_seq) + 1;
  const eventResult = await client.query<EventDbRow>(
    `INSERT INTO case_events (case_id, seq, type, audience, payload)
     VALUES ($1, $2, $3, $4::event_audience, $5::jsonb)
     RETURNING id, case_id, seq, type, audience, payload, created_at`,
    [
      input.caseId,
      nextSeq,
      input.type,
      input.audience,
      JSON.stringify(input.payload),
    ],
  );
  const eventRow = eventResult.rows[0];
  if (!eventRow) {
    throw new CoreError("Failed to append event", "CONFLICT");
  }

  const updated = await client.query<CaseDbRow>(
    `UPDATE cases
     SET last_event_seq = $2,
         ownership = COALESCE($3::ownership_state, ownership),
         runnable = COALESCE($4::boolean, runnable),
         lease_owner = CASE WHEN $5 THEN NULL ELSE lease_owner END,
         lease_expires_at = CASE WHEN $5 THEN NULL ELSE lease_expires_at END,
         epoch = CASE WHEN $6 THEN epoch + 1 ELSE epoch END,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      input.caseId,
      nextSeq,
      input.ownership ?? null,
      input.runnable === undefined ? null : input.runnable,
      Boolean(input.clearLease),
      Boolean(input.bumpEpoch),
    ],
  );
  const updatedCase = updated.rows[0];
  if (!updatedCase) {
    throw new CoreError("Failed to update case", "CONFLICT");
  }

  await notifyCaseEvent(client, { caseId: input.caseId, seq: nextSeq });
  return { case: mapCase(updatedCase), event: mapEvent(eventRow) };
}

async function findCommandEvent(
  client: DbClient,
  caseId: string,
  commandId: string,
): Promise<CaseEventRow | null> {
  const result = await client.query<EventDbRow>(
    `SELECT id, case_id, seq, type, audience, payload, created_at
     FROM case_events
     WHERE case_id = $1
       AND payload->>'commandId' = $2
     ORDER BY seq ASC
     LIMIT 1`,
    [caseId, commandId],
  );
  const row = result.rows[0];
  return row ? mapEvent(row) : null;
}

export type DeskCommandType =
  | "approve"
  | "reject"
  | "takeover"
  | "hand_back";

export type DeskActor = {
  actorId: string;
  role: "agent" | "approver" | "admin";
};

export type ApplyDeskCommandInput = {
  caseId: string;
  commandId: string;
  type: DeskCommandType;
  actor: DeskActor;
  stepId?: string;
  note?: string;
  executeWrite?: (input: {
    caseId: string;
    stepId: string;
    tool: string;
    args: Record<string, unknown>;
    customerId: string;
    approvedBy: string;
  }) => Promise<{
    state: string;
    data?: unknown;
    errorCode?: string;
    message?: string;
  }>;
};

export type ApplyDeskCommandResult = {
  case: CaseRow;
  event: CaseEventRow;
  created: boolean;
  execution?: {
    state: string;
    data?: unknown;
    errorCode?: string;
    message?: string;
  };
};

function assertCanApprove(actor: DeskActor): void {
  if (actor.role !== "approver" && actor.role !== "admin") {
    throw new CoreError("Approver role required", "FORBIDDEN");
  }
}

function assertCanAgent(actor: DeskActor): void {
  if (
    actor.role !== "agent" &&
    actor.role !== "approver" &&
    actor.role !== "admin"
  ) {
    throw new CoreError("Desk role required", "FORBIDDEN");
  }
}

export async function requestWriteApproval(
  db: Db,
  input: {
    caseId: string;
    stepId: string;
    tool: string;
    intentId?: string;
    message?: string;
  },
): Promise<{ case: CaseRow; deskEvent: CaseEventRow; statusEvent: CaseEventRow }> {
  return withTransaction(db, async (client) => {
    const desk = await appendEvent(client, {
      caseId: input.caseId,
      type: "approval_requested",
      audience: "desk",
      payload: {
        stepId: input.stepId,
        tool: input.tool,
        intentId: input.intentId ?? null,
      },
      ownership: "PENDING_APPROVAL",
      runnable: false,
      clearLease: true,
    });

    const status = await appendEvent(client, {
      caseId: input.caseId,
      type: "status",
      audience: "customer",
      payload: {
        text:
          input.message ??
          "A support action is waiting for approval before it can continue.",
        pendingApproval: true,
        stepId: input.stepId,
        tool: input.tool,
      },
      ownership: "PENDING_APPROVAL",
      runnable: false,
      clearLease: true,
    });

    return {
      case: status.case,
      deskEvent: desk.event,
      statusEvent: status.event,
    };
  });
}

export async function applyDeskCommand(
  db: Db,
  input: ApplyDeskCommandInput,
): Promise<ApplyDeskCommandResult> {
  const existing = await db.query<EventDbRow>(
    `SELECT id, case_id, seq, type, audience, payload, created_at
     FROM case_events
     WHERE case_id = $1
       AND payload->>'commandId' = $2
     ORDER BY seq ASC
     LIMIT 1`,
    [input.caseId, input.commandId],
  );
  if (existing.rows[0]) {
    const caseRow = await db.query<CaseDbRow>(
      `SELECT * FROM cases WHERE id = $1`,
      [input.caseId],
    );
    const row = caseRow.rows[0];
    if (!row) throw new CoreError("Case not found", "NOT_FOUND");
    return {
      case: mapCase(row),
      event: mapEvent(existing.rows[0]),
      created: false,
    };
  }

  if (input.type === "approve" || input.type === "reject") {
    assertCanApprove(input.actor);
  } else {
    assertCanAgent(input.actor);
  }

  if (input.type === "takeover" || input.type === "hand_back") {
    return withTransaction(db, async (client) => {
      const duplicate = await findCommandEvent(client, input.caseId, input.commandId);
      if (duplicate) {
        const caseRow = await client.query<CaseDbRow>(
          `SELECT * FROM cases WHERE id = $1`,
          [input.caseId],
        );
        return {
          case: mapCase(caseRow.rows[0]!),
          event: duplicate,
          created: false,
        };
      }

      const appended = await appendEvent(client, {
        caseId: input.caseId,
        type: input.type === "takeover" ? "takeover" : "hand_back",
        audience: "desk",
        payload: {
          commandId: input.commandId,
          actorId: input.actor.actorId,
          role: input.actor.role,
          note: input.note ?? null,
        },
        ownership: input.type === "takeover" ? "HUMAN_OWNED" : "AI_ACTIVE",
        runnable: input.type === "hand_back",
        clearLease: true,
        bumpEpoch: true,
      });
      return { case: appended.case, event: appended.event, created: true };
    });
  }

  if (!input.stepId) {
    throw new CoreError("stepId is required for approve/reject", "BAD_REQUEST");
  }

  const intentResult = await db.query<IntentDbRow>(
    `SELECT id, case_id, step_id, tool, idempotency_key, state, args, result
     FROM action_intents
     WHERE case_id = $1 AND step_id = $2
     LIMIT 1`,
    [input.caseId, input.stepId],
  );
  const intent = intentResult.rows[0];
  if (!intent) {
    throw new CoreError("Pending intent not found", "NOT_FOUND");
  }

  const caseLookup = await db.query<CaseDbRow>(
    `SELECT * FROM cases WHERE id = $1`,
    [input.caseId],
  );
  const caseRow = caseLookup.rows[0];
  if (!caseRow) {
    throw new CoreError("Case not found", "NOT_FOUND");
  }

  if (input.type === "reject") {
    return withTransaction(db, async (client) => {
      const duplicate = await findCommandEvent(client, input.caseId, input.commandId);
      if (duplicate) {
        return {
          case: mapCase(caseRow),
          event: duplicate,
          created: false,
        };
      }

      await client.query(
        `UPDATE action_intents
         SET state = 'failed',
             result = $2::jsonb,
             updated_at = now()
         WHERE id = $1`,
        [
          intent.id,
          JSON.stringify({
            state: "failed",
            errorCode: "REJECTED",
            message: input.note ?? "Rejected by approver",
          }),
        ],
      );

      const appended = await appendEvent(client, {
        caseId: input.caseId,
        type: "approval_rejected",
        audience: "desk",
        payload: {
          commandId: input.commandId,
          actorId: input.actor.actorId,
          stepId: input.stepId,
          tool: intent.tool,
          note: input.note ?? null,
        },
        ownership: "AI_ACTIVE",
        runnable: true,
        clearLease: true,
      });

      await appendEvent(client, {
        caseId: input.caseId,
        type: "status",
        audience: "customer",
        payload: {
          text: "The pending support action was not approved.",
          pendingApproval: false,
        },
        ownership: "AI_ACTIVE",
        runnable: true,
      });

      return { case: appended.case, event: appended.event, created: true };
    });
  }

  if (!input.executeWrite) {
    throw new CoreError("executeWrite is required for approve", "BAD_REQUEST");
  }

  const execution = await input.executeWrite({
    caseId: input.caseId,
    stepId: intent.step_id,
    tool: intent.tool,
    args: intent.args,
    customerId: caseRow.customer_id,
    approvedBy: input.actor.actorId,
  });

  return withTransaction(db, async (client) => {
    const duplicate = await findCommandEvent(client, input.caseId, input.commandId);
    if (duplicate) {
      return {
        case: mapCase(caseRow),
        event: duplicate,
        created: false,
        execution,
      };
    }

    const appended = await appendEvent(client, {
      caseId: input.caseId,
      type: "approval_granted",
      audience: "desk",
      payload: {
        commandId: input.commandId,
        actorId: input.actor.actorId,
        stepId: input.stepId,
        tool: intent.tool,
        executionState: execution.state,
        note: input.note ?? null,
      },
      ownership: "AI_ACTIVE",
      runnable: true,
      clearLease: true,
    });

    await appendEvent(client, {
      caseId: input.caseId,
      type: "status",
      audience: "customer",
      payload: {
        text:
          execution.state === "confirmed"
            ? "Your request was approved and completed."
            : "Your request was approved but the action did not finish cleanly.",
        pendingApproval: false,
        executionState: execution.state,
        data: execution.data ?? null,
      },
      ownership: "AI_ACTIVE",
      runnable: true,
    });

    return {
      case: appended.case,
      event: appended.event,
      created: true,
      execution,
    };
  });
}

export async function listCaseEventsAfter(
  db: Db,
  input: {
    caseId: string;
    afterSeq: number;
    audience?: Audience | Audience[];
    limit?: number;
  },
): Promise<CaseEventRow[]> {
  const limit = input.limit ?? 200;
  const audiences = input.audience
    ? Array.isArray(input.audience)
      ? input.audience
      : [input.audience]
    : null;

  const result = audiences
    ? await db.query<EventDbRow>(
        `SELECT id, case_id, seq, type, audience, payload, created_at
         FROM case_events
         WHERE case_id = $1
           AND seq > $2
           AND audience = ANY($3::event_audience[])
         ORDER BY seq ASC
         LIMIT $4`,
        [input.caseId, input.afterSeq, audiences, limit],
      )
    : await db.query<EventDbRow>(
        `SELECT id, case_id, seq, type, audience, payload, created_at
         FROM case_events
         WHERE case_id = $1
           AND seq > $2
         ORDER BY seq ASC
         LIMIT $3`,
        [input.caseId, input.afterSeq, limit],
      );

  return result.rows.map(mapEvent);
}

export async function getCaseById(db: Db, caseId: string): Promise<CaseRow> {
  const result = await db.query<CaseDbRow>(
    `SELECT * FROM cases WHERE id = $1`,
    [caseId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError("Case not found", "NOT_FOUND");
  }
  return mapCase(row);
}
