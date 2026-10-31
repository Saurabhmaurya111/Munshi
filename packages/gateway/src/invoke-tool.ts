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
  if (row.state === "intended") {
    return {
      state: "pending_approval",
      intentId: row.id,
      stepId: row.step_id,
      tool: row.tool,
      message: "This action needs human approval before it can run.",
    };
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
  heldEpoch?: string,
  caseId?: string,
): Promise<"ok" | "epoch_conflict"> {
  if (heldEpoch && caseId) {
    const epochCheck = await db.query<{ epoch: string }>(
      `SELECT epoch::text AS epoch FROM cases WHERE id = $1`,
      [caseId],
    );
    const current = epochCheck.rows[0]?.epoch;
    if (current !== undefined && current !== heldEpoch) {
      const failed: ToolInvocationResult = {
        state: "failed",
        errorCode: "EPOCH_CONFLICT",
        message: "Lease lost; write not confirmed",
      };
      await db.query(
        `UPDATE action_intents
         SET state = 'failed'::intent_state,
             result = $2::jsonb,
             updated_at = now()
         WHERE idempotency_key = $1
           AND state IN ('intended', 'sent', 'unknown')`,
        [idempotencyKey, JSON.stringify(failed)],
      );
      return "epoch_conflict";
    }
  }

  await db.query(
    `UPDATE action_intents
     SET state = $2::intent_state,
         result = $3::jsonb,
         updated_at = now()
     WHERE idempotency_key = $1`,
    [idempotencyKey, state, JSON.stringify(result)],
  );
  return "ok";
}

async function executeHandler(input: {
  db: Db;
  handlers: ReturnType<typeof createMockWorldHandlers>;
  tool: string;
  customerId: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  timeoutMs: number;
  heldEpoch?: string;
  caseId: string;
}): Promise<ToolInvocationResult> {
  const {
    db,
    handlers,
    tool,
    customerId,
    args,
    idempotencyKey,
    timeoutMs,
    heldEpoch,
    caseId,
  } = input;

  await db.query(
    `UPDATE action_intents
     SET state = 'sent', updated_at = now()
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );

  const handler = handlers[tool];
  if (!handler) {
    const failed: ToolInvocationResult = {
      state: "failed",
      errorCode: "NO_HANDLER",
      message: `No mock handler for ${tool}`,
    };
    await persistIntentResult(db, idempotencyKey, "failed", failed, heldEpoch, caseId);
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
          customerId,
          args,
          signal: controller.signal,
          idempotencyKey,
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
    const persist = await persistIntentResult(
      db,
      idempotencyKey,
      intentState,
      result,
      heldEpoch,
      caseId,
    );
    if (persist === "epoch_conflict") {
      return {
        state: "failed",
        errorCode: "EPOCH_CONFLICT",
        message: "Lease lost; write not confirmed",
      };
    }
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

      const validated = validateToolArgs(input.tool, input.args);
      if (!validated.ok) {
        return {
          state: "failed",
          errorCode: "INVALID_ARGS",
          message: validated.issues.join("; "),
        };
      }

      const workflowLevel = input.workflowLevel ?? 0;
      const executeApproved = Boolean(input.executeApproved);
      const canAutoRunWrite =
        card.risk === "write" && workflowLevel >= 2 && !executeApproved;
      const needsPark =
        card.risk !== "read" && !executeApproved && !canAutoRunWrite;

      const decision = evaluateGuardrail({
        tool: input.tool,
        risk: card.risk,
        caseId: input.caseId,
        customerId: input.customerId,
        args: validated.data,
        workflowLevel,
        executeApproved: executeApproved || canAutoRunWrite,
      });

      // Parking path: escalate is expected; other non-allow blocks.
      if (needsPark) {
        if (decision === "block") {
          return {
            state: "failed",
            errorCode: "GUARDRAIL_BLOCKED",
            message: `Guardrail decision: ${decision}`,
          };
        }
      } else if (decision !== "allow") {
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
        if (
          executeApproved &&
          (existingRow.state === "intended" || existingRow.state === "unknown")
        ) {
          return executeHandler({
            db,
            handlers,
            tool: existingRow.tool,
            customerId: input.customerId,
            args: existingRow.args,
            idempotencyKey,
            timeoutMs,
            heldEpoch: input.heldEpoch,
            caseId: input.caseId,
          });
        }
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
        const race = await db.query<IntentRow>(
          `SELECT id, case_id, step_id, tool, idempotency_key, state, args, result
           FROM action_intents
           WHERE idempotency_key = $1
           LIMIT 1`,
          [idempotencyKey],
        );
        const raced = race.rows[0];
        if (raced) {
          if (
            executeApproved &&
            (raced.state === "intended" || raced.state === "unknown")
          ) {
            return executeHandler({
              db,
              handlers,
              tool: raced.tool,
              customerId: input.customerId,
              args: raced.args,
              idempotencyKey,
              timeoutMs,
              heldEpoch: input.heldEpoch,
              caseId: input.caseId,
            });
          }
          return resultFromIntent(raced);
        }
        throw error;
      }

      if (needsPark) {
        const parked = await db.query<IntentRow>(
          `SELECT id, case_id, step_id, tool, idempotency_key, state, args, result
           FROM action_intents
           WHERE idempotency_key = $1
           LIMIT 1`,
          [idempotencyKey],
        );
        const row = parked.rows[0];
        if (!row) {
          return {
            state: "failed",
            errorCode: "PARK_FAILED",
            message: "Failed to park write for approval",
          };
        }
        return {
          state: "pending_approval",
          intentId: row.id,
          stepId: row.step_id,
          tool: row.tool,
          message: "This action needs human approval before it can run.",
        };
      }

      return executeHandler({
        db,
        handlers,
        tool: input.tool,
        customerId: input.customerId,
        args: validated.data,
        idempotencyKey,
        timeoutMs,
        heldEpoch: input.heldEpoch,
        caseId: input.caseId,
      });
    },
  };
}
