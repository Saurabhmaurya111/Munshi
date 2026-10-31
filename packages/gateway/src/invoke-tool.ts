import type { Db } from "@repo/core";
import { evaluateGuardrail } from "@repo/guardrails";
import { createMockWorldHandlers } from "@repo/mock-world";
import { getToolCard, validateToolArgs } from "@repo/registry";
import type {
  IntentState,
  ToolInvocationInput,
  ToolInvocationResult,
  ToolInvoker,
} from "./types.js";

export function idempotencyKeyFor(caseId: string, stepId: string): string {
  return `${caseId}:${stepId}`;
}

type IntentRow = {
  id: string;
  case_id: string;
  step_id: string;
  tool: string;
  idempotency_key: string;
  state: IntentState;
  args: Record<string, unknown>;
  result: ToolInvocationResult | null;
};

function resultFromIntent(row: IntentRow): ToolInvocationResult {
  if (row.result) {
    return row.result;
  }
  if (row.state === "confirmed") {
    return { state: "confirmed", data: null };
  }
  if (row.state === "failed") {
    return {
      state: "failed",
      errorCode: "FAILED",
      message: "Tool call failed",
    };
  }
  return { state: "unknown", reason: "transport", errorCode: "UNKNOWN" };
}

async function persistIntentResult(
  db: Db,
  idempotencyKey: string,
  state: IntentState,
  result: ToolInvocationResult,
): Promise<void> {
  await db.query(
    `UPDATE action_intents
     SET state = $2::intent_state,
         result = $3::jsonb,
         updated_at = now()
     WHERE idempotency_key = $1`,
    [idempotencyKey, state, JSON.stringify(result)],
  );
}

export type CreateInvokeToolOptions = {
  db: Db;
  timeoutMs?: number;
  /** Test hook to force handler delay / abort behavior. */
  handlers?: ReturnType<typeof createMockWorldHandlers>;
};

export function createInvokeTool(
  options: CreateInvokeToolOptions,
): ToolInvoker {
  const timeoutMs = options.timeoutMs ?? 5000;
  const handlers = options.handlers ?? createMockWorldHandlers(options.db);
  const { db } = options;

  return {
    async invoke(input: ToolInvocationInput): Promise<ToolInvocationResult> {
      const card = getToolCard(input.tool);
      if (!card) {
        return {
          state: "failed",
          errorCode: "UNKNOWN_TOOL",
          message: `Unknown tool ${input.tool}`,
        };
      }

      if (card.risk !== "read") {
        return {
          state: "failed",
          errorCode: "WRITE_NOT_ALLOWED",
          message: "Write tools require approval (B5). Not available yet.",
        };
      }

      const validated = validateToolArgs(input.tool, input.args);
      if (!validated.ok) {
        return {
          state: "failed",
          errorCode: "INVALID_ARGS",
          message: validated.issues.join("; "),
        };
      }

      const decision = evaluateGuardrail({
        tool: input.tool,
        risk: card.risk,
        caseId: input.caseId,
        customerId: input.customerId,
        args: validated.data,
      });
      if (decision !== "allow") {
        return {
          state: "failed",
          errorCode: "GUARDRAIL_BLOCKED",
          message: `Guardrail decision: ${decision}`,
        };
      }

      const idempotencyKey = idempotencyKeyFor(input.caseId, input.stepId);

      const existing = await db.query<IntentRow>(
        `SELECT id, case_id, step_id, tool, idempotency_key, state, args, result
         FROM action_intents
         WHERE idempotency_key = $1
         LIMIT 1`,
        [idempotencyKey],
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        return resultFromIntent(existingRow);
      }

      try {
        await db.query(
          `INSERT INTO action_intents (
             case_id, step_id, tool, idempotency_key, state, args
           ) VALUES ($1, $2, $3, $4, 'intended', $5::jsonb)`,
          [
            input.caseId,
            input.stepId,
            input.tool,
            idempotencyKey,
            JSON.stringify(validated.data),
          ],
        );
      } catch (error) {
        // Concurrent insert: return the winner's recorded result.
        const race = await db.query<IntentRow>(
          `SELECT id, case_id, step_id, tool, idempotency_key, state, args, result
           FROM action_intents
           WHERE idempotency_key = $1
           LIMIT 1`,
          [idempotencyKey],
        );
        const raced = race.rows[0];
        if (raced) {
          return resultFromIntent(raced);
        }
        throw error;
      }

      await db.query(
        `UPDATE action_intents
         SET state = 'sent', updated_at = now()
         WHERE idempotency_key = $1`,
        [idempotencyKey],
      );

      const handler = handlers[input.tool];
      if (!handler) {
        const failed: ToolInvocationResult = {
          state: "failed",
          errorCode: "NO_HANDLER",
          message: `No mock handler for ${input.tool}`,
        };
        await persistIntentResult(db, idempotencyKey, "failed", failed);
        return failed;
      }

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const timeoutPromise = new Promise<ToolInvocationResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({
            state: "unknown",
            reason: "timeout",
            errorCode: "TIMEOUT",
          });
        }, timeoutMs);
      });

      try {
        const handlerPromise = (async (): Promise<ToolInvocationResult> => {
          try {
            const outcome = await handler({
              customerId: input.customerId,
              args: validated.data,
              signal: controller.signal,
            });
            if (outcome.ok) {
              return { state: "confirmed", data: outcome.data };
            }
            return {
              state: "failed",
              errorCode: outcome.errorCode,
              message: outcome.message,
            };
          } catch (error) {
            if (
              error instanceof Error &&
              (error.name === "AbortError" || error.message === "aborted")
            ) {
              return {
                state: "unknown",
                reason: "timeout",
                errorCode: "TIMEOUT",
              };
            }
            return {
              state: "unknown",
              reason: "transport",
              errorCode: "TRANSPORT_ERROR",
            };
          }
        })();

        const result = await Promise.race([handlerPromise, timeoutPromise]);
        const intentState: IntentState =
          result.state === "confirmed"
            ? "confirmed"
            : result.state === "failed"
              ? "failed"
              : "unknown";
        await persistIntentResult(db, idempotencyKey, intentState, result);
        return result;
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}
