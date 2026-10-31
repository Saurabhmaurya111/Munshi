-- B5–B8 runtime: virtual clock + mock tool outcomes for reconciler.
-- Idempotent: safe to re-run via npm run db:migrate.

CREATE TABLE IF NOT EXISTS demo_clock (
  id      smallint PRIMARY KEY CHECK (id = 1),
  now_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO demo_clock (id, now_at)
VALUES (1, now())
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS mock_tool_outcomes (
  idempotency_key  text PRIMARY KEY,
  tool             text NOT NULL,
  customer_id      text NOT NULL,
  state            text NOT NULL CHECK (state IN ('confirmed', 'failed', 'unknown')),
  data             jsonb,
  error_code       text,
  message          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mock_tool_outcomes_customer_idx
  ON mock_tool_outcomes (customer_id, updated_at DESC);
