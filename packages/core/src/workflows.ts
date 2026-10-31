import type { Db } from "./db.js";
import { CoreError } from "./types.js";

export const DEFAULT_WORKFLOW_NAME = "default";
export const PROMOTION_CLEAN_RUNS = 20;

export type WorkflowLevel = 0 | 1 | 2;

export type WorkflowRow = {
  id: string;
  name: string;
  level: WorkflowLevel;
  consecutiveCleanRuns: number;
  writeCleanRuns: number;
  updatedAt: Date;
};

type WorkflowDbRow = {
  id: string;
  name: string;
  level: number;
  consecutive_clean_runs: number;
  write_clean_runs: number;
  updated_at: Date;
};

function mapWorkflow(row: WorkflowDbRow): WorkflowRow {
  const level = Math.min(2, Math.max(0, Number(row.level))) as WorkflowLevel;
  return {
    id: row.id,
    name: row.name,
    level,
    consecutiveCleanRuns: Number(row.consecutive_clean_runs) || 0,
    writeCleanRuns: Number(row.write_clean_runs) || 0,
    updatedAt: row.updated_at,
  };
}

function progressTowardNext(workflow: WorkflowRow): {
  nextLevel: WorkflowLevel | null;
  required: number;
  current: number;
} {
  if (workflow.level >= 2) {
    return { nextLevel: null, required: PROMOTION_CLEAN_RUNS, current: PROMOTION_CLEAN_RUNS };
  }
  if (workflow.level === 0) {
    return {
      nextLevel: 1,
      required: PROMOTION_CLEAN_RUNS,
      current: workflow.consecutiveCleanRuns,
    };
  }
  return {
    nextLevel: 2,
    required: PROMOTION_CLEAN_RUNS,
    current: workflow.writeCleanRuns,
  };
}

export type WorkflowStatus = WorkflowRow & {
  promotionThreshold: number;
  progress: number;
  nextLevel: WorkflowLevel | null;
  runsToNext: number;
};

function toStatus(workflow: WorkflowRow): WorkflowStatus {
  const progressInfo = progressTowardNext(workflow);
  const progress = Math.min(progressInfo.required, progressInfo.current);
  return {
    ...workflow,
    promotionThreshold: PROMOTION_CLEAN_RUNS,
    progress,
    nextLevel: progressInfo.nextLevel,
    runsToNext:
      progressInfo.nextLevel === null
        ? 0
        : Math.max(0, progressInfo.required - progress),
  };
}

/** Domain workflows desk can promote independently of each other. */
export const KNOWN_WORKFLOWS: ReadonlyArray<{
  name: string;
  description: string;
}> = [
  { name: DEFAULT_WORKFLOW_NAME, description: "Global Munshi support workflow" },
  { name: "upi", description: "UPI payment status and failures" },
  { name: "refund", description: "Refund tracking and delays" },
  { name: "recharge", description: "Mobile / DTH recharge issues" },
  { name: "wallet", description: "Wallet balance and payments" },
  { name: "complaint", description: "Complaint create / escalate writes" },
  { name: "account", description: "Account and KYC questions" },
];

export async function ensureWorkflow(
  db: Db,
  name: string,
  description?: string,
): Promise<WorkflowRow> {
  const known = KNOWN_WORKFLOWS.find((item) => item.name === name);
  await db.query(
    `INSERT INTO workflows (name, plan, level, consecutive_clean_runs, write_clean_runs)
     VALUES ($1, $2::jsonb, 0, 0, 0)
     ON CONFLICT (name) DO NOTHING`,
    [
      name,
      JSON.stringify({
        kind: name,
        description: description ?? known?.description ?? name,
      }),
    ],
  );

  return getWorkflowByName(db, name);
}

export async function ensureDefaultWorkflow(db: Db): Promise<WorkflowRow> {
  return ensureWorkflow(db, DEFAULT_WORKFLOW_NAME);
}

