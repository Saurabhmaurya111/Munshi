import type { Db } from "./db.js";
import { CoreError } from "./types.js";
import type { CaseRow } from "./types.js";

type CaseDbRow = {
  id: string;
  status: string;
  ownership: CaseRow["ownership"];
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

export async function getVirtualNow(db: Db): Promise<Date> {
  const result = await db.query<{ now_at: Date }>(
    `SELECT now_at FROM demo_clock WHERE id = 1`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError("demo_clock is not initialized", "CONFLICT");
  }
  return row.now_at;
}

export async function advanceVirtualClock(
  db: Db,
  advanceByMs: number,
): Promise<Date> {
  if (!Number.isFinite(advanceByMs) || advanceByMs < 0) {
    throw new CoreError("advanceByMs must be a non-negative number", "BAD_REQUEST");
  }
  const result = await db.query<{ now_at: Date }>(
    `UPDATE demo_clock
     SET now_at = now_at + ($1::text || ' milliseconds')::interval
     WHERE id = 1
     RETURNING now_at`,
    [String(Math.floor(advanceByMs))],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError("demo_clock is not initialized", "CONFLICT");
  }
  return row.now_at;
}

export async function setVirtualClock(db: Db, setTo: Date): Promise<Date> {
  const result = await db.query<{ now_at: Date }>(
    `UPDATE demo_clock
     SET now_at = $1
     WHERE id = 1
     RETURNING now_at`,
    [setTo.toISOString()],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError("demo_clock is not initialized", "CONFLICT");
  }
  return row.now_at;
}

/** Park a case until wakeAt (virtual clock). Does not touch lease expiry clock. */
export async function scheduleExternalWait(
  db: Db,
  input: { caseId: string; wakeAt: Date },
): Promise<CaseRow> {
  const result = await db.query<CaseDbRow>(
    `UPDATE cases
     SET ownership = 'WAITING_EXTERNAL',
         wake_at = $2,
         runnable = false,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [input.caseId, input.wakeAt.toISOString()],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError("Case not found", "NOT_FOUND");
  }
  return mapCase(row);
}

/** Wake WAITING_EXTERNAL cases whose wake_at <= virtual now. Never touches leases. */
export async function wakeDueCases(
  db: Db,
  virtualNow?: Date,
): Promise<CaseRow[]> {
  const now = virtualNow ?? (await getVirtualNow(db));
  const result = await db.query<CaseDbRow>(
    `UPDATE cases
     SET ownership = 'AI_ACTIVE',
         wake_at = NULL,
         runnable = true,
         updated_at = now()
     WHERE ownership = 'WAITING_EXTERNAL'
       AND wake_at IS NOT NULL
       AND wake_at <= $1
     RETURNING *`,
    [now.toISOString()],
  );
  return result.rows.map(mapCase);
}
