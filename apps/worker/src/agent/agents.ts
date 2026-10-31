import { getIntentDefinition } from "./intents.js";
import { evaluateToolPolicy } from "./policy.js";
import { getTool, isToolAllowedForAgent, validateToolArgs } from "./tools.js";
import type {
  AgentTask,
  AgentTaskResult,
  ToolInvoker,
  ToolObservation,
  WorkflowLevel,
} from "./types.js";

export type AgentRunContext = {
  caseId: string;
  conversationId: string;
  customerId: string;
  workflowLevel: WorkflowLevel;
  message: string;
  tools: ToolInvoker;
  results: Map<string, AgentTaskResult>;
  amountApprovalThreshold?: number;
};

export type AgentRunner = (
  task: AgentTask,
  context: AgentRunContext,
) => Promise<AgentTaskResult>;

type ToolPlanStep = {
  tool: string;
  args: Record<string, unknown>;
};

type ToolPlan =
  | { ok: true; steps: ToolPlanStep[] }
  | { ok: false; missing: string[] };

function stringEntity(entities: Record<string, unknown>, name: string): string | undefined {
  const value = entities[name];
  return typeof value === "string" ? value : undefined;
}

function lookupFilters(entities: Record<string, unknown>): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  const amount = entities.amount;

  if (typeof amount === "number") {
    filters.amount = amount;
  }

  const relativeDate = entities.relativeDate;

  if (typeof relativeDate === "string") {
    filters.relativeDate = relativeDate;
  }

  return filters;
}

function compileToolPlan(task: AgentTask, message: string): ToolPlan {
  switch (task.intent) {
    case "UPI_PAYMENT_ISSUE": {
      const transactionId = stringEntity(task.entities, "transactionId");

      if (transactionId) {
        return { ok: true, steps: [{ tool: "getTransactionStatus", args: { transactionId } }] };
      }

      const filters = lookupFilters(task.entities);

      if (Object.keys(filters).length > 0) {
        return { ok: true, steps: [{ tool: "getTransactions", args: filters }] };
      }

      return { ok: false, missing: ["transactionId", "amount", "relativeDate"] };
    }

    case "REFUND_STATUS": {
      const refundId = stringEntity(task.entities, "refundId");
      const transactionId = stringEntity(task.entities, "transactionId");

      if (refundId) {
        return { ok: true, steps: [{ tool: "getRefundStatus", args: { refundId } }] };
      }

      if (transactionId) {
        return { ok: true, steps: [{ tool: "getRefundStatus", args: { transactionId } }] };
      }

      const filters = lookupFilters(task.entities);

      if (Object.keys(filters).length > 0) {
        return { ok: true, steps: [{ tool: "getRefundStatus", args: filters }] };
      }

      return { ok: false, missing: ["refundId", "transactionId", "amount", "relativeDate"] };
    }

    case "RECHARGE_ISSUE": {
      const rechargeNumber = stringEntity(task.entities, "rechargeNumber");
      const transactionId = stringEntity(task.entities, "transactionId");

      if (rechargeNumber) {
        return { ok: true, steps: [{ tool: "getRechargeStatus", args: { rechargeNumber } }] };
      }

      if (transactionId) {
        return { ok: true, steps: [{ tool: "getRechargeStatus", args: { transactionId } }] };
      }

      const filters = lookupFilters(task.entities);

      if (Object.keys(filters).length > 0) {
        return { ok: true, steps: [{ tool: "getRechargeStatus", args: filters }] };
      }

      return { ok: false, missing: ["rechargeNumber", "transactionId", "amount", "relativeDate"] };
    }

    case "ACCOUNT_ISSUE":
      return { ok: true, steps: [{ tool: "getAccountSupportStatus", args: {} }] };

    case "WALLET_BALANCE":
      return { ok: true, steps: [{ tool: "getWalletBalance", args: {} }] };

    case "WALLET_PAYMENT_TRACK": {
      const transactionId = stringEntity(task.entities, "transactionId");

      if (transactionId) {
        return {
          ok: true,
          steps: [{ tool: "getWalletPaymentStatus", args: { transactionId } }],
        };
      }

      const filters = lookupFilters(task.entities);

      if (Object.keys(filters).length > 0) {
        return {
          ok: true,
          steps: [{ tool: "getWalletPayments", args: { ...filters, channel: "all" } }],
        };
      }

      // Broad "track my wallet payments" → combined ledger.
      return { ok: true, steps: [{ tool: "getWalletLedger", args: {} }] };
    }

    case "WALLET_REFUND_TRACK": {
      const refundId = stringEntity(task.entities, "refundId");
      const transactionId = stringEntity(task.entities, "transactionId");

      if (refundId) {
        return {
          ok: true,
          steps: [{ tool: "getWalletRefundDetails", args: { refundId } }],
        };
      }

      if (transactionId) {
        return {
          ok: true,
          steps: [{ tool: "getWalletRefundStatus", args: { transactionId } }],
        };
      }

      const filters = lookupFilters(task.entities);

      if (Object.keys(filters).length > 0) {
        return { ok: true, steps: [{ tool: "getWalletRefundStatus", args: filters }] };
      }

      return {
        ok: false,
        missing: ["refundId", "transactionId", "amount", "relativeDate"],
      };
    }

    case "COMPLAINT_STATUS": {
      const complaintId = stringEntity(task.entities, "complaintId");

      if (!complaintId) {
        return { ok: false, missing: ["complaintId"] };
      }

      return { ok: true, steps: [{ tool: "getComplaintStatus", args: { complaintId } }] };
    }

    case "COMPLAINT_CREATE": {
      const summary = message.trim().slice(0, 500);

      if (summary.length === 0) {
        return { ok: false, missing: ["summary"] };
      }

      return {
        ok: true,
        steps: [
          {
            tool: "createComplaint",
            args: { category: "complaint", summary },
          },
        ],
      };
    }

    default:
      return { ok: false, missing: [] };
  }
}

