import type { Db, DbClient } from "./db.js";
import { withTransaction } from "./db.js";
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

export async function createCase(
  db: Db,
  input: { customerId: string; priority?: number },
): Promise<CaseRow> {
  const priority = input.priority ?? 0;
  const result = await db.query<CaseDbRow>(
    `INSERT INTO cases (customer_id, priority, ownership, status, runnable)
     VALUES ($1, $2, 'AI_ACTIVE', 'open', true)
     RETURNING *`,
    [input.customerId, priority],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError("Failed to create case", "CONFLICT");
  }
  return mapCase(row);
}

export async function getCaseForCustomer(
  db: Db,
  input: { caseId: string; customerId: string },
): Promise<CaseRow> {
  const result = await db.query<CaseDbRow>(
    `SELECT * FROM cases WHERE id = $1`,
    [input.caseId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError("Case not found", "NOT_FOUND");
  }
  if (row.customer_id !== input.customerId) {
    throw new CoreError("Case not found", "NOT_FOUND");
  }
  return mapCase(row);
}

export async function listCaseEvents(
  db: Db,
  input: {
    caseId: string;
    limit?: number;
    audience?: Audience | Audience[];
  },
): Promise<CaseEventRow[]> {
  const limit = input.limit ?? 50;
  const audiences = input.audience
    ? Array.isArray(input.audience)
      ? input.audience
      : [input.audience]
    : null;

  if (!audiences) {
    const result = await db.query<EventDbRow>(
      `SELECT id, case_id, seq, type, audience, payload, created_at
       FROM case_events
       WHERE case_id = $1
       ORDER BY seq ASC
       LIMIT $2`,
      [input.caseId, limit],
    );
    return result.rows.map(mapEvent);
  }

  const result = await db.query<EventDbRow>(
    `SELECT id, case_id, seq, type, audience, payload, created_at
     FROM case_events
     WHERE case_id = $1
       AND audience = ANY($2::event_audience[])
     ORDER BY seq ASC
     LIMIT $3`,
    [input.caseId, audiences, limit],
  );
  return result.rows.map(mapEvent);
}

async function findEventByCommandId(
  client: DbClient,
  caseId: string,
  commandId: string,
): Promise<CaseEventRow | null> {
  const result = await client.query<EventDbRow>(
    `SELECT id, case_id, seq, type, audience, payload, created_at
     FROM case_events
     WHERE case_id = $1
       AND type = 'customer_message'
       AND payload->>'commandId' = $2
     LIMIT 1`,
    [caseId, commandId],
  );
  const row = result.rows[0];
  return row ? mapEvent(row) : null;
}

export type AppendCustomerMessageResult = {
  case: CaseRow;
  event: CaseEventRow;
  created: boolean;
};

export async function appendCustomerMessage(
  db: Db,
  input: {
    caseId: string;
    customerId: string;
    message: string;
    commandId?: string;
  },
): Promise<AppendCustomerMessageResult> {
  const message = input.message.trim();
  if (!message) {
    throw new CoreError("message is required", "BAD_REQUEST");
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

    if (input.commandId) {
      const existing = await findEventByCommandId(
        client,
        input.caseId,
        input.commandId,
      );
      if (existing) {
        return { case: mapCase(caseRow), event: existing, created: false };
      }
    }

    const nextSeq = Number(caseRow.last_event_seq) + 1;
    const payload: Record<string, unknown> = {
      text: message,
      ...(input.commandId ? { commandId: input.commandId } : {}),
    };

    const eventResult = await client.query<EventDbRow>(
      `INSERT INTO case_events (case_id, seq, type, audience, payload)
       VALUES ($1, $2, 'customer_message', 'customer', $3::jsonb)
       RETURNING id, case_id, seq, type, audience, payload, created_at`,
      [input.caseId, nextSeq, JSON.stringify(payload)],
    );
    const eventRow = eventResult.rows[0];
    if (!eventRow) {
      throw new CoreError("Failed to append event", "CONFLICT");
    }

    const updated = await client.query<CaseDbRow>(
      `UPDATE cases
       SET last_event_seq = $2,
           runnable = true,
           ownership = CASE
             WHEN ownership = 'WAITING_EXTERNAL' THEN 'AI_ACTIVE'::ownership_state
             ELSE ownership
           END,
           wake_at = CASE
             WHEN ownership = 'WAITING_EXTERNAL' THEN NULL
             ELSE wake_at
           END,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.caseId, nextSeq],
    );
    const updatedCase = updated.rows[0];
    if (!updatedCase) {
      throw new CoreError("Failed to update case", "CONFLICT");
    }

    return {
      case: mapCase(updatedCase),
      event: mapEvent(eventRow),
      created: true,
    };
  });
}

export async function createCaseAndAppendMessage(
  db: Db,
  input: {
    customerId: string;
    message: string;
    caseId?: string;
    commandId?: string;
    priority?: number;
  },
): Promise<AppendCustomerMessageResult> {
  let caseId = input.caseId;
  if (!caseId) {
    const created = await createCase(db, {
      customerId: input.customerId,
      priority: input.priority,
    });
    caseId = created.id;
  }

  return appendCustomerMessage(db, {
    caseId,
    customerId: input.customerId,
    message: input.message,
    commandId: input.commandId,
  });
}
