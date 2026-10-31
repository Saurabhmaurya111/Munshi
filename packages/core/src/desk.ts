import type { Db, DbClient } from "./db.js";
import { withTransaction } from "./db.js";
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
};

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
      if (latestCustomerText && escalationSummary && ticketId) break;
    }

    const ticket = await getCaseTicket(db, {
      caseId: caseRow.id,
      customerId: caseRow.customerId,
    });

    items.push({
      case: caseRow,
      waitingFor:
        caseRow.ownership === "PENDING_APPROVAL" ? "approval" : "human",
      latestCustomerText,
      escalationSummary,
      recommendation,
      ticketId: ticket?.complaintId ?? ticketId,
      ticketStatus: ticket?.status ?? null,
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