function extractStatus(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }

  const status = (data as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

function extractReferences(data: unknown): string[] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return [];
  }

  const record = data as Record<string, unknown>;
  const keys = [
    "reference",
    "transactionId",
    "refundId",
    "complaintId",
    "rechargeNumber",
    "walletId",
  ];

  return keys.flatMap((key) => {
    const value = record[key];
    return typeof value === "string" ? [value] : [];
  });
}

function labelFor(task: AgentTask): string {
  switch (task.domain) {
    case "upi":
      return "UPI payment";
    case "refund":
      return "Refund";
    case "recharge":
      return "Recharge";
    case "account":
      return "Account";
    case "complaint":
      return "Complaint";
    case "wallet":
      return "Wallet payment";
  }
}

function clarificationFor(task: AgentTask, missing: string[]): string {
  if (missing.includes("complaintId")) {
    return "Please share the complaint reference number.";
  }

  if (missing.includes("summary")) {
    return "Please describe the issue you want a complaint raised for.";
  }

  if (task.domain === "wallet" && missing.includes("refundId")) {
    return "Please share the wallet refund reference, related transaction id, amount, or date.";
  }

  return `Please share the transaction reference, amount, or date so I can find the right ${labelFor(task).toLowerCase()}.`;
}

function observationSummary(observations: ToolObservation[]): string {
  const parts = observations.map((observation) => {
    const status = extractStatus(observation.data);
    return status ? `${observation.tool} returned status "${status}"` : `${observation.tool} confirmed`;
  });

  return `Verified: ${parts.join("; ")}.`;
}

