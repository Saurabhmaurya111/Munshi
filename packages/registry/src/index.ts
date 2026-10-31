import { z } from "zod";

export type ToolRisk = "read" | "write" | "money";

export type ToolCard = {
  name: string;
  description: string;
  risk: ToolRisk;
  domainPack: string;
  inputSchema: z.ZodType;
};

const referenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/);

const amountSchema = z.number().finite().positive().max(10_000_000);

const relativeDateSchema = z.enum([
  "today",
  "yesterday",
  "last_week",
  "last_month",
]);

const lookupFilters = {
  amount: amountSchema.optional(),
  relativeDate: relativeDateSchema.optional(),
};

const lookupSchema = z
  .strictObject(lookupFilters)
  .refine(
    (value) => value.amount !== undefined || value.relativeDate !== undefined,
    "provide an amount or a date filter",
  );

const transactionIdSchema = z.strictObject({
  transactionId: referenceSchema,
});

const refundLookupSchema = z
  .strictObject({
    refundId: referenceSchema.optional(),
    transactionId: referenceSchema.optional(),
    ...lookupFilters,
  })
  .refine(
    (value) =>
      value.refundId !== undefined ||
      value.transactionId !== undefined ||
      value.amount !== undefined ||
      value.relativeDate !== undefined,
    "provide a refund id, transaction id, amount, or date filter",
  );

const rechargeLookupSchema = z
  .strictObject({
    rechargeNumber: z
      .string()
      .regex(/^[6-9]\d{9}$/)
      .optional(),
    transactionId: referenceSchema.optional(),
    ...lookupFilters,
  })
  .refine(
    (value) =>
      value.rechargeNumber !== undefined ||
      value.transactionId !== undefined ||
      value.amount !== undefined ||
      value.relativeDate !== undefined,
    "provide a recharge number, transaction id, amount, or date filter",
  );

const walletPaymentLookupSchema = z
  .strictObject({
    transactionId: referenceSchema.optional(),
    channel: z.enum(["upi", "wallet", "all"]).optional(),
    ...lookupFilters,
  })
  .refine(
    (value) =>
      value.transactionId !== undefined ||
      value.amount !== undefined ||
      value.relativeDate !== undefined ||
      value.channel !== undefined,
    "provide a transaction id, amount, date filter, or channel",
  );

const walletRefundLookupSchema = z
  .strictObject({
    refundId: referenceSchema.optional(),
    transactionId: referenceSchema.optional(),
    ...lookupFilters,
  })
  .refine(
    (value) =>
      value.refundId !== undefined ||
      value.transactionId !== undefined ||
      value.amount !== undefined ||
      value.relativeDate !== undefined,
    "provide a refund id, transaction id, amount, or date filter",
  );

