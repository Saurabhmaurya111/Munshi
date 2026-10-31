-- Workflow promotion counters. Idempotent.

ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS write_clean_runs integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS workflows_name_uidx ON workflows (name);

INSERT INTO workflows (name, plan, level, consecutive_clean_runs, write_clean_runs)
VALUES (
  'default',
  '{"kind":"default","description":"Global Munshi support workflow"}'::jsonb,
  0,
  0,
  0
)
ON CONFLICT (name) DO NOTHING;
