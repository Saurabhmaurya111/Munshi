-- Paytm wallet mock: balance + destination for refunds into wallet.
-- Idempotent: safe to re-run via npm run db:migrate.

DO $$ BEGIN
  CREATE TYPE mock_wallet_status AS ENUM (
    'active',
    'frozen',
    'limited'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS mock_wallets (
  customer_id     text PRIMARY KEY REFERENCES mock_customers (id),
  balance_paise   bigint NOT NULL CHECK (balance_paise >= 0),
  currency        text NOT NULL DEFAULT 'INR',
  status          mock_wallet_status NOT NULL DEFAULT 'active',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mock_refunds
  ADD COLUMN IF NOT EXISTS destination text NOT NULL DEFAULT 'bank';

DO $$ BEGIN
  ALTER TABLE mock_refunds
    ADD CONSTRAINT mock_refunds_destination_check
    CHECK (destination IN ('wallet', 'bank'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Seed wallets + wallet-channel payments + wallet-bound refunds
-- ---------------------------------------------------------------------------

INSERT INTO mock_wallets (customer_id, balance_paise, currency, status, updated_at)
VALUES
  ('customer-soham', 125000, 'INR', 'active', now()),
  ('customer-aditya', 45000, 'INR', 'limited', now()),
  ('customer-saurabh', 89000, 'INR', 'active', now())
ON CONFLICT (customer_id) DO UPDATE SET
  balance_paise = EXCLUDED.balance_paise,
  currency = EXCLUDED.currency,
  status = EXCLUDED.status,
  updated_at = EXCLUDED.updated_at;

INSERT INTO mock_transactions (
  id, customer_id, amount_paise, status, channel, counterparty_name,
  bank_reference, upi_rrn, failure_code, description, occurred_at
)
VALUES
  (
    'txn_wal_4001',
    'customer-soham',
    30000,
    'success',
    'wallet',
    'Paytm Mall',
    NULL,
    NULL,
    NULL,
    'Wallet payment at Paytm Mall',
    now() - interval '2 days'
  ),
  (
    'txn_wal_4002',
    'customer-soham',
    15000,
    'failed',
    'wallet',
    'Movie Tickets',
    NULL,
    NULL,
    'WALLET_INSUFFICIENT',
    'Wallet payment failed — insufficient balance at charge time',
    now() - interval '10 hours'
  ),
  (
    'txn_wal_upi_4003',
    'customer-soham',
    75000,
    'success',
    'upi',
    'Add Money to Wallet',
    'BANKREFWAL4003',
    'RRNWAL4003',
    NULL,
    'UPI add-money into Paytm wallet',
    now() - interval '4 days'
  ),
  (
    'txn_wal_5001',
    'customer-saurabh',
    20000,
    'pending',
    'wallet',
    'Bus Booking',
    NULL,
    NULL,
    NULL,
    'Wallet payment pending with merchant',
    now() - interval '90 minutes'
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
  id, customer_id, transaction_id, amount_paise, status, reason, expected_by, destination
)
VALUES
  (
    'refund_wal_6001',
    'customer-soham',
    'txn_wal_4002',
    15000,
    'completed',
    'Failed wallet charge auto-reversed to wallet',
    current_date,
    'wallet'
  ),
  (
    'refund_wal_6002',
    'customer-soham',
    'txn_upi_1001',
    200000,
    'processing',
    'IRCTC UPI failure — refund path to wallet',
    (current_date + 2),
    'wallet'
  ),
  (
    'refund_wal_6003',
    'customer-saurabh',
    'txn_wal_5001',
    20000,
    'initiated',
    'Pending wallet merchant payment under review',
    (current_date + 4),
    'wallet'
  )
ON CONFLICT (id) DO UPDATE SET
  customer_id = EXCLUDED.customer_id,
  transaction_id = EXCLUDED.transaction_id,
  amount_paise = EXCLUDED.amount_paise,
  status = EXCLUDED.status,
  reason = EXCLUDED.reason,
  expected_by = EXCLUDED.expected_by,
  destination = EXCLUDED.destination,
  updated_at = now();

-- Mark the delayed UPI refund sample as bank-bound (existing row).
UPDATE mock_refunds
SET destination = 'bank'
WHERE id IN ('refund_5001', 'refund_5002', 'refund_5003')
  AND destination IS DISTINCT FROM 'bank';
