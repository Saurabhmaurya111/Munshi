import type { Db, DbClient } from "./db.js";
import { withTransaction } from "./db.js";
import { notifyCaseEvent } from "./notify.js";
import {
  getCaseTicket,
  raiseHandoffTicket,
  type HandoffTicket,
} from "./tickets.js";
import {
  CoreError,
  type Audience,
  type CaseEventRow,
  type CaseRow,
  type OwnershipState,
} from "./types.js";
import { getWorkflowStatus } from "./workflows.js";

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

export type DeskAgent = {
  id: string;
  displayName: string;
  role: "agent" | "approver" | "admin";
};

/** Local mock Desk agents until real auth ships. */
export const DESK_AGENTS: DeskAgent[] = [
  { id: "desk-priya", displayName: "Priya", role: "agent" },
  { id: "desk-rahul", displayName: "Rahul", role: "approver" },
  { id: "desk-admin", displayName: "Admin", role: "admin" },
];

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

export function getDeskAgent(agentId: string): DeskAgent {
  const agent = DESK_AGENTS.find((row) => row.id === agentId);
  if (!agent) {
    throw new CoreError("Unknown desk agent", "NOT_FOUND");
  }
  return agent;
}

async function findEventByCommandId(
  client: DbClient,
  caseId: string,
  type: string,
  commandId: string,
): Promise<CaseEventRow | null> {
  const result = await client.query<EventDbRow>(
    `SELECT id, case_id, seq, type, audience, payload, created_at
     FROM case_events
     WHERE case_id = $1
       AND type = $2
       AND payload->>'commandId' = $3
     LIMIT 1`,
    [caseId, type, commandId],
  );
  const row = result.rows[0];
  return row ? mapEvent(row) : null;
}

async function appendEvent(
  client: DbClient,
  input: {
    caseId: string;
    nextSeq: number;
    type: string;
    audience: Audience;
    payload: Record<string, unknown>;
  },
): Promise<CaseEventRow> {
  const eventResult = await client.query<EventDbRow>(
    `INSERT INTO case_events (case_id, seq, type, audience, payload)
     VALUES ($1, $2, $3, $4::event_audience, $5::jsonb)
     RETURNING id, case_id, seq, type, audience, payload, created_at`,
    [
      input.caseId,
      input.nextSeq,
      input.type,
      input.audience,
      JSON.stringify(input.payload),
    ],
  );
  const eventRow = eventResult.rows[0];
  if (!eventRow) {
    throw new CoreError("Failed to append event", "CONFLICT");
  }
  return mapEvent(eventRow);
}

export type DeskQueueItem = {
  case: CaseRow;
  waitingFor: "human" | "approval";
  latestCustomerText: string | null;
  escalationSummary: string | null;
  recommendation: string | null;
  ticketId: string | null;
  ticketStatus: string | null;
  /** Level/name snapshotted when the hold was created — promote does not rewrite this. */
  parkedAtWorkflowName: string | null;
  parkedAtWorkflowLevel: 0 | 1 | 2 | null;
  /** Live workflow level at queue-read time (may be higher after a mid-flight promote). */
  currentWorkflowLevel: 0 | 1 | 2 | null;
  /** Human-readable note: parked level vs current; never implies auto-execute. */
  promotionHint: string | null;
};

export function buildPromotionHint(input: {
  parkedLevel: 0 | 1 | 2 | null;
  currentLevel: 0 | 1 | 2 | null;
  workflowName?: string | null;
}): string | null {
  if (input.parkedLevel === null || input.currentLevel === null) return null;
  if (input.parkedLevel === input.currentLevel) {
    return `Parked at L${input.parkedLevel}; still needs an explicit desk decision.`;
  }
  const name = input.workflowName?.trim() || "workflow";
  if (input.currentLevel > input.parkedLevel) {
    return `Parked at L${input.parkedLevel}; ${name} is now L${input.currentLevel} — still needs explicit approve (no auto-run).`;
  }
  return `Parked at L${input.parkedLevel}; ${name} is now L${input.currentLevel}.`;
}

function asWorkflowLevel(value: unknown): 0 | 1 | 2 | null {
  const n = Number(value);
  if (n === 0 || n === 1 || n === 2) return n;
  return null;
}

function noticeWithTicket(base: string, ticketId: string): string {
  const trimmed = base.trim();
  if (trimmed.includes(ticketId)) return trimmed;
  return `${trimmed} Your ticket ID is ${ticketId}.`;
}

/**
 * Cases waiting on a human: HUMAN_OWNED queue and PENDING_APPROVAL holds.
 */
