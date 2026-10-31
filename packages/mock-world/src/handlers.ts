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

type WalletRow = {
  customer_id: string;
  balance_paise: string;
  currency: string;
  status: string;
  updated_at: Date;
};

type WalletRefundRow = RefundRow & {
  destination: string;
};

type ComplaintRow = {
  id: string;
  customer_id: string;
  case_id: string | null;
  category: string;
  status: string;
  summary: string;
  details: unknown;
  related_txn_id: string | null;
  related_refund_id: string | null;
  escalated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function mapComplaint(row: ComplaintRow) {
  return {
    complaintId: row.id,
    customerId: row.customer_id,
    caseId: row.case_id,
    category: row.category,
    status: row.status,
    summary: row.summary,
    details: row.details,
    relatedTxnId: row.related_txn_id,
    relatedRefundId: row.related_refund_id,
    escalatedAt: row.escalated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function newComplaintId(): string {
  return `cmp_${Math.random().toString(16).slice(2, 10)}`;
}

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

function mapRefund(row: RefundRow | WalletRefundRow) {
  const destination =
    "destination" in row && typeof row.destination === "string"
      ? row.destination
      : undefined;

  return {
    refundId: row.id,
    customerId: row.customer_id,
    transactionId: row.transaction_id,
    amountPaise: Number(row.amount_paise),
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    expectedBy: row.expected_by,
    ...(destination ? { destination } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapWallet(row: WalletRow) {
  return {
    customerId: row.customer_id,
    balancePaise: Number(row.balance_paise),
    balanceRupees: Number(row.balance_paise) / 100,
    currency: row.currency,
    status: row.status,
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
    return { ok: true, data: mapComplaint(row) };
  };

  const createComplaint: ToolHandler = async ({ customerId, args, signal }) => {
    throwIfAborted(signal);
    const category = String(args.category ?? "complaint");
    const summary = String(args.summary ?? "").trim();
    if (!summary) {
      return {
        ok: false,
        errorCode: "BAD_REQUEST",
        message: "summary is required",
      };
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      throwIfAborted(signal);
      const complaintId = newComplaintId();
      try {
        const result = await db.query<ComplaintRow>(
          `INSERT INTO mock_complaints (
             id, customer_id, category, status, summary, details
           ) VALUES (
             $1, $2, $3, 'open'::mock_complaint_status, $4, '[]'::jsonb
           )
           RETURNING *`,
          [complaintId, customerId, category, summary.slice(0, 500)],
        );
        throwIfAborted(signal);
        const row = result.rows[0];
        if (!row) {
          return {
            ok: false,
            errorCode: "CONFLICT",
            message: "Failed to create complaint",
          };
        }
        return {
          ok: true,
          data: { ...mapComplaint(row), status: "created" },
        };
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "";
        if (code === "23505") continue;
        throw error;
      }
    }

    return {
      ok: false,
      errorCode: "CONFLICT",
      message: "Failed to allocate complaint id",
    };
  };

  const addComplaintDetails: ToolHandler = async ({
    customerId,
    args,
    signal,
  }) => {
    throwIfAborted(signal);
    const complaintId = String(args.complaintId ?? "");
    const details = String(args.details ?? "").trim();
    if (!details) {
      return {
        ok: false,
        errorCode: "BAD_REQUEST",
        message: "details is required",
      };
    }

    const result = await db.query<ComplaintRow>(
      `UPDATE mock_complaints
       SET details = COALESCE(details, '[]'::jsonb) || $3::jsonb,
           updated_at = now()
       WHERE id = $1 AND customer_id = $2
       RETURNING *`,
      [
        complaintId,
        customerId,
        JSON.stringify([
          { at: new Date().toISOString(), note: details.slice(0, 500) },
        ]),
      ],
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (!row) return notFound("complaint");
    return { ok: true, data: mapComplaint(row) };
  };

  const escalateComplaint: ToolHandler = async ({
    customerId,
    args,
    signal,
  }) => {
    throwIfAborted(signal);
    const complaintId = String(args.complaintId ?? "");
    const reason = String(args.reason ?? "").trim();
    if (!reason) {
      return {
        ok: false,
        errorCode: "BAD_REQUEST",
        message: "reason is required",
      };
    }

    const result = await db.query<ComplaintRow>(
      `UPDATE mock_complaints
       SET status = 'escalated'::mock_complaint_status,
           escalated_at = COALESCE(escalated_at, now()),
           details = COALESCE(details, '[]'::jsonb) || $3::jsonb,
           updated_at = now()
       WHERE id = $1 AND customer_id = $2
       RETURNING *`,
      [
        complaintId,
        customerId,
        JSON.stringify([
          {
            at: new Date().toISOString(),
            note: reason.slice(0, 500),
            source: "escalateComplaint",
          },
        ]),
      ],
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (!row) return notFound("complaint");
    return { ok: true, data: mapComplaint(row) };
  };

  const getWalletBalance: ToolHandler = async ({ customerId, signal }) => {
    throwIfAborted(signal);
    const result = await db.query<WalletRow>(
      `SELECT * FROM mock_wallets WHERE customer_id = $1 LIMIT 1`,
      [customerId],
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (!row) return notFound("wallet");
    return { ok: true, data: mapWallet(row) };
  };

  const getWalletPayments: ToolHandler = async ({
    customerId,
    args,
    signal,
  }) => {
    throwIfAborted(signal);
    const clauses = ["customer_id = $1"];
    const params: unknown[] = [customerId];

    const channel =
      typeof args.channel === "string" && args.channel !== "all"
        ? args.channel
        : null;

    if (channel === "upi" || channel === "wallet") {
      params.push(channel);
      clauses.push(`channel = $${params.length}`);
    } else {
      clauses.push(`channel IN ('wallet', 'upi')`);
    }

    if (typeof args.transactionId === "string") {
      params.push(args.transactionId);
      clauses.push(`id = $${params.length}`);
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

    const result = await db.query<TxnRow>(
      `SELECT * FROM mock_transactions
       WHERE ${clauses.join(" AND ")}
       ORDER BY occurred_at DESC
       LIMIT 50`,
      params,
    );
    throwIfAborted(signal);
    return { ok: true, data: { payments: result.rows.map(mapTxn) } };
  };

  const getWalletPaymentStatus: ToolHandler = async ({
    customerId,
    args,
    signal,
  }) => {
    throwIfAborted(signal);
    const transactionId = String(args.transactionId ?? "");
    const result = await db.query<TxnRow>(
      `SELECT * FROM mock_transactions
       WHERE id = $1 AND customer_id = $2
         AND channel IN ('wallet', 'upi')
       LIMIT 1`,
      [transactionId, customerId],
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (!row) return notFound("wallet payment");
    return { ok: true, data: mapTxn(row) };
  };

  const getWalletRefundStatus: ToolHandler = async ({
    customerId,
    args,
    signal,
  }) => {
    throwIfAborted(signal);
    const clauses = ["customer_id = $1", "destination = 'wallet'"];
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

    const result = await db.query<WalletRefundRow>(
      `SELECT * FROM mock_refunds
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT 20`,
      params,
    );
    throwIfAborted(signal);
    if (result.rows.length === 0) return notFound("wallet refund");
    return { ok: true, data: { refunds: result.rows.map(mapRefund) } };
  };

  const getWalletRefundDetails: ToolHandler = async ({
    customerId,
    args,
    signal,
  }) => {
    throwIfAborted(signal);
    const refundId = String(args.refundId ?? "");
    const result = await db.query<WalletRefundRow>(
      `SELECT * FROM mock_refunds
       WHERE id = $1 AND customer_id = $2 AND destination = 'wallet'
       LIMIT 1`,
      [refundId, customerId],
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (!row) return notFound("wallet refund");
    return { ok: true, data: mapRefund(row) };
  };

  const getWalletLedger: ToolHandler = async ({ customerId, args, signal }) => {
    throwIfAborted(signal);
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(Math.trunc(args.limit), 1), 50)
        : 30;

    let paymentDateClause = "";
    let refundDateClause = "";
    const paymentParams: unknown[] = [customerId];
    const refundParams: unknown[] = [customerId];

    if (typeof args.relativeDate === "string") {
      const { from, to } = relativeDateRange(args.relativeDate as RelativeDate);
      paymentParams.push(from.toISOString(), to.toISOString());
      refundParams.push(from.toISOString(), to.toISOString());
      paymentDateClause = `AND occurred_at >= $2 AND occurred_at < $3`;
      refundDateClause = `AND created_at >= $2 AND created_at < $3`;
    }

    const payments = await db.query<TxnRow>(
      `SELECT * FROM mock_transactions
       WHERE customer_id = $1
         AND channel IN ('wallet', 'upi')
         ${paymentDateClause}
       ORDER BY occurred_at DESC
       LIMIT ${limit}`,
      paymentParams,
    );
    throwIfAborted(signal);

    const refunds = await db.query<WalletRefundRow>(
      `SELECT * FROM mock_refunds
       WHERE customer_id = $1
         AND destination = 'wallet'
         ${refundDateClause}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      refundParams,
    );
    throwIfAborted(signal);

    const entries = [
      ...payments.rows.map((row) => ({
        type: "payment" as const,
        at: row.occurred_at.toISOString(),
        ...mapTxn(row),
      })),
      ...refunds.rows.map((row) => ({
        type: "refund" as const,
        at: row.created_at.toISOString(),
        ...mapRefund(row),
      })),
    ]
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, limit);

    return {
      ok: true,
      data: {
        customerId,
        entryCount: entries.length,
        entries,
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
    createComplaint,
    addComplaintDetails,
    escalateComplaint,
    getWalletBalance,
    getWalletPayments,
    getWalletPaymentStatus,
    getWalletRefundStatus,
    getWalletRefundDetails,
    getWalletLedger,
  };
}
