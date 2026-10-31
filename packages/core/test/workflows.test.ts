import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db.js";
import { buildPromotionHint } from "../src/desk.js";
import {
  ensureDefaultWorkflow,
  forcePromoteWorkflow,
  getWorkflowStatus,
  recordWorkflowRun,
  setWorkflowLevel,
  PROMOTION_CLEAN_RUNS,
} from "../src/workflows.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describe("mid-flight promotion hints", () => {
  it("explains promote without implying auto-run", () => {
    expect(
      buildPromotionHint({
        parkedLevel: 0,
        currentLevel: 2,
        workflowName: "default",
      }),
    ).toMatch(/still needs explicit approve/);
    expect(
      buildPromotionHint({
        parkedLevel: 1,
        currentLevel: 1,
        workflowName: "upi",
      }),
    ).toMatch(/Parked at L1/);
  });
});

describeDb("workflow promotion", () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.end();
  });

  it(
    "force promote only updates workflows, not parked cases",
    async () => {
      await ensureDefaultWorkflow(db);
      await setWorkflowLevel(db, 0);
      const before = await db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM cases WHERE ownership = 'PENDING_APPROVAL'`,
      );
      await forcePromoteWorkflow(db);
      const after = await db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM cases WHERE ownership = 'PENDING_APPROVAL'`,
      );
      expect(after.rows[0]?.c).toBe(before.rows[0]?.c);
      const status = await getWorkflowStatus(db);
      expect(status.level).toBe(1);
    },
    30_000,
  );

  it(
    "promotes 0→1 after 20 clean runs and supports force promote",
    async () => {
      await ensureDefaultWorkflow(db);
      await setWorkflowLevel(db, 0);

      for (let i = 0; i < PROMOTION_CLEAN_RUNS - 1; i += 1) {
        const status = await recordWorkflowRun(db, {
          clean: true,
          includedWrite: false,
        });
        expect(status.level).toBe(0);
      }

      const promoted = await recordWorkflowRun(db, {
        clean: true,
        includedWrite: false,
      });
      expect(promoted.level).toBe(1);
      expect(promoted.consecutiveCleanRuns).toBe(0);

      const forced = await forcePromoteWorkflow(db);
      expect(forced.level).toBe(2);

      const status = await getWorkflowStatus(db);
      expect(status.level).toBe(2);
      expect(status.nextLevel).toBeNull();
    },
    60_000,
  );

  it(
    "demotes on a dirty run",
    async () => {
      await setWorkflowLevel(db, 2);
      const demoted = await recordWorkflowRun(db, {
        clean: false,
        includedWrite: false,
      });
      expect(demoted.level).toBe(1);
      expect(demoted.consecutiveCleanRuns).toBe(0);
    },
    30_000,
  );
});