export async function listDeskQueue(
  db: Db,
  input?: { limit?: number },
): Promise<DeskQueueItem[]> {
  const limit = input?.limit ?? 50;
  const result = await db.query<CaseDbRow>(
    `SELECT *
     FROM cases
     WHERE ownership IN ('HUMAN_OWNED', 'PENDING_APPROVAL')
       AND status <> 'closed'
     ORDER BY priority DESC, updated_at ASC
     LIMIT $1`,
    [limit],
  );

  const items: DeskQueueItem[] = [];
  for (const row of result.rows) {
    const caseRow = mapCase(row);
    const events = await db.query<EventDbRow>(
      `SELECT id, case_id, seq, type, audience, payload, created_at
       FROM case_events
       WHERE case_id = $1
       ORDER BY seq DESC
       LIMIT 40`,
      [caseRow.id],
    );

    let latestCustomerText: string | null = null;
    let escalationSummary: string | null = null;
    let recommendation: string | null = null;
    let ticketId: string | null = null;
    let parkedAtWorkflowName: string | null = null;
    let parkedAtWorkflowLevel: 0 | 1 | 2 | null = null;

    for (const event of events.rows) {
      if (
        !latestCustomerText &&
        event.type === "customer_message" &&
        typeof event.payload?.text === "string"
      ) {
        latestCustomerText = event.payload.text;
      }
      if (
        !escalationSummary &&
        event.type === "escalation_summary" &&
        typeof event.payload?.summary === "string"
      ) {
        escalationSummary = event.payload.summary;
        recommendation =
          typeof event.payload.recommendation === "string"
            ? event.payload.recommendation
            : null;
        if (typeof event.payload.ticketId === "string") {
          ticketId = event.payload.ticketId;
        }
        if (parkedAtWorkflowLevel === null) {
          parkedAtWorkflowLevel = asWorkflowLevel(event.payload.workflowLevel);
          if (typeof event.payload.workflowName === "string") {
            parkedAtWorkflowName = event.payload.workflowName;
          }
        }
      }
      if (
        parkedAtWorkflowLevel === null &&
        (event.type === "approval_requested" ||
          (event.type === "assistant_message" &&
            event.payload?.pendingApproval === true) ||
          (event.type === "status" && event.payload?.pendingApproval === true))
      ) {
        parkedAtWorkflowLevel = asWorkflowLevel(event.payload?.workflowLevel);
        if (typeof event.payload?.workflowName === "string") {
          parkedAtWorkflowName = event.payload.workflowName;
        }
      }
      if (
        !ticketId &&
        typeof event.payload?.ticketId === "string" &&
        (event.type === "human_transfer" ||
          event.type === "ticket_raised" ||
          event.type === "human_takeover")
      ) {
        ticketId = event.payload.ticketId;
      }
      if (
        latestCustomerText &&
        escalationSummary &&
        ticketId &&
        (caseRow.ownership !== "PENDING_APPROVAL" ||
          parkedAtWorkflowLevel !== null)
      ) {
        break;
      }
    }

    const ticket = await getCaseTicket(db, {
      caseId: caseRow.id,
      customerId: caseRow.customerId,
    });

    let currentWorkflowLevel: 0 | 1 | 2 | null = null;
    let promotionHint: string | null = null;
    if (caseRow.ownership === "PENDING_APPROVAL") {
      const live = await getWorkflowStatus(
        db,
        parkedAtWorkflowName ?? "default",
      );
      currentWorkflowLevel = live.level;
      promotionHint = buildPromotionHint({
        parkedLevel: parkedAtWorkflowLevel,
        currentLevel: currentWorkflowLevel,
        workflowName: parkedAtWorkflowName ?? live.name,
      });
    }

    items.push({
      case: caseRow,
      waitingFor:
        caseRow.ownership === "PENDING_APPROVAL" ? "approval" : "human",
      latestCustomerText,
      escalationSummary,
      recommendation,
      ticketId: ticket?.complaintId ?? ticketId,
      ticketStatus: ticket?.status ?? null,
      parkedAtWorkflowName,
      parkedAtWorkflowLevel,
      currentWorkflowLevel,
      promotionHint,
    });
  }

  return items;
}

export type TransferResult = {
  case: CaseRow;
  events: CaseEventRow[];
  created: boolean;
  ticket?: HandoffTicket;
};

/**
 * Worker-held transfer: set ownership to human / pending approval, publish
 * desk summary + customer notice, release lease. Uses the fencing epoch.
 */
