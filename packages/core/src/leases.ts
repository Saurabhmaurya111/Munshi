import type { Db } from "./db.js";
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

export type ClaimResult = {
  case: CaseRow;
  heldEpoch: string;
};

const DEFAULT_LEASE_MS = 30_000;

/**
 * Claim one runnable AI_ACTIVE case. Exclusive via FOR UPDATE SKIP LOCKED.
 * Sets lease and bumps epoch in the same transaction.
 */
export async function claimCase(
  db: Db,
  input: { workerId: string; leaseMs?: number },
): Promise<ClaimResult | null> {
  const workerId = input.workerId.trim();
  if (!workerId) {
    throw new CoreError("workerId is required", "BAD_REQUEST");
  }
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new CoreError("leaseMs must be a positive number", "BAD_REQUEST");
  }

  return withTransaction(db, async (client) => {
    const result = await client.query<CaseDbRow>(
      `WITH candidate AS (
         SELECT id
         FROM cases
         WHERE runnable = true
           AND ownership = 'AI_ACTIVE'
           AND (lease_expires_at IS NULL OR lease_expires_at < now())
         ORDER BY priority DESC, updated_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE cases c
       SET lease_owner = $1,
           lease_expires_at = now() + ($2::text || ' milliseconds')::interval,
           epoch = epoch + 1,
           updated_at = now()
       FROM candidate
       WHERE c.id = candidate.id
       RETURNING c.*`,
      [workerId, String(Math.floor(leaseMs))],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return { case: mapCase(row), heldEpoch: row.epoch };
  });
}

/**
 * Append an event while holding the fencing epoch.
 * Zero rows on the epoch-checked update means the worker lost the case.
 */
export async function appendEventWithEpoch(
  db: Db,
  input: {
    caseId: string;
    heldEpoch: string;
    type: string;
    audience: Audience;
    payload?: Record<string, unknown>;
    runnable?: boolean;
    releaseLease?: boolean;
  },
): Promise<{ case: CaseRow; event: CaseEventRow }> {
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

    const nextSeq = Number(caseRow.last_event_seq) + 1;
    const payload = input.payload ?? {};
    const eventResult = await client.query<EventDbRow>(
      `INSERT INTO case_events (case_id, seq, type, audience, payload)
       VALUES ($1, $2, $3, $4::event_audience, $5::jsonb)
       RETURNING id, case_id, seq, type, audience, payload, created_at`,
      [
        input.caseId,
        nextSeq,
        input.type,
        input.audience,
        JSON.stringify(payload),
      ],
    );
    const eventRow = eventResult.rows[0];
    if (!eventRow) {
      throw new CoreError("Failed to append event", "CONFLICT");
    }

    const runnable = input.runnable ?? caseRow.runnable;
    const releaseLease = input.releaseLease ?? false;

    const updated = await client.query<CaseDbRow>(
      `UPDATE cases
       SET last_event_seq = $2,
           runnable = $3,
           lease_owner = CASE WHEN $4 THEN NULL ELSE lease_owner END,
           lease_expires_at = CASE WHEN $4 THEN NULL ELSE lease_expires_at END,
           updated_at = now()
       WHERE id = $1 AND epoch = $5
       RETURNING *`,
      [
        input.caseId,
        nextSeq,
        runnable,
        releaseLease,
        input.heldEpoch,
      ],
    );
    const updatedCase = updated.rows[0];
    if (!updatedCase) {
      throw new CoreError("Epoch mismatch; lease lost", "CONFLICT");
    }

    await notifyCaseEvent(client, { caseId: input.caseId, seq: nextSeq });
    return { case: mapCase(updatedCase), event: mapEvent(eventRow) };
  });
}

/** Clear lease while still holding the fencing epoch. */
export async function releaseCase(
  db: Db,
  input: {
    caseId: string;
    heldEpoch: string;
    runnable?: boolean;
  },
): Promise<CaseRow> {
  const result = await db.query<CaseDbRow>(
    `UPDATE cases
     SET lease_owner = NULL,
         lease_expires_at = NULL,
         runnable = CASE
           WHEN $3::boolean IS NULL THEN runnable
           ELSE $3::boolean
         END,
         updated_at = now()
     WHERE id = $1 AND epoch = $2
     RETURNING *`,
    [
      input.caseId,
      input.heldEpoch,
      input.runnable === undefined ? null : input.runnable,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError("Epoch mismatch; lease lost", "CONFLICT");
  }
  return mapCase(row);
}
