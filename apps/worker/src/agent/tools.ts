import { z } from "zod";
import type { AgentName, Domain, ToolRisk } from "./types.js";

export type ToolDefinition = {
  name: string;
  description: string;
  risk: ToolRisk;
  domainPack: Domain;
  allowedAgents: AgentName[];
  inputSchema: z.ZodType;
};

export type ToolArgsValidation =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; issues: string[] };

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

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  getTransactions: {
    name: "getTransactions",
    description: "List this customer's UPI transactions matching amount or date filters.",
    risk: "read",
    domainPack: "upi",
    allowedAgents: ["upi_agent"],
    inputSchema: lookupSchema,
  },
  getTransactionStatus: {
    name: "getTransactionStatus",
    description: "Read the authoritative status of one UPI transaction.",
    risk: "read",
    domainPack: "upi",
    allowedAgents: ["upi_agent"],
    inputSchema: transactionIdSchema,
  },
  getBankReference: {
    name: "getBankReference",
    description: "Read the bank reference attached to a UPI transaction.",
    risk: "read",
    domainPack: "upi",
    allowedAgents: ["upi_agent"],
    inputSchema: transactionIdSchema,
  },
  getRefundStatus: {
    name: "getRefundStatus",
    description: "Read the authoritative status of a refund.",
    risk: "read",
    domainPack: "refund",
    allowedAgents: ["refund_agent"],
    inputSchema: refundLookupSchema,
  },
  getRefundDetails: {
    name: "getRefundDetails",
    description: "Read the details of a refund by refund id.",
    risk: "read",
    domainPack: "refund",
    allowedAgents: ["refund_agent"],
    inputSchema: z.strictObject({ refundId: referenceSchema }),
  },
  getRechargeStatus: {
    name: "getRechargeStatus",
    description: "Read the authoritative status of a mobile recharge.",
    risk: "read",
    domainPack: "recharge",
    allowedAgents: ["recharge_agent"],
    inputSchema: rechargeLookupSchema,
  },
  getRechargeDetails: {
    name: "getRechargeDetails",
    description: "Read the details of a recharge by transaction id.",
    risk: "read",
    domainPack: "recharge",
    allowedAgents: ["recharge_agent"],
    inputSchema: transactionIdSchema,
  },
  getAccountSupportStatus: {
    name: "getAccountSupportStatus",
    description: "Read account support facts for this customer. Never changes credentials.",
    risk: "read",
    domainPack: "account",
    allowedAgents: ["account_agent"],
    inputSchema: z.strictObject({}),
  },
  getComplaintStatus: {
    name: "getComplaintStatus",
    description: "Read the status of a complaint.",
    risk: "read",
    domainPack: "complaint",
    allowedAgents: ["complaint_agent"],
    inputSchema: z.strictObject({ complaintId: referenceSchema }),
  },
  createComplaint: {
    name: "createComplaint",
    description: "Create a complaint for this customer.",
    risk: "write",
    domainPack: "complaint",
    allowedAgents: ["complaint_agent"],
    inputSchema: z.strictObject({
      category: z.enum(["upi", "refund", "recharge", "account", "complaint"]),
      summary: z.string().min(1).max(500),
    }),
  },
  addComplaintDetails: {
    name: "addComplaintDetails",
    description: "Add permitted details to an existing complaint.",
    risk: "write",
    domainPack: "complaint",
    allowedAgents: ["complaint_agent"],
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
    allowedAgents: ["complaint_agent"],
    inputSchema: z.strictObject({
      complaintId: referenceSchema,
      reason: z.string().min(1).max(500),
    }),
  },
};

export const TOOL_NAMES: string[] = Object.keys(TOOL_REGISTRY);

export function getTool(name: string): ToolDefinition | undefined {
  return Object.hasOwn(TOOL_REGISTRY, name) ? TOOL_REGISTRY[name] : undefined;
}

export function isToolAllowedForAgent(tool: string, agent: AgentName): boolean {
  const definition = getTool(tool);
  return definition !== undefined && definition.allowedAgents.includes(agent);
}

export function getToolsForAgent(agent: AgentName): ToolDefinition[] {
  return Object.values(TOOL_REGISTRY).filter((tool) =>
    tool.allowedAgents.includes(agent),
  );
}

export function validateToolArgs(tool: string, args: unknown): ToolArgsValidation {
  const definition = getTool(tool);

  if (!definition) {
    return { ok: false, issues: [`unknown tool ${tool}`] };
  }

  const parsed = definition.inputSchema.safeParse(args);

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
