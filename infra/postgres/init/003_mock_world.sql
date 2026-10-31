-- Mock Paytm world. Demo source of truth for tools — not real bank/Paytm ledgers.
-- Handlers scope every read/write by the session customer_id.
-- Idempotent: safe to re-run via npm run db:migrate.

DO $$ BEGIN
  CREATE TYPE mock_payment_status AS ENUM (
    'success',
    'pending',
    'failed',
    'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mock_refund_status AS ENUM (
    'initiated',
    'processing',
    'completed',
    'failed',
    'delayed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mock_recharge_status AS ENUM (
    'success',
    'pending',
    'failed',
    'benefit_pending'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE mock_complaint_status AS ENUM (
    'open',
    'in_progress',
    'waiting_customer',
    'escalated',
    'resolved',
    'closed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS mock_customers (
  id              text PRIMARY KEY,
  display_name    text NOT NULL,
  phone_masked    text NOT NULL,
  account_type    text NOT NULL DEFAULT 'personal',
  kyc_status      text NOT NULL DEFAULT 'verified',
  support_flags   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mock_transactions (
  id                text PRIMARY KEY,
  customer_id       text NOT NULL REFERENCES mock_customers (id),
  amount_paise      bigint NOT NULL CHECK (amount_paise > 0),
  currency          text NOT NULL DEFAULT 'INR',
  status            mock_payment_status NOT NULL,
  channel           text NOT NULL DEFAULT 'upi',
  counterparty_name text,
  bank_reference    text,
  upi_rrn           text,
  failure_code      text,
  description       text,
  occurred_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mock_transactions_customer_occurred_idx
  ON mock_transactions (customer_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS mock_transactions_bank_reference_idx
  ON mock_transactions (bank_reference)
  WHERE bank_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS mock_refunds (
  id              text PRIMARY KEY,
  customer_id     text NOT NULL REFERENCES mock_customers (id),
  transaction_id  text REFERENCES mock_transactions (id),
  amount_paise    bigint NOT NULL CHECK (amount_paise > 0),
  currency        text NOT NULL DEFAULT 'INR',
  status          mock_refund_status NOT NULL,
  reason          text,
  expected_by     date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mock_refunds_customer_idx ON mock_refunds (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mock_recharges (
  id              text PRIMARY KEY,
  customer_id     text NOT NULL REFERENCES mock_customers (id),
  mobile_masked   text NOT NULL,
  operator        text NOT NULL,
  amount_paise    bigint NOT NULL CHECK (amount_paise > 0),
  status          mock_recharge_status NOT NULL,
  provider_ref    text,
  benefit_note    text,
  occurred_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mock_recharges_customer_idx ON mock_recharges (customer_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS mock_complaints (
  id              text PRIMARY KEY,
  customer_id     text NOT NULL REFERENCES mock_customers (id),
  case_id         uuid REFERENCES cases (id),
  category        text NOT NULL,
  status          mock_complaint_status NOT NULL DEFAULT 'open',
  summary         text NOT NULL,
  details         jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_txn_id  text REFERENCES mock_transactions (id),
  related_refund_id text REFERENCES mock_refunds (id),
  escalated_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mock_complaints_customer_idx ON mock_complaints (customer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Seed: Soham, Aditya, Saurabh. Replace prior demo ids if present.
-- ---------------------------------------------------------------------------

DELETE FROM mock_complaints
WHERE customer_id IN ('customer-456', 'customer-789', 'merchant-101');

DELETE FROM mock_recharges
WHERE customer_id IN ('customer-456', 'customer-789', 'merchant-101');

DELETE FROM mock_refunds
WHERE customer_id IN ('customer-456', 'customer-789', 'merchant-101');

DELETE FROM mock_transactions
WHERE customer_id IN ('customer-456', 'customer-789', 'merchant-101');

DELETE FROM mock_customers
WHERE id IN ('customer-456', 'customer-789', 'merchant-101');

INSERT INTO mock_customers (id, display_name, phone_masked, account_type, kyc_status, support_flags)
VALUES
  (
    'customer-soham',
    'Soham',
    '98****3210',
    'personal',
    'verified',
    '{"language":"en","segment":"retail"}'::jsonb
  ),
  (
    'customer-aditya',
    'Aditya',
    '97****1100',
    'personal',
    'pending',
    '{"language":"hi","segment":"retail","login_issues":true}'::jsonb
  ),
  (
    'customer-saurabh',
    'Saurabh',
    '90****4455',
    'personal',
    'verified',
    '{"language":"en","segment":"retail"}'::jsonb
  )
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  phone_masked = EXCLUDED.phone_masked,
  account_type = EXCLUDED.account_type,
  kyc_status = EXCLUDED.kyc_status,
  support_flags = EXCLUDED.support_flags;

INSERT INTO mock_transactions (
  id, customer_id, amount_paise, status, channel, counterparty_name,
  bank_reference, upi_rrn, failure_code, description, occurred_at
)
VALUES
  (
    'txn_upi_1001',
    'customer-soham',
    200000,
    'failed',
    'upi',
    'IRCTC',
    'BANKREF1001',
    'RRN1001FAIL',
    'UPI_TIMEOUT',
    'UPI payment to IRCTC failed after debit attempt',
    now() - interval '1 day'
  ),
  (
    'txn_upi_1002',
    'customer-soham',
    50000,
    'pending',
    'upi',
    'Grocery Mart',
    'BANKREF1002',
    'RRN1002PEND',
    NULL,
    'UPI payment pending at beneficiary bank',
    now() - interval '3 hours'
  ),
  (
    'txn_upi_1003',
    'customer-soham',
    150000,
    'success',
    'upi',
    'Aditya',
    'BANKREF1003',
    'RRN1003OK',
    NULL,
    'Successful P2P UPI transfer to Aditya',
    now() - interval '5 days'
  ),
  (
    'txn_upi_2001',
    'customer-aditya',
    99900,
    'success',
    'upi',
    'Jio Recharge',
    'BANKREF2001',
    'RRN2001OK',
    NULL,
    'Recharge payment collected',
    now() - interval '2 days'
  ),
  (
    'txn_upi_dup_1',
    'customer-soham',
    10000,
    'success',
    'upi',
    'Metro Card',
    'BANKREFDUP1',
    'RRNDUP1',
    NULL,
    'First of a duplicate-looking pair',
    now() - interval '6 hours'
  ),
  (
    'txn_upi_dup_2',
    'customer-soham',
    10000,
    'success',
    'upi',
    'Metro Card',
    'BANKREFDUP2',
    'RRNDUP2',
    NULL,
    'Second of a duplicate-looking pair',
    now() - interval '6 hours' + interval '2 minutes'
  ),
  (
    'txn_upi_3001',
    'customer-saurabh',
    75000,
    'pending',
    'upi',
    'Soham',
    'BANKREF3001',
    'RRN3001PEND',
    NULL,
    'P2P to Soham stuck pending at bank',
    now() - interval '8 hours'
  )
ON CONFLICT (id) DO UPDATE SET
  customer_id = EXCLUDED.customer_id,
  amount_paise = EXCLUDED.amount_paise,
  status = EXCLUDED.status,
  channel = EXCLUDED.channel,
  counterparty_name = EXCLUDED.counterparty_name,
  bank_reference = EXCLUDED.bank_reference,
  upi_rrn = EXCLUDED.upi_rrn,
  failure_code = EXCLUDED.failure_code,
  description = EXCLUDED.description,
  occurred_at = EXCLUDED.occurred_at;

INSERT INTO mock_refunds (
  id, customer_id, transaction_id, amount_paise, status, reason, expected_by
)
VALUES
  (
    'refund_5001',
    'customer-soham',
    'txn_upi_1001',
    200000,
    'delayed',
    'Beneficiary bank reversal not confirmed',
    (current_date + 3)
  ),
  (
    'refund_5002',
    'customer-soham',
    'txn_upi_1003',
    50000,
    'processing',
    'Partial refund inquiry sample',
    (current_date + 1)
  ),
  (
    'refund_5003',
    'customer-aditya',
    'txn_upi_2001',
    99900,
    'initiated',
    'Customer reported benefit not received',
    (current_date + 5)
  )
ON CONFLICT (id) DO UPDATE SET
  customer_id = EXCLUDED.customer_id,
  transaction_id = EXCLUDED.transaction_id,
  amount_paise = EXCLUDED.amount_paise,
  status = EXCLUDED.status,
  reason = EXCLUDED.reason,
  expected_by = EXCLUDED.expected_by,
  updated_at = now();

INSERT INTO mock_recharges (
  id, customer_id, mobile_masked, operator, amount_paise, status, provider_ref, benefit_note, occurred_at
)
VALUES
  (
    'rech_3001',
    'customer-aditya',
    '97****1100',
    'jio',
    99900,
    'benefit_pending',
    'JIOREF3001',
    'Payment success; plan activation pending at operator',
    now() - interval '2 days'
  ),
  (
    'rech_3002',
    'customer-soham',
    '98****3210',
    'airtel',
    29900,
    'failed',
    'AIRREF3002',
    'Operator rejected recharge request',
    now() - interval '12 hours'
  ),
  (
    'rech_3003',
    'customer-saurabh',
    '90****9999',
    'vi',
    19900,
    'pending',
    'VIREF3003',
    'Wrong-number guidance sample (masked destination)',
    now() - interval '1 hour'
  )
ON CONFLICT (id) DO UPDATE SET
  customer_id = EXCLUDED.customer_id,
  mobile_masked = EXCLUDED.mobile_masked,
  operator = EXCLUDED.operator,
  amount_paise = EXCLUDED.amount_paise,
  status = EXCLUDED.status,
  provider_ref = EXCLUDED.provider_ref,
  benefit_note = EXCLUDED.benefit_note,
  occurred_at = EXCLUDED.occurred_at;

INSERT INTO mock_complaints (
  id, customer_id, category, status, summary, details, related_txn_id, related_refund_id
)
VALUES
  (
    'cmp_9001',
    'customer-soham',
    'upi_payment',
    'in_progress',
    'Failed IRCTC UPI payment of ₹2000',
    '[{"at":"seed","note":"Opened from demo seed"}]'::jsonb,
    'txn_upi_1001',
    'refund_5001'
  )
ON CONFLICT (id) DO UPDATE SET
  customer_id = EXCLUDED.customer_id,
  category = EXCLUDED.category,
  status = EXCLUDED.status,
  summary = EXCLUDED.summary,
  details = EXCLUDED.details,
  related_txn_id = EXCLUDED.related_txn_id,
  related_refund_id = EXCLUDED.related_refund_id,
  updated_at = now();
