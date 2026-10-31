import {
  amountToPaise,
  relativeDateRange,
  throwIfAborted,
  type RelativeDate,
} from "./filters.js";
import type { HandlerResult, Queryable, ToolHandler } from "./types.js";

type TxnRow = {
  id: string;
  customer_id: string;
  amount_paise: string;
  currency: string;
  status: string;
  channel: string;
  counterparty_name: string | null;
  bank_reference: string | null;
  upi_rrn: string | null;
  failure_code: string | null;
  description: string | null;
  occurred_at: Date;
};

type RefundRow = {
  id: string;
  customer_id: string;
  transaction_id: string | null;
  amount_paise: string;
  currency: string;
  status: string;
  reason: string | null;
  expected_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type RechargeRow = {
  id: string;
  customer_id: string;
  mobile_masked: string;
  operator: string;
  amount_paise: string;
  currency: string;
  status: string;
  provider_ref: string | null;
  benefit_note: string | null;
  occurred_at: Date;
};

type CustomerRow = {
  id: string;
  display_name: string;
  phone_masked: string;
  account_type: string;
  kyc_status: string;
  support_flags: Record<string, unknown>;
};

type ComplaintRow = {
  id: string;
  customer_id: string;
  category: string;
  status: string;
  summary: string;
  details: unknown;
  related_txn_id: string | null;
  related_refund_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapTxn(row: TxnRow) {
  return {
    transactionId: row.id,
    customerId: row.customer_id,
    amountPaise: Number(row.amount_paise),
    currency: row.currency,
    status: row.status,
    channel: row.channel,
    counterpartyName: row.counterparty_name,
    bankReference: row.bank_reference,
    upiRrn: row.upi_rrn,
    failureCode: row.failure_code,
    description: row.description,
    occurredAt: row.occurred_at.toISOString(),
  };
}

function mapRefund(row: RefundRow) {
  return {
    refundId: row.id,
    customerId: row.customer_id,
    transactionId: row.transaction_id,
    amountPaise: Number(row.amount_paise),
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    expectedBy: row.expected_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapRecharge(row: RechargeRow) {
  return {
    rechargeId: row.id,
    customerId: row.customer_id,
    mobileMasked: row.mobile_masked,
    operator: row.operator,
    amountPaise: Number(row.amount_paise),
    currency: row.currency,
    status: row.status,
    providerRef: row.provider_ref,
    benefitNote: row.benefit_note,
    occurredAt: row.occurred_at.toISOString(),
  };
}

function notFound(entity: string): HandlerResult {
  return {
    ok: false,
    errorCode: "NOT_FOUND",
    message: `${entity} not found for this customer`,
  };
}

export function createMockWorldHandlers(db: Queryable): Record<string, ToolHandler> {
  const getTransactions: ToolHandler = async ({ customerId, args, signal }) => {
    throwIfAborted(signal);
    const clauses = ["customer_id = $1"];
    const params: unknown[] = [customerId];

    if (typeof args.amount === "number") {
      params.push(amountToPaise(args.amount));
      clauses.push(`amount_paise = $${params.length}`);
    }
    if (typeof args.relativeDate === "string") {
      const { from, to } = relativeDateRange(args.relativeDate as RelativeDate);
      params.push(from.toISOString(), to.toISOString());
      clauses.push(
        `occurred_at >= $${params.length - 1} AND occurred_at < $${params.length}`,
      );
    }

    const result = await db.query<TxnRow>(
      `SELECT * FROM mock_transactions
       WHERE ${clauses.join(" AND ")}
       ORDER BY occurred_at DESC
       LIMIT 50`,
      params,
    );
    throwIfAborted(signal);
    return { ok: true, data: { transactions: result.rows.map(mapTxn) } };
  };

  const getTransactionStatus: ToolHandler = async ({
    customerId,
    args,
    signal,
  }) => {
    throwIfAborted(signal);
    const transactionId = String(args.transactionId ?? "");
    const result = await db.query<TxnRow>(
      `SELECT * FROM mock_transactions
       WHERE id = $1 AND customer_id = $2
       LIMIT 1`,
      [transactionId, customerId],
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (!row) return notFound("transaction");
    return { ok: true, data: mapTxn(row) };
  };

  const getBankReference: ToolHandler = async ({ customerId, args, signal }) => {
    throwIfAborted(signal);
    const transactionId = String(args.transactionId ?? "");
    const result = await db.query<TxnRow>(
      `SELECT * FROM mock_transactions
       WHERE id = $1 AND customer_id = $2
       LIMIT 1`,
      [transactionId, customerId],
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (!row) return notFound("transaction");
    return {
      ok: true,
      data: {
        transactionId: row.id,
        bankReference: row.bank_reference,
        upiRrn: row.upi_rrn,
        status: row.status,
      },
    };
  };

  const getRefundStatus: ToolHandler = async ({ customerId, args, signal }) => {
    throwIfAborted(signal);
    const clauses = ["customer_id = $1"];
    const params: unknown[] = [customerId];

    if (typeof args.refundId === "string") {
      params.push(args.refundId);
      clauses.push(`id = $${params.length}`);
    }
    if (typeof args.transactionId === "string") {
      params.push(args.transactionId);
      clauses.push(`transaction_id = $${params.length}`);
    }
    if (typeof args.amount === "number") {
      params.push(amountToPaise(args.amount));
      clauses.push(`amount_paise = $${params.length}`);
    }
    if (typeof args.relativeDate === "string") {
      const { from, to } = relativeDateRange(args.relativeDate as RelativeDate);
      params.push(from.toISOString(), to.toISOString());
      clauses.push(
        `created_at >= $${params.length - 1} AND created_at < $${params.length}`,
      );
    }

    const result = await db.query<RefundRow>(
      `SELECT * FROM mock_refunds
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT 20`,
      params,
    );
    throwIfAborted(signal);
    if (result.rows.length === 0) return notFound("refund");
    return { ok: true, data: { refunds: result.rows.map(mapRefund) } };
  };

  const getRefundDetails: ToolHandler = async ({ customerId, args, signal }) => {
    throwIfAborted(signal);
    const refundId = String(args.refundId ?? "");
    const result = await db.query<RefundRow>(
      `SELECT * FROM mock_refunds
       WHERE id = $1 AND customer_id = $2
       LIMIT 1`,
      [refundId, customerId],
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (!row) return notFound("refund");
    return { ok: true, data: mapRefund(row) };
  };

  const getRechargeStatus: ToolHandler = async ({
    customerId,
    args,
    signal,
  }) => {
    throwIfAborted(signal);
    const clauses = ["customer_id = $1"];
    const params: unknown[] = [customerId];

    if (typeof args.transactionId === "string") {
      // Seed links recharge to payment via provider / related patterns; also match id.
      params.push(args.transactionId);
      clauses.push(
        `(id = $${params.length} OR provider_ref = $${params.length})`,
      );
    }
    if (typeof args.rechargeNumber === "string") {
      // Match last 4 digits against masked mobile when full number given.
      const last4 = args.rechargeNumber.slice(-4);
      params.push(`%${last4}`);
      clauses.push(`mobile_masked LIKE $${params.length}`);
    }
    if (typeof args.amount === "number") {
      params.push(amountToPaise(args.amount));
      clauses.push(`amount_paise = $${params.length}`);
    }
    if (typeof args.relativeDate === "string") {
      const { from, to } = relativeDateRange(args.relativeDate as RelativeDate);
      params.push(from.toISOString(), to.toISOString());
      clauses.push(
        `occurred_at >= $${params.length - 1} AND occurred_at < $${params.length}`,
      );
    }

    const result = await db.query<RechargeRow>(
      `SELECT * FROM mock_recharges
       WHERE ${clauses.join(" AND ")}
       ORDER BY occurred_at DESC
       LIMIT 20`,
      params,
    );
    throwIfAborted(signal);
    if (result.rows.length === 0) return notFound("recharge");
    return { ok: true, data: { recharges: result.rows.map(mapRecharge) } };
  };

  const getRechargeDetails: ToolHandler = async ({
    customerId,
    args,
    signal,
  }) => {
    throwIfAborted(signal);
    const transactionId = String(args.transactionId ?? "");
    const result = await db.query<RechargeRow>(
      `SELECT * FROM mock_recharges
       WHERE customer_id = $1
         AND (id = $2 OR provider_ref = $2)
       LIMIT 1`,
      [customerId, transactionId],
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (!row) return notFound("recharge");
    return { ok: true, data: mapRecharge(row) };
  };

  const getAccountSupportStatus: ToolHandler = async ({
    customerId,
    signal,
  }) => {
    throwIfAborted(signal);
    const result = await db.query<CustomerRow>(
      `SELECT * FROM mock_customers WHERE id = $1 LIMIT 1`,
      [customerId],
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (!row) return notFound("account");
    return {
      ok: true,
      data: {
        customerId: row.id,
        displayName: row.display_name,
        phoneMasked: row.phone_masked,
        accountType: row.account_type,
        kycStatus: row.kyc_status,
        supportFlags: row.support_flags ?? {},
      },
    };
  };

  const getComplaintStatus: ToolHandler = async ({
    customerId,
    args,
    signal,
  }) => {
    throwIfAborted(signal);
    const complaintId = String(args.complaintId ?? "");
    const result = await db.query<ComplaintRow>(
      `SELECT * FROM mock_complaints
       WHERE id = $1 AND customer_id = $2
       LIMIT 1`,
      [complaintId, customerId],
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (!row) return notFound("complaint");
    return {
      ok: true,
      data: {
        complaintId: row.id,
        customerId: row.customer_id,
        category: row.category,
        status: row.status,
        summary: row.summary,
        details: row.details,
        relatedTxnId: row.related_txn_id,
        relatedRefundId: row.related_refund_id,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      },
    };
  };

  return {
    getTransactions,
    getTransactionStatus,
    getBankReference,
    getRefundStatus,
    getRefundDetails,
    getRechargeStatus,
    getRechargeDetails,
    getAccountSupportStatus,
    getComplaintStatus,
  };
}