export async function ensureKnownWorkflows(db: Db): Promise<WorkflowRow[]> {
  const rows: WorkflowRow[] = [];
  for (const known of KNOWN_WORKFLOWS) {
    rows.push(await ensureWorkflow(db, known.name, known.description));
  }
  return rows;
}

export async function listWorkflowStatuses(db: Db): Promise<WorkflowStatus[]> {
  await ensureKnownWorkflows(db);
  const result = await db.query<WorkflowDbRow>(
    `SELECT id, name, level, consecutive_clean_runs,
            COALESCE(write_clean_runs, 0) AS write_clean_runs, updated_at
     FROM workflows
     ORDER BY
       CASE name
         WHEN 'default' THEN 0
         WHEN 'upi' THEN 1
         WHEN 'refund' THEN 2
         WHEN 'recharge' THEN 3
         WHEN 'wallet' THEN 4
         WHEN 'complaint' THEN 5
         WHEN 'account' THEN 6
         ELSE 50
       END,
       name ASC`,
  );
  return result.rows.map((row) => toStatus(mapWorkflow(row)));
}

export async function getWorkflowStatus(
  db: Db,
  name = DEFAULT_WORKFLOW_NAME,
): Promise<WorkflowStatus> {
  const workflow = await ensureWorkflow(db, name);
  return toStatus(workflow);
}

async function getWorkflowByName(db: Db, name: string): Promise<WorkflowRow> {
  const result = await db.query<WorkflowDbRow>(
    `SELECT id, name, level, consecutive_clean_runs,
            COALESCE(write_clean_runs, 0) AS write_clean_runs, updated_at
     FROM workflows
     WHERE name = $1
     LIMIT 1`,
    [name],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError("Workflow not found", "NOT_FOUND");
  }
  return mapWorkflow(row);
}

export type WorkflowRunOutcome = {
  clean: boolean;
  includedWrite: boolean;
};

/**
 * Record one turn against the workflow.
 * Level 0→1 after 20 consecutive clean runs.
 * Level 1→2 after 20 consecutive clean runs that include the write path.
 * Any dirty run demotes one level and resets counters.
 */