export function createAgentRunner(): AgentRunner {
  return async function runTask(
    task: AgentTask,
    context: AgentRunContext,
  ): Promise<AgentTaskResult> {
    for (const dependency of task.dependsOn) {
      const dependencyResult = context.results.get(dependency);

      if (!dependencyResult || dependencyResult.status !== "completed") {
        return {
          taskId: task.taskId,
          agent: task.agent,
          status: "escalated",
          response: "This action needs the related investigation to finish first.",
          errorCode: "DEPENDENCY_NOT_SATISFIED",
        };
      }
    }

    if (task.missingEntities.length > 0) {
      return {
        taskId: task.taskId,
        agent: task.agent,
        status: "needs_clarification",
        response: clarificationFor(task, task.missingEntities),
        errorCode: "MISSING_INFORMATION",
      };
    }

    const plan = compileToolPlan(task, context.message);

    if (!plan.ok) {
      return {
        taskId: task.taskId,
        agent: task.agent,
        status: "needs_clarification",
        response: clarificationFor(task, plan.missing),
        errorCode: "MISSING_INFORMATION",
      };
    }

    const definition = getIntentDefinition(task.intent);

    if (!definition) {
      return {
        taskId: task.taskId,
        agent: task.agent,
        status: "failed",
        response: "The request could not be matched to a supported workflow.",
        errorCode: "UNKNOWN_INTENT",
      };
    }

    const observations: ToolObservation[] = [];
    const references = new Set<string>();

    for (const [index, step] of plan.steps.entries()) {
      const tool = getTool(step.tool);

      if (!tool) {
        return {
          taskId: task.taskId,
          agent: task.agent,
          status: "failed",
          response: "The requested action is not available.",
          errorCode: "UNKNOWN_TOOL",
        };
      }

      if (!isToolAllowedForAgent(step.tool, task.agent)) {
        return {
          taskId: task.taskId,
          agent: task.agent,
          status: "failed",
          response: "The requested action is not permitted for this workflow.",
          errorCode: "TOOL_NOT_ALLOWED",
        };
      }

      const validated = validateToolArgs(step.tool, step.args);

      if (!validated.ok) {
        return {
          taskId: task.taskId,
          agent: task.agent,
          status: "failed",
          response: "The request could not be validated safely.",
          errorCode: "INVALID_ARGS",
        };
      }

      const amount = task.entities.amount;

      const policy = evaluateToolPolicy(tool.risk, {
        workflowLevel: context.workflowLevel,
        amount: typeof amount === "number" ? amount : undefined,
        amountApprovalThreshold: context.amountApprovalThreshold,
      });

      if (policy.decision === "block") {
        return {
          taskId: task.taskId,
          agent: task.agent,
          status: "escalated",
          response: "This action is blocked by policy.",
          errorCode: "POLICY_BLOCKED",
        };
      }

      if (policy.decision === "hold_for_approval") {
        return {
          taskId: task.taskId,
          agent: task.agent,
          status: "escalated",
          response: "This action needs human approval before it can run.",
          errorCode: "APPROVAL_REQUIRED",
        };
      }

      const result = await context.tools.invoke({
        caseId: context.caseId,
        stepId: `${task.taskId}:${index}:${step.tool}`,
        tool: step.tool,
        args: validated.data,
        customerId: context.customerId,
      });

      if (result.state === "confirmed") {
        observations.push({ tool: step.tool, state: "confirmed", data: result.data });

        for (const reference of extractReferences(result.data)) {
          references.add(reference);
        }

        continue;
      }

      if (result.state === "failed") {
        observations.push({
          tool: step.tool,
          state: "failed",
          errorCode: result.errorCode,
        });

        return {
          taskId: task.taskId,
          agent: task.agent,
          status: "failed",
          response: `The ${labelFor(task).toLowerCase()} check did not complete.`,
          observations,
          errorCode: result.errorCode,
        };
      }

      observations.push({
        tool: step.tool,
        state: "unknown",
        errorCode: result.errorCode,
      });

      return {
        taskId: task.taskId,
        agent: task.agent,
        status: "escalated",
        response: `The ${labelFor(task).toLowerCase()} check has an unknown outcome and needs verification.`,
        observations,
        references: [...references],
        errorCode: "UNKNOWN_OUTCOME",
      };
    }

    if (observations.length === 0) {
      return {
        taskId: task.taskId,
        agent: task.agent,
        status: "failed",
        response: "No authoritative result was available for this request.",
        errorCode: "NO_OBSERVATION",
      };
    }

    return {
      taskId: task.taskId,
      agent: task.agent,
      status: "completed",
      response: observationSummary(observations),
      observations,
      references: [...references],
    };
  };
}
