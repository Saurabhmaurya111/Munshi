import { claimCase, wakeDueCases, type Db } from "@repo/core";
import type { SupervisorDependencies } from "./agent/supervisor.js";
import { reconcileUnknownIntents } from "./reconciler.js";
import { processClaimedCase } from "./turn.js";

export type WorkerLoopOptions = {
  db: Db;
  workerId: string;
  leaseMs: number;
  pollMs: number;
  dependencies: SupervisorDependencies;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** Claim loop: timers → reconciler → claim → supervisor turn → persist. */
export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const { db, workerId, leaseMs, pollMs, dependencies, signal } = options;

  while (!signal?.aborted) {
    try {
      const woken = await wakeDueCases(db);
      if (woken.length > 0) {
        console.info(
          JSON.stringify({
            msg: "timer_woke_cases",
            count: woken.length,
            caseIds: woken.map((row) => row.id),
          }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "timer_tick_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    try {
      const resolved = await reconcileUnknownIntents(db);
      if (resolved > 0) {
        console.info(
          JSON.stringify({ msg: "reconciler_resolved", count: resolved }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "reconciler_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    const claimed = await claimCase(db, { workerId, leaseMs });
    if (!claimed) {
      try {
        await sleep(pollMs, signal);
      } catch {
        break;
      }
      continue;
    }

    const { case: caseRow, heldEpoch } = claimed;
    try {
      const result = await processClaimedCase({
        db,
        caseRow,
        heldEpoch,
        workerId,
        dependencies,
      });
      console.info(
        JSON.stringify({
          msg: "worker_turn_done",
          caseId: result.caseId,
          workerId,
          status: result.status,
          workflowLevel: result.workflowLevel,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "worker_turn_failed",
          caseId: caseRow.id,
          workerId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