const walletLedgerSchema = z.strictObject({
  relativeDate: relativeDateSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

/** Gateway tool cards. Read tools are executable in B4; writes wait for B5. */
export const TOOL_CARDS: Record<string, ToolCard> = {
  getTransactions: {
    name: "getTransactions",
    description: "List this customer's UPI transactions matching amount or date filters.",
    risk: "read",
    domainPack: "upi",
    inputSchema: lookupSchema,
  },
  getTransactionStatus: {
    name: "getTransactionStatus",
    description: "Read the authoritative status of one UPI transaction.",
    risk: "read",
    domainPack: "upi",
    inputSchema: transactionIdSchema,
  },
  getBankReference: {
    name: "getBankReference",
    description: "Read the bank reference attached to a UPI transaction.",
    risk: "read",
    domainPack: "upi",
    inputSchema: transactionIdSchema,
  },
  getRefundStatus: {
    name: "getRefundStatus",
    description: "Read the authoritative status of a refund.",
    risk: "read",
    domainPack: "refund",
    inputSchema: refundLookupSchema,
  },
  getRefundDetails: {
    name: "getRefundDetails",
    description: "Read the details of a refund by refund id.",
    risk: "read",
    domainPack: "refund",
    inputSchema: z.strictObject({ refundId: referenceSchema }),
  },
  getRechargeStatus: {
    name: "getRechargeStatus",
    description: "Read the authoritative status of a mobile recharge.",
    risk: "read",
    domainPack: "recharge",
    inputSchema: rechargeLookupSchema,
  },
  getRechargeDetails: {
    name: "getRechargeDetails",
    description: "Read the details of a recharge by transaction id.",
    risk: "read",
    domainPack: "recharge",
    inputSchema: transactionIdSchema,
  },
  getAccountSupportStatus: {
    name: "getAccountSupportStatus",
    description: "Read account support facts for this customer. Never changes credentials.",
    risk: "read",
    domainPack: "account",
    inputSchema: z.strictObject({}),
  },
  getWalletBalance: {
    name: "getWalletBalance",
    description: "Read this customer's Paytm wallet balance and wallet status.",
    risk: "read",
    domainPack: "wallet",
    inputSchema: z.strictObject({}),
  },
  getWalletPayments: {
    name: "getWalletPayments",
    description:
      "List wallet and wallet-linked UPI payments for this customer matching filters.",
    risk: "read",
    domainPack: "wallet",
    inputSchema: walletPaymentLookupSchema,
  },
  getWalletPaymentStatus: {
    name: "getWalletPaymentStatus",
    description: "Read the authoritative status of one wallet or wallet-linked payment.",
    risk: "read",
    domainPack: "wallet",
    inputSchema: transactionIdSchema,
  },
  getWalletRefundStatus: {
    name: "getWalletRefundStatus",
    description: "Read refunds that credit or should credit this customer's Paytm wallet.",
    risk: "read",
    domainPack: "wallet",
    inputSchema: walletRefundLookupSchema,
  },
  getWalletRefundDetails: {
    name: "getWalletRefundDetails",
    description: "Read details of one wallet-bound refund by refund id.",
    risk: "read",
    domainPack: "wallet",
    inputSchema: z.strictObject({ refundId: referenceSchema }),
  },
  getWalletLedger: {
    name: "getWalletLedger",
    description:
      "Read a combined timeline of wallet payments and wallet-bound refunds for this customer.",
    risk: "read",
    domainPack: "wallet",
    inputSchema: walletLedgerSchema,
  },
  getComplaintStatus: {
    name: "getComplaintStatus",
    description: "Read the status of a complaint.",
    risk: "read",
    domainPack: "complaint",
    inputSchema: z.strictObject({ complaintId: referenceSchema }),
  },
  createComplaint: {
    name: "createComplaint",
    description: "Create a complaint for this customer.",
    risk: "write",
    domainPack: "complaint",
    inputSchema: z.strictObject({
      category: z.enum([
        "upi",
        "refund",
        "recharge",
        "account",
        "complaint",
        "wallet",
      ]),
      summary: z.string().min(1).max(500),
    }),
  },
  addComplaintDetails: {
    name: "addComplaintDetails",
    description: "Add permitted details to an existing complaint.",
    risk: "write",
    domainPack: "complaint",
    inputSchema: z.strictObject({
      complaintId: referenceSchema,
      details: z.string().min(1).max(500),
    }),
  },
  escalateComplaint: {
    name: "escalateComplaint",
    description: "Escalate an unresolved or high-risk complaint.",
    risk: "write",
    domainPack: "complaint",
    inputSchema: z.strictObject({
      complaintId: referenceSchema,
      reason: z.string().min(1).max(500),
    }),
  },
};

export function getToolCard(name: string): ToolCard | undefined {
  return Object.hasOwn(TOOL_CARDS, name) ? TOOL_CARDS[name] : undefined;
}

export type ToolArgsValidation =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; issues: string[] };

export function validateToolArgs(
  tool: string,
  args: unknown,
): ToolArgsValidation {
  const card = getToolCard(tool);
  if (!card) {
    return { ok: false, issues: [`unknown tool ${tool}`] };
  }

  const parsed = card.inputSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => issue.message),
    };
  }

  if (
    typeof parsed.data !== "object" ||
    parsed.data === null ||
    Array.isArray(parsed.data)
  ) {
    return { ok: false, issues: ["tool arguments must be an object"] };
  }

  return { ok: true, data: parsed.data as Record<string, unknown> };
}
