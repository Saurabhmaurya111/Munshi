import type { Db } from "@repo/core";
import { lookupByIdempotencyKey } from "@repo/mock-world";

type UnknownIntent = {
  id: string;
  case_id: string;
  step_id: string;
  tool: string;
  idempotency_key: string;
};

/**
 * Resolve action_intents stuck in `unknown` by asking the mock world.
 */
export async function reconcileUnknownIntents(
  db: Db,
  limit = 20,
): Promise<number> {
  const pending = await db.query<UnknownIntent>(
    `SELECT id, case_id, step_id, tool, idempotency_key
     FROM action_intents
     WHERE state = 'unknown'
     ORDER BY updated_at ASC
     LIMIT $1`,
    [limit],
  );

  let resolved = 0;
  for (const intent of pending.rows) {
    const outcome = await lookupByIdempotencyKey(db, intent.idempotency_key);
    if (!outcome) {
      continue;
    }

    const result =
      outcome.state === "confirmed"
        ? { state: "confirmed" as const, data: outcome.data ?? null }
        : outcome.state === "failed"
          ? {
              state: "failed" as const,
              errorCode: outcome.errorCode ?? "FAILED",
              message: outcome.message ?? "Reconciled failure",
            }
          : {
              state: "unknown" as const,
              reason: "transport" as const,
              errorCode: outcome.errorCode ?? "UNKNOWN",
            };

    if (result.state === "unknown") {
      continue;
    }

    await db.query(
      `UPDATE action_intents
       SET state = $2::intent_state,
           result = $3::jsonb,
           updated_at = now()
       WHERE id = $1 AND state = 'unknown'`,
      [intent.id, result.state, JSON.stringify(result)],
    );

    await db.query(
      `INSERT INTO case_events (case_id, seq, type, audience, payload)
       SELECT $1, last_event_seq + 1, 'intent_reconciled', 'internal', $2::jsonb
       FROM cases WHERE id = $1`,
      [
        intent.case_id,
        JSON.stringify({
          stepId: intent.step_id,
          tool: intent.tool,
          state: result.state,
        }),
      ],
    );

    await db.query(
      `UPDATE cases
       SET last_event_seq = last_event_seq + 1,
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
       WHERE id = $1`,
      [intent.case_id],
    );

    resolved += 1;
  }

  return resolved;
}
