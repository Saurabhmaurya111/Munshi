-- Core case tables. Contract: backend_infra_handoff.md section 5.
-- Idempotent: safe to re-run via npm run db:migrate.

DO $$ BEGIN
  CREATE TYPE ownership_state AS ENUM (
    'AI_ACTIVE',
    'WAITING_EXTERNAL',
    'PENDING_APPROVAL',
    'HUMAN_OWNED',
    'CLOSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE event_audience AS ENUM (
    'customer',
    'desk',
    'internal'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE intent_state AS ENUM (
    'intended',
    'sent',
    'confirmed',
    'failed',
    'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE tool_risk AS ENUM (
    'read',
    'write',
    'money'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status          text NOT NULL DEFAULT 'open',
  ownership       ownership_state NOT NULL DEFAULT 'AI_ACTIVE',
  lease_owner     text,
  lease_expires_at timestamptz,
  epoch           bigint NOT NULL DEFAULT 0,
  wake_at         timestamptz,
  priority        integer NOT NULL DEFAULT 0,
  customer_id     text NOT NULL,
  last_event_seq  bigint NOT NULL DEFAULT 0,
  runnable        boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waiting_requires_wake_at CHECK (
    ownership <> 'WAITING_EXTERNAL' OR wake_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS cases_runnable_priority_idx
  ON cases (priority DESC, updated_at ASC)
  WHERE runnable = true AND ownership = 'AI_ACTIVE';

CREATE INDEX IF NOT EXISTS cases_wake_at_idx
  ON cases (wake_at)
  WHERE wake_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS cases_customer_id_idx ON cases (customer_id);

CREATE TABLE IF NOT EXISTS case_events (
  id          bigserial PRIMARY KEY,
  case_id     uuid NOT NULL REFERENCES cases (id),
  seq         bigint NOT NULL,
  type        text NOT NULL,
  audience    event_audience NOT NULL DEFAULT 'internal',
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, seq)
);

CREATE INDEX IF NOT EXISTS case_events_case_seq_idx ON case_events (case_id, seq);

CREATE TABLE IF NOT EXISTS case_facts (
  case_id     uuid NOT NULL REFERENCES cases (id),
  key         text NOT NULL,
  value       jsonb NOT NULL,
  source_tool text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, key)
);

CREATE TABLE IF NOT EXISTS action_intents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL REFERENCES cases (id),
  step_id          text NOT NULL,
  tool             text NOT NULL,
  idempotency_key  text NOT NULL,
  state            intent_state NOT NULL DEFAULT 'intended',
  args             jsonb NOT NULL DEFAULT '{}'::jsonb,
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key),
  UNIQUE (case_id, step_id)
);

CREATE INDEX IF NOT EXISTS action_intents_unknown_idx
  ON action_intents (updated_at)
  WHERE state = 'unknown';

CREATE TABLE IF NOT EXISTS tools (
  name           text PRIMARY KEY,
  description    text NOT NULL,
  input_schema   jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema  jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk           tool_risk NOT NULL,
  domain_pack    text NOT NULL,
  handler_name   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflows (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  plan                    jsonb NOT NULL,
  level                   smallint NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 2),
  consecutive_clean_runs  integer NOT NULL DEFAULT 0,
  policy_version          text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_chunks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      text NOT NULL,
  document_title   text NOT NULL,
  source           text NOT NULL,
  content          text NOT NULL,
  chunk_index      integer NOT NULL,
  document_version text NOT NULL,
  effective_from   date,
  effective_to     date,
  category         text,
  language         text NOT NULL DEFAULT 'en',
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding        vector(1536),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, document_version, chunk_index)
);

CREATE INDEX IF NOT EXISTS policy_chunks_document_idx
  ON policy_chunks (document_id, document_version);
