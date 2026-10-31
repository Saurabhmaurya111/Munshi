import type { Queryable, ToolOutcomeLookup } from "./types.js";

export async function recordToolOutcome(
  db: Queryable,
  input: {
    idempotencyKey: string;
    tool: string;
    customerId: string;
    state: "confirmed" | "failed" | "unknown";
    data?: unknown;
    errorCode?: string;
    message?: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO mock_tool_outcomes (
       idempotency_key, tool, customer_id, state, data, error_code, message
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       state = EXCLUDED.state,
       data = EXCLUDED.data,
       error_code = EXCLUDED.error_code,
       message = EXCLUDED.message,
       updated_at = now()`,
    [
      input.idempotencyKey,
      input.tool,
      input.customerId,
      input.state,
      input.data === undefined ? null : JSON.stringify(input.data),
      input.errorCode ?? null,
      input.message ?? null,
    ],
  );
}

export async function lookupByIdempotencyKey(
  db: Queryable,
  idempotencyKey: string,
): Promise<ToolOutcomeLookup | null> {
  const result = await db.query<{
    state: "confirmed" | "failed" | "unknown";
    data: unknown;
    error_code: string | null;
    message: string | null;
  }>(
    `SELECT state, data, error_code, message
     FROM mock_tool_outcomes
     WHERE idempotency_key = $1
     LIMIT 1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    state: row.state,
    data: row.data ?? undefined,
    errorCode: row.error_code ?? undefined,
    message: row.message ?? undefined,
  };
}
