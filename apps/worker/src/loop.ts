import {
  appendEventWithEpoch,
  claimCase,
  type Db,
} from "@repo/core";

export type WorkerLoopOptions = {
  db: Db;
  workerId: string;
  leaseMs: number;
  pollMs: number;
  signal?: AbortSignal;
  /** Injected for tests; defaults to setTimeout. */
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

/**
 * B3 claim loop: claim → append stub worker_step → clear runnable + lease.
 * Does not call the agent graph yet.
 */
export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const { db, workerId, leaseMs, pollMs, signal } = options;

  while (!signal?.aborted) {
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
      await appendEventWithEpoch(db, {
        caseId: caseRow.id,
        heldEpoch,
        type: "worker_step",
        audience: "internal",
        payload: {
          stub: true,
          workerId,
          note: "b3 stub",
        },
        runnable: false,
        releaseLease: true,
      });
      console.info(
        JSON.stringify({
          msg: "worker_step_stub",
          caseId: caseRow.id,
          workerId,
          epoch: heldEpoch,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "worker_step_failed",
          caseId: caseRow.id,
          workerId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