export async function transferCaseToHumanWithEpoch(
  db: Db,
  input: {
    caseId: string;
    heldEpoch: string;
    reason: string;
    summary: string;
    recommendation: string;
    neededFromHuman: string;
    ownership?: "HUMAN_OWNED" | "PENDING_APPROVAL";
    customerNotice?: string;
    includeCustomerNotice?: boolean;
    source?: "ai_escalate" | "customer_request" | "desk_takeover";
    /** Snapshotted when the hold is created — mid-flight promote must not rewrite. */
    workflowName?: string;
    workflowLevel?: 0 | 1 | 2;
  },
): Promise<TransferResult> {
  const ownership = input.ownership ?? "HUMAN_OWNED";
  const includeCustomerNotice = input.includeCustomerNotice ?? true;
  const customerNotice =
    input.customerNotice ??
    (ownership === "PENDING_APPROVAL"
      ? "I’ve handed this to a support specialist for approval. They’ll continue from here."
      : "I’ve connected you with a support specialist who can help resolve this.");

  return withTransaction(db, async (client) => {
    const caseResult = await client.query<CaseDbRow>(
      `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
      [input.caseId],
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) {
      throw new CoreError("Case not found", "NOT_FOUND");
    }
    if (caseRow.epoch !== input.heldEpoch) {
      throw new CoreError("Epoch mismatch; lease lost", "CONFLICT");
    }

    if (
      caseRow.ownership === "HUMAN_OWNED" ||
      caseRow.ownership === "PENDING_APPROVAL"
    ) {
      const existingTicket = await getCaseTicket(client, {
        caseId: input.caseId,
        customerId: caseRow.customer_id,
      });
      return {
        case: mapCase(caseRow),
        events: [],
        created: false,
        ...(existingTicket ? { ticket: existingTicket } : {}),
      };
    }

    const ticket = await raiseHandoffTicket(client, {
      caseId: input.caseId,
      customerId: caseRow.customer_id,
      summary: input.summary,
      reason: input.reason,
      source: input.source ?? "ai_escalate",
    });

    const notice = noticeWithTicket(customerNotice, ticket.complaintId);
    let nextSeq = Number(caseRow.last_event_seq) + 1;
    const events: CaseEventRow[] = [];

    events.push(
      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "ticket_raised",
        audience: "desk",
        payload: {
          ticketId: ticket.complaintId,
          status: ticket.status,
          category: ticket.category,
          summary: ticket.summary,
          created: ticket.created,
          source: input.source ?? "ai_escalate",
        },
      }),
    );
    nextSeq += 1;

    events.push(
      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "escalation_summary",
        audience: "desk",
        payload: {
          reason: input.reason,
          summary: input.summary,
          recommendation: input.recommendation,
          neededFromHuman: input.neededFromHuman,
          ownership,
          source: input.source ?? "ai_escalate",
          ticketId: ticket.complaintId,
          ticketStatus: ticket.status,
          workflowName: input.workflowName ?? null,
          workflowLevel:
            input.workflowLevel === undefined ? null : input.workflowLevel,
        },
      }),
    );

    if (includeCustomerNotice) {
      nextSeq += 1;
      events.push(
        await appendEvent(client, {
          caseId: input.caseId,
          nextSeq,
          type: "human_transfer",
          audience: "customer",
          payload: {
            text: notice,
            ownership,
            reason: input.reason,
            ticketId: ticket.complaintId,
          },
        }),
      );
    }

    const updated = await client.query<CaseDbRow>(
      `UPDATE cases
       SET last_event_seq = $2,
           ownership = $3::ownership_state,
           runnable = false,
           lease_owner = NULL,
           lease_expires_at = NULL,
           wake_at = NULL,
           updated_at = now()
       WHERE id = $1 AND epoch = $4
       RETURNING *`,
      [input.caseId, nextSeq, ownership, input.heldEpoch],
    );
    const updatedCase = updated.rows[0];
    if (!updatedCase) {
      throw new CoreError("Epoch mismatch; lease lost", "CONFLICT");
    }

    return {
      case: mapCase(updatedCase),
      events,
      created: true,
      ticket,
    };
  });
}

/**
 * Desk takeover: bump epoch (kills in-flight AI), set HUMAN_OWNED.
 * Idempotent by commandId.
 */
export async function takeoverCase(
  db: Db,
  input: {
    caseId: string;
    agentId: string;
    commandId: string;
    note?: string;
  },
): Promise<TransferResult> {
  const agent = getDeskAgent(input.agentId);
  const commandId = input.commandId.trim();
  if (!commandId) {
    throw new CoreError("commandId is required", "BAD_REQUEST");
  }

  return withTransaction(db, async (client) => {
    const caseResult = await client.query<CaseDbRow>(
      `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
      [input.caseId],
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) {
      throw new CoreError("Case not found", "NOT_FOUND");
    }

    const existing = await findEventByCommandId(
      client,
      input.caseId,
      "human_takeover",
      commandId,
    );
    if (existing) {
      const existingTicket = await getCaseTicket(client, {
        caseId: input.caseId,
        customerId: caseRow.customer_id,
      });
      return {
        case: mapCase(caseRow),
        events: [existing],
        created: false,
        ...(existingTicket ? { ticket: existingTicket } : {}),
      };
    }

    const ticket = await raiseHandoffTicket(client, {
      caseId: input.caseId,
      customerId: caseRow.customer_id,
      summary:
        input.note?.trim() ||
        `Desk takeover by ${agent.displayName}`,
      reason: "desk_takeover",
      source: "desk_takeover",
    });

    let nextSeq = Number(caseRow.last_event_seq) + 1;
    const events: CaseEventRow[] = [];

    if (ticket.created) {
      events.push(
        await appendEvent(client, {
          caseId: input.caseId,
          nextSeq,
          type: "ticket_raised",
          audience: "desk",
          payload: {
            ticketId: ticket.complaintId,
            status: ticket.status,
            category: ticket.category,
            summary: ticket.summary,
            created: ticket.created,
            source: "desk_takeover",
          },
        }),
      );
      nextSeq += 1;
    }

    events.push(
      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "human_takeover",
        audience: "desk",
        payload: {
          commandId,
          agentId: agent.id,
          agentName: agent.displayName,
          note: input.note ?? null,
          ticketId: ticket.complaintId,
        },
      }),
    );
    nextSeq += 1;

    events.push(
      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "human_transfer",
        audience: "customer",
        payload: {
          text: noticeWithTicket(
            `${agent.displayName} from support has joined this conversation.`,
            ticket.complaintId,
          ),
          ownership: "HUMAN_OWNED",
          reason: "desk_takeover",
          agentId: agent.id,
          agentName: agent.displayName,
          ticketId: ticket.complaintId,
        },
      }),
    );

    const updated = await client.query<CaseDbRow>(
      `UPDATE cases
       SET last_event_seq = $2,
           ownership = 'HUMAN_OWNED'::ownership_state,
           epoch = epoch + 1,
           runnable = false,
           lease_owner = NULL,
           lease_expires_at = NULL,
           wake_at = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.caseId, nextSeq],
    );
    const updatedCase = updated.rows[0];
    if (!updatedCase) {
      throw new CoreError("Failed to takeover case", "CONFLICT");
    }

    return {
      case: mapCase(updatedCase),
      events,
      created: true,
      ticket,
    };
  });
}

/**
 * Customer-requested transfer to a human (idempotent by commandId).
 */
export async function requestHumanTransfer(
  db: Db,
  input: {
    caseId: string;
    customerId: string;
    commandId: string;
    reason?: string;
  },
): Promise<TransferResult> {
  const commandId = input.commandId.trim();
  if (!commandId) {
    throw new CoreError("commandId is required", "BAD_REQUEST");
  }

  return withTransaction(db, async (client) => {
    const caseResult = await client.query<CaseDbRow>(
      `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
      [input.caseId],
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) {
      throw new CoreError("Case not found", "NOT_FOUND");
    }
    if (caseRow.customer_id !== input.customerId) {
      throw new CoreError("Case not found", "NOT_FOUND");
    }

    const existing = await findEventByCommandId(
      client,
      input.caseId,
      "human_transfer_request",
      commandId,
    );
    if (existing) {
      return { case: mapCase(caseRow), events: [existing], created: false };
    }

    if (
      caseRow.ownership === "HUMAN_OWNED" ||
      caseRow.ownership === "PENDING_APPROVAL"
    ) {
      const existingTicket = await getCaseTicket(client, {
        caseId: input.caseId,
        customerId: caseRow.customer_id,
      });
      return {
        case: mapCase(caseRow),
        events: [],
        created: false,
        ...(existingTicket ? { ticket: existingTicket } : {}),
      };
    }

    const reason = input.reason?.trim() || "customer_requested";
    const ticket = await raiseHandoffTicket(client, {
      caseId: input.caseId,
      customerId: caseRow.customer_id,
      summary: "Customer asked to speak with a human support agent.",
      reason,
      source: "customer_request",
    });

    let nextSeq = Number(caseRow.last_event_seq) + 1;
    const events: CaseEventRow[] = [];

    events.push(
      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "human_transfer_request",
        audience: "desk",
        payload: {
          commandId,
          reason,
          customerId: input.customerId,
          ticketId: ticket.complaintId,
        },
      }),
    );
    nextSeq += 1;

    events.push(
      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "ticket_raised",
        audience: "desk",
        payload: {
          ticketId: ticket.complaintId,
          status: ticket.status,
          category: ticket.category,
          summary: ticket.summary,
          created: ticket.created,
          source: "customer_request",
        },
      }),
    );
    nextSeq += 1;

    events.push(
      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "escalation_summary",
        audience: "desk",
        payload: {
          reason,
          summary: "Customer asked to speak with a human support agent.",
          recommendation:
            "Take over the case and continue helping the customer.",
          neededFromHuman:
            "Join the conversation and resolve the customer's request.",
          ownership: "HUMAN_OWNED",
          source: "customer_request",
          ticketId: ticket.complaintId,
          ticketStatus: ticket.status,
        },
      }),
    );
    nextSeq += 1;

    events.push(
      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "human_transfer",
        audience: "customer",
        payload: {
          text: noticeWithTicket(
            "I’ve connected you with a support specialist. Stay on this chat — they’ll reply here shortly.",
            ticket.complaintId,
          ),
          ownership: "HUMAN_OWNED",
          reason,
          ticketId: ticket.complaintId,
        },
      }),
    );

    const updated = await client.query<CaseDbRow>(
      `UPDATE cases
       SET last_event_seq = $2,
           ownership = 'HUMAN_OWNED'::ownership_state,
           epoch = epoch + 1,
           runnable = false,
           lease_owner = NULL,
           lease_expires_at = NULL,
           wake_at = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.caseId, nextSeq],
    );
    const updatedCase = updated.rows[0];
    if (!updatedCase) {
      throw new CoreError("Failed to transfer case", "CONFLICT");
    }

    return {
      case: mapCase(updatedCase),
      events,
      created: true,
      ticket,
    };
  });
}

/**
 * Hand the case back to Munshi with an instruction note.
 */
export async function handBackCase(
  db: Db,
  input: {
    caseId: string;
    agentId: string;
    commandId: string;
    note: string;
    instruction?: string;
  },
): Promise<TransferResult> {
  const agent = getDeskAgent(input.agentId);
  const commandId = input.commandId.trim();
  const note = input.note.trim();
  if (!commandId) {
    throw new CoreError("commandId is required", "BAD_REQUEST");
  }
  if (!note) {
    throw new CoreError("note is required", "BAD_REQUEST");
  }

  return withTransaction(db, async (client) => {
    const caseResult = await client.query<CaseDbRow>(
      `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
      [input.caseId],
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) {
      throw new CoreError("Case not found", "NOT_FOUND");
    }

    const existing = await findEventByCommandId(
      client,
      input.caseId,
      "human_handback",
      commandId,
    );
    if (existing) {
      return { case: mapCase(caseRow), events: [existing], created: false };
    }

    if (
      caseRow.ownership !== "HUMAN_OWNED" &&
      caseRow.ownership !== "PENDING_APPROVAL"
    ) {
      throw new CoreError("Case is not human-owned", "BAD_REQUEST");
    }

    let nextSeq = Number(caseRow.last_event_seq) + 1;
    const events: CaseEventRow[] = [];

    events.push(
      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "human_handback",
        audience: "desk",
        payload: {
          commandId,
          agentId: agent.id,
          agentName: agent.displayName,
          note,
          instruction: input.instruction?.trim() || null,
        },
      }),
    );
    nextSeq += 1;

    events.push(
      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "human_transfer",
        audience: "customer",
        payload: {
          text: "Your case is back with Munshi. I’ll continue from the specialist’s notes.",
          ownership: "AI_ACTIVE",
          reason: "hand_back",
        },
      }),
    );

    const updated = await client.query<CaseDbRow>(
      `UPDATE cases
       SET last_event_seq = $2,
           ownership = 'AI_ACTIVE'::ownership_state,
           epoch = epoch + 1,
           runnable = true,
           lease_owner = NULL,
           lease_expires_at = NULL,
           wake_at = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.caseId, nextSeq],
    );
    const updatedCase = updated.rows[0];
    if (!updatedCase) {
      throw new CoreError("Failed to hand back case", "CONFLICT");
    }

    return { case: mapCase(updatedCase), events, created: true };
  });
}

/**
 * Human agent reply visible to the customer.
 */
export async function appendHumanMessage(
  db: Db,
  input: {
    caseId: string;
    agentId: string;
    message: string;
    commandId: string;
  },
): Promise<TransferResult> {
  const agent = getDeskAgent(input.agentId);
  const message = input.message.trim();
  const commandId = input.commandId.trim();
  if (!message) {
    throw new CoreError("message is required", "BAD_REQUEST");
  }
  if (!commandId) {
    throw new CoreError("commandId is required", "BAD_REQUEST");
  }

  return withTransaction(db, async (client) => {
    const caseResult = await client.query<CaseDbRow>(
      `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
      [input.caseId],
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) {
      throw new CoreError("Case not found", "NOT_FOUND");
    }

    const existing = await findEventByCommandId(
      client,
      input.caseId,
      "human_message",
      commandId,
    );
    if (existing) {
      return { case: mapCase(caseRow), events: [existing], created: false };
    }

    if (caseRow.ownership !== "HUMAN_OWNED") {
      throw new CoreError(
        "Case must be human-owned before sending a desk reply",
        "BAD_REQUEST",
      );
    }

    const nextSeq = Number(caseRow.last_event_seq) + 1;
    const event = await appendEvent(client, {
      caseId: input.caseId,
      nextSeq,
      type: "human_message",
      audience: "customer",
      payload: {
        commandId,
        text: message,
        agentId: agent.id,
        agentName: agent.displayName,
      },
    });

    const updated = await client.query<CaseDbRow>(
      `UPDATE cases
       SET last_event_seq = $2,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.caseId, nextSeq],
    );
    const updatedCase = updated.rows[0];
    if (!updatedCase) {
      throw new CoreError("Failed to append human message", "CONFLICT");
    }

    return { case: mapCase(updatedCase), events: [event], created: true };
  });
}

export async function getCaseForDesk(
  db: Db,
  input: { caseId: string },
): Promise<CaseRow> {
  const result = await db.query<CaseDbRow>(
    `SELECT * FROM cases WHERE id = $1`,
    [input.caseId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError("Case not found", "NOT_FOUND");
  }
  return mapCase(row);
}

export async function getCaseById(db: Db, caseId: string): Promise<CaseRow> {
  return getCaseForDesk(db, { caseId });
}

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

async function updateCaseAfterEvents(
  client: DbClient,
  input: {
    caseId: string;
    lastEventSeq: number;
    ownership?: OwnershipState;
    runnable?: boolean;
    clearLease?: boolean;
    bumpEpoch?: boolean;
  },
): Promise<CaseRow> {
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
      input.lastEventSeq,
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
  await notifyCaseEvent(client, {
    caseId: input.caseId,
    seq: input.lastEventSeq,
  });
  return mapCase(updatedCase);
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

/**
 * Park a drafted customer reply behind desk approval (L0 reply policy).
 * Does not transfer ownership to a human specialist.
 */
export async function requestReplyApproval(
  db: Db,
  input: {
    caseId: string;
    stepId: string;
    draftReply: string;
    previewMessage?: string;
    workflowName?: string;
    workflowLevel?: 0 | 1 | 2;
  },
): Promise<{ case: CaseRow; deskEvent: CaseEventRow; statusEvent: CaseEventRow }> {
  const draftReply = input.draftReply.trim();
  if (!draftReply) {
    throw new CoreError("draftReply is required", "BAD_REQUEST");
  }

  const workflowName = input.workflowName ?? "default";
  const workflowLevel =
    input.workflowLevel === undefined ? null : input.workflowLevel;

  return withTransaction(db, async (client) => {
    const caseResult = await client.query<CaseDbRow>(
      `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
      [input.caseId],
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) {
      throw new CoreError("Case not found", "NOT_FOUND");
    }

    await client.query(
      `INSERT INTO action_intents (
         case_id, step_id, tool, idempotency_key, state, args, result
       ) VALUES (
         $1, $2, 'sendCustomerReply', $3, 'intended', $4::jsonb, NULL
       )
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        input.caseId,
        input.stepId,
        `${input.caseId}:${input.stepId}`,
        JSON.stringify({ text: draftReply }),
      ],
    );

    let nextSeq = Number(caseRow.last_event_seq) + 1;
    const deskEvent = await appendEvent(client, {
      caseId: input.caseId,
      nextSeq,
      type: "approval_requested",
      audience: "desk",
      payload: {
        stepId: input.stepId,
        tool: "sendCustomerReply",
        intentId: null,
        draftReply,
        workflowName,
        workflowLevel,
      },
    });
    nextSeq += 1;

    const statusEvent = await appendEvent(client, {
      caseId: input.caseId,
      nextSeq,
      type: "status",
      audience: "customer",
      payload: {
        text:
          input.previewMessage ??
          "I’ve prepared a reply. It’s waiting for desk approval before I send it.",
        pendingApproval: true,
        stepId: input.stepId,
        tool: "sendCustomerReply",
        workflowName,
        workflowLevel,
      },
    });

    const updatedCase = await updateCaseAfterEvents(client, {
      caseId: input.caseId,
      lastEventSeq: nextSeq,
      ownership: "PENDING_APPROVAL",
      runnable: false,
      clearLease: true,
    });

    return { case: updatedCase, deskEvent, statusEvent };
  });
}

/**
 * Park a write behind desk approval and notify the customer (pendingApproval).
 */
export async function requestWriteApproval(
  db: Db,
  input: {
    caseId: string;
    stepId: string;
    tool: string;
    intentId?: string;
    message?: string;
    /** Snapshotted when parked — mid-flight promote must not rewrite or auto-run. */
    workflowName?: string;
    workflowLevel?: 0 | 1 | 2;
  },
): Promise<{ case: CaseRow; deskEvent: CaseEventRow; statusEvent: CaseEventRow }> {
  return withTransaction(db, async (client) => {
    const caseResult = await client.query<CaseDbRow>(
      `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
      [input.caseId],
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) {
      throw new CoreError("Case not found", "NOT_FOUND");
    }

    const workflowName = input.workflowName ?? "default";
    const workflowLevel =
      input.workflowLevel === undefined ? null : input.workflowLevel;

    let nextSeq = Number(caseRow.last_event_seq) + 1;
    const deskEvent = await appendEvent(client, {
      caseId: input.caseId,
      nextSeq,
      type: "approval_requested",
      audience: "desk",
      payload: {
        stepId: input.stepId,
        tool: input.tool,
        intentId: input.intentId ?? null,
        workflowName,
        workflowLevel,
      },
    });
    nextSeq += 1;

    const statusEvent = await appendEvent(client, {
      caseId: input.caseId,
      nextSeq,
      type: "status",
      audience: "customer",
      payload: {
        text:
          input.message ??
          "A support action is waiting for approval before it can continue.",
        pendingApproval: true,
        stepId: input.stepId,
        tool: input.tool,
        workflowName,
        workflowLevel,
      },
    });

    const updatedCase = await updateCaseAfterEvents(client, {
      caseId: input.caseId,
      lastEventSeq: nextSeq,
      ownership: "PENDING_APPROVAL",
      runnable: false,
      clearLease: true,
    });

    return { case: updatedCase, deskEvent, statusEvent };
  });
}