export async function recordWorkflowRun(
  db: Db,
  outcome: WorkflowRunOutcome,
  name = DEFAULT_WORKFLOW_NAME,
): Promise<WorkflowStatus> {
  await ensureDefaultWorkflow(db);

  return (async () => {
    const current = await getWorkflowByName(db, name);

    if (!outcome.clean) {
      const nextLevel = Math.max(0, current.level - 1) as WorkflowLevel;
      const result = await db.query<WorkflowDbRow>(
        `UPDATE workflows
         SET level = $2,
             consecutive_clean_runs = 0,
             write_clean_runs = 0,
             updated_at = now()
         WHERE name = $1
         RETURNING id, name, level, consecutive_clean_runs,
                   COALESCE(write_clean_runs, 0) AS write_clean_runs, updated_at`,
        [name, nextLevel],
      );
      return toStatus(mapWorkflow(result.rows[0]!));
    }

    if (current.level === 0) {
      const clean = current.consecutiveCleanRuns + 1;
      if (clean >= PROMOTION_CLEAN_RUNS) {
        const result = await db.query<WorkflowDbRow>(
          `UPDATE workflows
           SET level = 1,
               consecutive_clean_runs = 0,
               write_clean_runs = 0,
               updated_at = now()
           WHERE name = $1
           RETURNING id, name, level, consecutive_clean_runs,
                     COALESCE(write_clean_runs, 0) AS write_clean_runs, updated_at`,
          [name],
        );
        return toStatus(mapWorkflow(result.rows[0]!));
      }
      const result = await db.query<WorkflowDbRow>(
        `UPDATE workflows
         SET consecutive_clean_runs = $2,
             updated_at = now()
         WHERE name = $1
         RETURNING id, name, level, consecutive_clean_runs,
                   COALESCE(write_clean_runs, 0) AS write_clean_runs, updated_at`,
        [name, clean],
      );
      return toStatus(mapWorkflow(result.rows[0]!));
    }

    if (current.level === 1) {
      if (!outcome.includedWrite) {
        const result = await db.query<WorkflowDbRow>(
          `UPDATE workflows
           SET consecutive_clean_runs = consecutive_clean_runs + 1,
               updated_at = now()
           WHERE name = $1
           RETURNING id, name, level, consecutive_clean_runs,
                     COALESCE(write_clean_runs, 0) AS write_clean_runs, updated_at`,
          [name],
        );
        return toStatus(mapWorkflow(result.rows[0]!));
      }
      const writeClean = current.writeCleanRuns + 1;
      if (writeClean >= PROMOTION_CLEAN_RUNS) {
        const result = await db.query<WorkflowDbRow>(
          `UPDATE workflows
           SET level = 2,
               consecutive_clean_runs = 0,
               write_clean_runs = 0,
               updated_at = now()
           WHERE name = $1
           RETURNING id, name, level, consecutive_clean_runs,
                     COALESCE(write_clean_runs, 0) AS write_clean_runs, updated_at`,
          [name],
        );
        return toStatus(mapWorkflow(result.rows[0]!));
      }
      const result = await db.query<WorkflowDbRow>(
        `UPDATE workflows
         SET write_clean_runs = $2,
             consecutive_clean_runs = consecutive_clean_runs + 1,
             updated_at = now()
         WHERE name = $1
         RETURNING id, name, level, consecutive_clean_runs,
                   COALESCE(write_clean_runs, 0) AS write_clean_runs, updated_at`,
        [name, writeClean],
      );
      return toStatus(mapWorkflow(result.rows[0]!));
    }

    // Already level 2: keep a rolling clean counter for visibility.
    const result = await db.query<WorkflowDbRow>(
      `UPDATE workflows
       SET consecutive_clean_runs = consecutive_clean_runs + 1,
           updated_at = now()
       WHERE name = $1
       RETURNING id, name, level, consecutive_clean_runs,
                 COALESCE(write_clean_runs, 0) AS write_clean_runs, updated_at`,
      [name],
    );
    return toStatus(mapWorkflow(result.rows[0]!));
  })();
}

/**
 * Bump one level (or stay at 2) and reset counters.
 * Forward-looking only: does not mutate cases, leases, or parked intents.
 * In-flight turns keep their snapshotted level; PENDING_APPROVAL stays parked.
 */
export async function forcePromoteWorkflow(
  db: Db,
  name = DEFAULT_WORKFLOW_NAME,
): Promise<WorkflowStatus> {
  await ensureWorkflow(db, name);
  const current = await getWorkflowByName(db, name);
  const nextLevel = Math.min(2, current.level + 1) as WorkflowLevel;
  const result = await db.query<WorkflowDbRow>(
    `UPDATE workflows
     SET level = $2,
         consecutive_clean_runs = 0,
         write_clean_runs = 0,
         updated_at = now()
     WHERE name = $1
     RETURNING id, name, level, consecutive_clean_runs,
               COALESCE(write_clean_runs, 0) AS write_clean_runs, updated_at`,
    [name, nextLevel],
  );
  return toStatus(mapWorkflow(result.rows[0]!));
}

/** Testing helper: set an exact level. */
export async function setWorkflowLevel(
  db: Db,
  level: WorkflowLevel,
  name = DEFAULT_WORKFLOW_NAME,
): Promise<WorkflowStatus> {
  await ensureWorkflow(db, name);
  const result = await db.query<WorkflowDbRow>(
    `UPDATE workflows
     SET level = $2,
         consecutive_clean_runs = 0,
         write_clean_runs = 0,
         updated_at = now()
     WHERE name = $1
     RETURNING id, name, level, consecutive_clean_runs,
               COALESCE(write_clean_runs, 0) AS write_clean_runs, updated_at`,
    [name, level],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CoreError("Workflow not found", "NOT_FOUND");
  }
  return toStatus(mapWorkflow(row));
}
