import { afterAll, describe, expect, it } from "vitest";
import {
  appendEventWithEpoch,
  claimCase,
  createCase,
  createDb,
  releaseCase,
  type Db,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

async function withOnlyCaseRunnable<T>(
  db: Db,
  caseId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const paused = await db.query<{ id: string }>(
    `UPDATE cases
     SET runnable = false
     WHERE runnable = true AND id <> $1::uuid
     RETURNING id`,
    [caseId],
  );
  try {
    return await fn();
  } finally {
    const ids = paused.rows.map((row) => row.id);
    if (ids.length > 0) {
      await db.query(
        `UPDATE cases SET runnable = true WHERE id = ANY($1::uuid[])`,
        [ids],
      );
    }
  }
}

describeDb("claimCase / lease exclusivity", () => {
  const db: Db = createDb(databaseUrl!);

  afterAll(async () => {
    await db.end();
  });

  it(
    "gives the case to only one worker while the lease is live",
    async () => {
      const created = await createCase(db, {
        customerId: "customer-soham",
        priority: 50,
      });

      await withOnlyCaseRunnable(db, created.id, async () => {
        const first = await claimCase(db, {
          workerId: "worker-a",
          leaseMs: 60_000,
        });
        expect(first).not.toBeNull();
        expect(first!.case.id).toBe(created.id);
        expect(first!.case.leaseOwner).toBe("worker-a");

        // Second worker must not take the live-leased case.
        const second = await claimCase(db, {
          workerId: "worker-b",
          leaseMs: 60_000,
        });
        expect(second).toBeNull();

        await appendEventWithEpoch(db, {
          caseId: first!.case.id,
          heldEpoch: first!.heldEpoch,
          type: "worker_step",
          audience: "internal",
          payload: {
            stub: true,
            workerId: "worker-a",
            note: "b3 stub",
          },
          runnable: false,
          releaseLease: true,
        });

        const again = await claimCase(db, {
          workerId: "worker-c",
          leaseMs: 60_000,
        });
        expect(again).toBeNull();
      });
    },
    20_000,
  );

  it("rejects a stale epoch append after another worker re-claims", async () => {
    const created = await createCase(db, {
      customerId: "customer-soham",
      priority: 40,
    });

    await withOnlyCaseRunnable(db, created.id, async () => {
      const first = await claimCase(db, {
        workerId: "worker-stale",
        leaseMs: 60_000,
      });
      expect(first?.case.id).toBe(created.id);
      const staleEpoch = first!.heldEpoch;

      await releaseCase(db, {
        caseId: created.id,
        heldEpoch: staleEpoch,
        runnable: true,
      });

      const second = await claimCase(db, {
        workerId: "worker-fresh",
        leaseMs: 60_000,
      });
      expect(second?.case.id).toBe(created.id);
      expect(second!.heldEpoch).not.toBe(staleEpoch);

      await expect(
        appendEventWithEpoch(db, {
          caseId: created.id,
          heldEpoch: staleEpoch,
          type: "worker_step",
          audience: "internal",
          payload: { stub: true },
          runnable: false,
          releaseLease: true,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      await appendEventWithEpoch(db, {
        caseId: created.id,
        heldEpoch: second!.heldEpoch,
        type: "worker_step",
        audience: "internal",
        payload: { stub: true, workerId: "worker-fresh" },
        runnable: false,
        releaseLease: true,
      });
    });
  });
});