/**
 * Approve / reject pending writes, or simple takeover / hand_back via commandId.
 */
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
      const duplicate = await findCommandEvent(
        client,
        input.caseId,
        input.commandId,
      );
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

      const caseResult = await client.query<CaseDbRow>(
        `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
        [input.caseId],
      );
      const caseRow = caseResult.rows[0];
      if (!caseRow) {
        throw new CoreError("Case not found", "NOT_FOUND");
      }

      const nextSeq = Number(caseRow.last_event_seq) + 1;
      const event = await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: input.type === "takeover" ? "takeover" : "hand_back",
        audience: "desk",
        payload: {
          commandId: input.commandId,
          actorId: input.actor.actorId,
          role: input.actor.role,
          note: input.note ?? null,
        },
      });

      const updatedCase = await updateCaseAfterEvents(client, {
        caseId: input.caseId,
        lastEventSeq: nextSeq,
        ownership: input.type === "takeover" ? "HUMAN_OWNED" : "AI_ACTIVE",
        runnable: input.type === "hand_back",
        clearLease: true,
        bumpEpoch: true,
      });

      return { case: updatedCase, event, created: true };
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
      const duplicate = await findCommandEvent(
        client,
        input.caseId,
        input.commandId,
      );
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

      const locked = await client.query<CaseDbRow>(
        `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
        [input.caseId],
      );
      const lockedCase = locked.rows[0];
      if (!lockedCase) {
        throw new CoreError("Case not found", "NOT_FOUND");
      }

      let nextSeq = Number(lockedCase.last_event_seq) + 1;
      const event = await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "approval_rejected",
        audience: "desk",
        payload: {
          commandId: input.commandId,
          actorId: input.actor.actorId,
          stepId: input.stepId,
          tool: intent.tool,
          note: input.note ?? null,
        },
      });
      nextSeq += 1;

      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "status",
        audience: "customer",
        payload: {
          text: "The pending support action was not approved.",
          pendingApproval: false,
        },
      });

      const updatedCase = await updateCaseAfterEvents(client, {
        caseId: input.caseId,
        lastEventSeq: nextSeq,
        ownership: "AI_ACTIVE",
        runnable: true,
        clearLease: true,
      });

      return { case: updatedCase, event, created: true };
    });
  }

  const parkEvent = await db.query<{
    workflow_name: string | null;
    workflow_level: unknown;
  }>(
    `SELECT payload->>'workflowName' AS workflow_name,
            payload->'workflowLevel' AS workflow_level
     FROM case_events
     WHERE case_id = $1
       AND type = 'approval_requested'
       AND payload->>'stepId' = $2
     ORDER BY seq DESC
     LIMIT 1`,
    [input.caseId, input.stepId],
  );
  const parkedAtWorkflowName = parkEvent.rows[0]?.workflow_name ?? "default";
  const parkedAtWorkflowLevel = asWorkflowLevel(
    parkEvent.rows[0]?.workflow_level,
  );
  const liveWorkflow = await getWorkflowStatus(db, parkedAtWorkflowName);
  const promotionHint = buildPromotionHint({
    parkedLevel: parkedAtWorkflowLevel,
    currentLevel: liveWorkflow.level,
    workflowName: parkedAtWorkflowName,
  });

  // Parked reply: publish the drafted assistant message (no external tool call).
  if (intent.tool === "sendCustomerReply") {
    const draftText =
      typeof intent.args?.text === "string" ? intent.args.text.trim() : "";
    if (!draftText) {
      throw new CoreError("Draft reply missing", "BAD_REQUEST");
    }

    return withTransaction(db, async (client) => {
      const duplicate = await findCommandEvent(
        client,
        input.caseId,
        input.commandId,
      );
      if (duplicate) {
        return {
          case: mapCase(caseRow),
          event: duplicate,
          created: false,
          execution: { state: "confirmed", data: { text: draftText } },
        };
      }

      await client.query(
        `UPDATE action_intents
         SET state = 'confirmed',
             result = $2::jsonb,
             updated_at = now()
         WHERE id = $1`,
        [
          intent.id,
          JSON.stringify({ state: "confirmed", data: { text: draftText } }),
        ],
      );

      const locked = await client.query<CaseDbRow>(
        `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
        [input.caseId],
      );
      const lockedCase = locked.rows[0];
      if (!lockedCase) {
        throw new CoreError("Case not found", "NOT_FOUND");
      }

      let nextSeq = Number(lockedCase.last_event_seq) + 1;
      const event = await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "approval_granted",
        audience: "desk",
        payload: {
          commandId: input.commandId,
          actorId: input.actor.actorId,
          stepId: input.stepId,
          tool: intent.tool,
          executionState: "confirmed",
          note: input.note ?? null,
          parkedAtWorkflowName,
          parkedAtWorkflowLevel,
          currentWorkflowLevel: liveWorkflow.level,
          promotionHint,
          autoExecutedDueToPromote: false,
        },
      });
      nextSeq += 1;

      await appendEvent(client, {
        caseId: input.caseId,
        nextSeq,
        type: "assistant_message",
        audience: "customer",
        payload: {
          text: draftText,
          pendingApproval: false,
          approvedReply: true,
          workflowName: parkedAtWorkflowName,
          workflowLevel: parkedAtWorkflowLevel,
        },
      });

      const updatedCase = await updateCaseAfterEvents(client, {
        caseId: input.caseId,
        lastEventSeq: nextSeq,
        ownership: "AI_ACTIVE",
        runnable: false,
        clearLease: true,
      });

      return {
        case: updatedCase,
        event,
        created: true,
        execution: { state: "confirmed", data: { text: draftText } },
      };
    });
  }

  if (!input.executeWrite) {
    throw new CoreError("executeWrite is required for approve", "BAD_REQUEST");
  }

  // Parked decisions stay explicit: promote never auto-executes this write.
  const execution = await input.executeWrite({
    caseId: input.caseId,
    stepId: intent.step_id,
    tool: intent.tool,
    args: intent.args,
    customerId: caseRow.customer_id,
    approvedBy: input.actor.actorId,
  });

  return withTransaction(db, async (client) => {
    const duplicate = await findCommandEvent(
      client,
      input.caseId,
      input.commandId,
    );
    if (duplicate) {
      return {
        case: mapCase(caseRow),
        event: duplicate,
        created: false,
        execution,
      };
    }

    const locked = await client.query<CaseDbRow>(
      `SELECT * FROM cases WHERE id = $1 FOR UPDATE`,
      [input.caseId],
    );
    const lockedCase = locked.rows[0];
    if (!lockedCase) {
      throw new CoreError("Case not found", "NOT_FOUND");
    }

    let nextSeq = Number(lockedCase.last_event_seq) + 1;
    const event = await appendEvent(client, {
      caseId: input.caseId,
      nextSeq,
      type: "approval_granted",
      audience: "desk",
      payload: {
        commandId: input.commandId,
        actorId: input.actor.actorId,
        stepId: input.stepId,
        tool: intent.tool,
        executionState: execution.state,
        note: input.note ?? null,
        parkedAtWorkflowName,
        parkedAtWorkflowLevel,
        currentWorkflowLevel: liveWorkflow.level,
        promotionHint,
        autoExecutedDueToPromote: false,
      },
    });
    nextSeq += 1;

    await appendEvent(client, {
      caseId: input.caseId,
      nextSeq,
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
    });

    const updatedCase = await updateCaseAfterEvents(client, {
      caseId: input.caseId,
      lastEventSeq: nextSeq,
      ownership: "AI_ACTIVE",
      runnable: true,
      clearLease: true,
    });

    return {
      case: updatedCase,
      event,
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

export type PendingApproval = {
  caseId: string;
  customerId: string;
  ownership: OwnershipState;
  updatedAt: Date;
  stepId: string;
  tool: string;
  intentId: string | null;
  args: Record<string, unknown>;
  intentState: string;
  requestedAt: Date;
  customerMessage: string | null;
  parkedAtWorkflowName: string | null;
  parkedAtWorkflowLevel: 0 | 1 | 2 | null;
  currentWorkflowLevel: 0 | 1 | 2 | null;
  promotionHint: string | null;
};

/** Cases waiting on desk approve/reject, with the parked write intent. */
export async function listPendingApprovals(
  db: Db,
  limit = 50,
): Promise<PendingApproval[]> {
  const result = await db.query<{
    case_id: string;
    customer_id: string;
    ownership: OwnershipState;
    updated_at: Date;
    step_id: string;
    tool: string;
    intent_id: string | null;
    args: Record<string, unknown>;
    intent_state: string;
    requested_at: Date;
    customer_message: string | null;
    workflow_name: string | null;
    workflow_level: unknown;
  }>(
    `WITH pending AS (
       SELECT c.id AS case_id,
              c.customer_id,
              c.ownership,
              c.updated_at,
              e.payload->>'stepId' AS step_id,
              e.payload->>'tool' AS tool,
              e.payload->>'intentId' AS intent_id,
              e.payload->>'workflowName' AS workflow_name,
              e.payload->'workflowLevel' AS workflow_level,
              e.created_at AS requested_at,
              e.seq
       FROM cases c
       JOIN LATERAL (
         SELECT payload, created_at, seq
         FROM case_events
         WHERE case_id = c.id
           AND type = 'approval_requested'
         ORDER BY seq DESC
         LIMIT 1
       ) e ON true
       WHERE c.ownership = 'PENDING_APPROVAL'
       ORDER BY c.updated_at DESC
       LIMIT $1
     )
     SELECT p.case_id,
            p.customer_id,
            p.ownership,
            p.updated_at,
            p.step_id,
            p.tool,
            p.intent_id,
            COALESCE(i.args, '{}'::jsonb) AS args,
            COALESCE(i.state::text, 'intended') AS intent_state,
            p.requested_at,
            p.workflow_name,
            p.workflow_level,
            (
              SELECT payload->>'text'
              FROM case_events
              WHERE case_id = p.case_id
                AND type = 'customer_message'
              ORDER BY seq DESC
              LIMIT 1
            ) AS customer_message
     FROM pending p
     LEFT JOIN action_intents i
       ON i.case_id = p.case_id
      AND i.step_id = p.step_id
     WHERE p.step_id IS NOT NULL
       AND p.tool IS NOT NULL
     ORDER BY p.requested_at DESC`,
    [limit],
  );

  const items: PendingApproval[] = [];
  for (const row of result.rows) {
    const parkedAtWorkflowName = row.workflow_name ?? "default";
    const parkedAtWorkflowLevel = asWorkflowLevel(row.workflow_level);
    const live = await getWorkflowStatus(db, parkedAtWorkflowName);
    items.push({
      caseId: row.case_id,
      customerId: row.customer_id,
      ownership: row.ownership,
      updatedAt: row.updated_at,
      stepId: row.step_id,
      tool: row.tool,
      intentId: row.intent_id,
      args: row.args ?? {},
      intentState: row.intent_state,
      requestedAt: row.requested_at,
      customerMessage: row.customer_message,
      parkedAtWorkflowName,
      parkedAtWorkflowLevel,
      currentWorkflowLevel: live.level,
      promotionHint: buildPromotionHint({
        parkedLevel: parkedAtWorkflowLevel,
        currentLevel: live.level,
        workflowName: parkedAtWorkflowName,
      }),
    });
  }
  return items;
}
