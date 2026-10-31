import { interpretObservation, type Interpretation } from "./explain.js";
import { getIntentDefinition } from "./intents.js";
import { evaluateToolPolicy } from "./policy.js";
import { redactSecrets } from "./risk.js";
import { getTool, isToolAllowedForAgent, validateToolArgs } from "./tools.js";
import type {
  AgentName,
  AgentTask,
  AgentTaskResult,
  Domain,
  GroundingPassage,
  KnowledgeLookup,
  RiskSignals,
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
  risk?: RiskSignals;
  knowledge?: KnowledgeLookup;
  turnId?: string;
};

export type AgentRunner = (
  task: AgentTask,
  context: AgentRunContext,
) => Promise<AgentTaskResult>;

type ToolPlanStep = {
  tool: string;
  args: Record<string, unknown>;
};

/** Attempts run in order until one returns a non-empty answer. */
type ToolPlan =
  | { ok: true; attempts: ToolPlanStep[] }
  | { ok: false; missing: string[] };

const AGENT_DOMAINS: Record<AgentName, Domain> = {
  upi_agent: "upi",
  refund_agent: "refund",
  recharge_agent: "recharge",
  account_agent: "account",
  complaint_agent: "complaint",
  wallet_agent: "wallet",
};

const FRAUD_SENSITIVE_DOMAINS: Domain[] = ["upi", "account"];

const MAX_CITATIONS = 2;

function stringEntity(entities: Record<string, unknown>, name: string): string | undefined {
  const value = entities[name];
  return typeof value === "string" ? value : undefined;
}

function lookupFilters(entities: Record<string, unknown>): Record<string, unknown> {
  const filters: Record<string, unknown> = {};

  if (typeof entities.amount === "number") {
    filters.amount = entities.amount;
  }

  if (typeof entities.relativeDate === "string") {
    filters.relativeDate = entities.relativeDate;
  }

  return filters;
}

/** Strict filter first; customers often misremember the day, so retry on amount alone. */
function filterAttempts(tool: string, entities: Record<string, unknown>): ToolPlanStep[] {
  const filters = lookupFilters(entities);

  if (Object.keys(filters).length === 0) {
    return [];
  }

  const attempts: ToolPlanStep[] = [{ tool, args: filters }];

  if (filters.amount !== undefined && filters.relativeDate !== undefined) {
    attempts.push({ tool, args: { amount: filters.amount } });
  }

  return attempts;
}

function complaintCategory(task: AgentTask, context: AgentRunContext): string {
  for (const dependency of task.dependsOn) {
    const result = context.results.get(dependency);

    if (result && result.agent !== "complaint_agent") {
      return AGENT_DOMAINS[result.agent];
    }
  }

  return "complaint";
}

function complaintSummary(task: AgentTask, context: AgentRunContext): string {
  const related = task.dependsOn.flatMap(
    (dependency) => context.results.get(dependency)?.references ?? [],
  );
  const base = redactSecrets(context.message).trim();
  const suffix = related.length > 0 ? ` [related: ${[...new Set(related)].join(", ")}]` : "";

  return `${base.slice(0, 500 - suffix.length)}${suffix}`;
}

function compileToolPlan(task: AgentTask, context: AgentRunContext): ToolPlan {
  const { entities } = task;

  switch (task.intent) {
    case "UPI_PAYMENT_ISSUE": {
      const transactionId = stringEntity(entities, "transactionId");

      if (transactionId) {
        return { ok: true, attempts: [{ tool: "getTransactionStatus", args: { transactionId } }] };
      }

      const attempts = filterAttempts("getTransactions", entities);
      return attempts.length > 0
        ? { ok: true, attempts }
        : { ok: false, missing: ["transactionId", "amount", "relativeDate"] };
    }

    case "REFUND_STATUS": {
      const refundId = stringEntity(entities, "refundId");
      const transactionId = stringEntity(entities, "transactionId");

      if (refundId) {
        return { ok: true, attempts: [{ tool: "getRefundStatus", args: { refundId } }] };
      }

      if (transactionId) {
        return { ok: true, attempts: [{ tool: "getRefundStatus", args: { transactionId } }] };
      }

      const attempts = filterAttempts("getRefundStatus", entities);
      return attempts.length > 0
        ? { ok: true, attempts }
        : { ok: false, missing: ["refundId", "transactionId", "amount", "relativeDate"] };
    }

    case "RECHARGE_ISSUE": {
      const rechargeNumber = stringEntity(entities, "rechargeNumber");
      const transactionId = stringEntity(entities, "transactionId");

      if (transactionId) {
        return { ok: true, attempts: [{ tool: "getRechargeStatus", args: { transactionId } }] };
      }

      if (rechargeNumber) {
        return { ok: true, attempts: [{ tool: "getRechargeStatus", args: { rechargeNumber } }] };
      }

      const attempts = filterAttempts("getRechargeStatus", entities);
      return attempts.length > 0
        ? { ok: true, attempts }
        : { ok: false, missing: ["rechargeNumber", "transactionId", "amount", "relativeDate"] };
    }

    case "ACCOUNT_ISSUE":
      return { ok: true, attempts: [{ tool: "getAccountSupportStatus", args: {} }] };

    case "WALLET_BALANCE":
      return { ok: true, attempts: [{ tool: "getWalletBalance", args: {} }] };

    case "WALLET_PAYMENT_TRACK": {
      const transactionId = stringEntity(entities, "transactionId");

      if (transactionId) {
        return {
          ok: true,
          attempts: [{ tool: "getWalletPaymentStatus", args: { transactionId } }],
        };
      }

      const filters = filterAttempts("getWalletPayments", entities).map((attempt) => ({
        ...attempt,
        args: { ...attempt.args, channel: "all" },
      }));

      if (filters.length > 0) {
        return { ok: true, attempts: filters };
      }

      return { ok: true, attempts: [{ tool: "getWalletLedger", args: {} }] };
    }

    case "WALLET_REFUND_TRACK": {
      const refundId = stringEntity(entities, "refundId");
      const transactionId = stringEntity(entities, "transactionId");

      if (refundId) {
        return {
          ok: true,
          attempts: [{ tool: "getWalletRefundDetails", args: { refundId } }],
        };
      }

      if (transactionId) {
        return {
          ok: true,
          attempts: [{ tool: "getWalletRefundStatus", args: { transactionId } }],
        };
      }

      const attempts = filterAttempts("getWalletRefundStatus", entities);
      return attempts.length > 0
        ? { ok: true, attempts }
        : { ok: false, missing: ["refundId", "transactionId", "amount", "relativeDate"] };
    }

    case "COMPLAINT_STATUS": {
      const complaintId = stringEntity(entities, "complaintId");

      return complaintId
        ? { ok: true, attempts: [{ tool: "getComplaintStatus", args: { complaintId } }] }
        : { ok: false, missing: ["complaintId"] };
    }

    case "COMPLAINT_CREATE": {
      if (context.message.trim().length === 0) {
        return { ok: false, missing: ["summary"] };
      }

      return {
        ok: true,
        attempts: [
          {
            tool: "createComplaint",
            args: {
              category: complaintCategory(task, context),
              summary: complaintSummary(task, context),
            },
          },
        ],
      };
    }

    default:
      return { ok: false, missing: [] };
  }
}

function labelFor(task: AgentTask): string {
  switch (task.domain) {
    case "upi":
      return "UPI payment";
    case "refund":
      return "refund";
    case "recharge":
      return "recharge";
    case "account":
      return "account";
    case "complaint":
      return "complaint";
    case "wallet":
      return "wallet payment";
  }
}

function clarificationFor(task: AgentTask, missing: string[]): string {
  if (missing.includes("complaintId")) {
    return "Please share the complaint reference number so I can check it.";
  }

  if (missing.includes("summary")) {
    return "Please describe the issue you want a complaint raised for.";
  }

  switch (task.domain) {
    case "upi":
      return "Please share the transaction reference from your payment history, or the amount and the day you paid, so I can find the right payment.";
    case "refund":
      return "Please share the refund reference, or the payment and amount it's for, so I can find the right refund.";
    case "recharge":
      return "Please share the recharge reference, or the mobile number and amount, so I can find the right recharge.";
    case "wallet":
      return "Please share the wallet payment or refund reference, or the amount and date, so I can find the right wallet activity.";
    default:
      return `Please share a little more detail so I can find the right ${labelFor(task)}.`;
  }
}

function notFoundFor(task: AgentTask): string {
  return `I couldn't find a matching ${labelFor(task)} on your account. ${clarificationFor(task, [])}`;
}

function citationId(passage: { documentId: string; documentVersion: string; chunkIndex: number }) {
  return `${passage.documentId}@${passage.documentVersion}#${passage.chunkIndex}`;
}

async function lookupCitations(
  task: AgentTask,
  context: AgentRunContext,
): Promise<{ citations: string[]; passages: GroundingPassage[] }> {
  if (!context.knowledge) {
    return { citations: [], passages: [] };
  }

  try {
    const found = await context.knowledge({
      query: redactSecrets(context.message),
      category: task.domain,
    });
    const selected = found.slice(0, MAX_CITATIONS);

    return {
      citations: selected.map(citationId),
      passages: selected.flatMap((passage) => {
        const content = passage.content.trim();
        if (content.length === 0) return [];

        return [
          {
            citation: citationId(passage),
            title: passage.documentTitle,
            ...(passage.heading ? { heading: passage.heading } : {}),
            content,
          },
        ];
      }),
    };
  } catch {
    return { citations: [], passages: [] };
  }
}

type Draft = Omit<AgentTaskResult, "taskId" | "agent" | "intent" | "citations" | "passages">;

function finish(
  task: AgentTask,
  draft: Draft,
  grounding: { citations: string[]; passages: GroundingPassage[] },
): AgentTaskResult {
  return {
    taskId: task.taskId,
    agent: task.agent,
    intent: task.intent,
    ...draft,
    ...(grounding.citations.length > 0 ? { citations: grounding.citations } : {}),
    ...(grounding.passages.length > 0 ? { passages: grounding.passages } : {}),
  };
}

function applyRisk(task: AgentTask, context: AgentRunContext, draft: Draft): Draft {
  if (!context.risk?.fraudSuspected || !FRAUD_SENSITIVE_DOMAINS.includes(task.domain)) {
    return draft;
  }

  if (draft.status === "failed") {
    return draft;
  }

  return { ...draft, status: "escalated", errorCode: "FRAUD_SUSPECTED" };
}

async function execute(task: AgentTask, context: AgentRunContext): Promise<Draft> {
  for (const dependency of task.dependsOn) {
    const dependencyResult = context.results.get(dependency);

    if (dependencyResult?.status === "completed") {
      continue;
    }

    if (dependencyResult?.status === "needs_clarification") {
      return {
        status: "needs_clarification",
        response: "I'll raise the complaint once we've identified the right record.",
        errorCode: "DEPENDENCY_NEEDS_INPUT",
      };
    }

    return {
      status: "escalated",
      response: "This action needs the related investigation to finish first.",
      errorCode: "DEPENDENCY_NOT_SATISFIED",
    };
  }

  if (task.missingEntities.length > 0) {
    return {
      status: "needs_clarification",
      response: clarificationFor(task, task.missingEntities),
      errorCode: "MISSING_INFORMATION",
    };
  }

  if (!getIntentDefinition(task.intent)) {
    return {
      status: "failed",
      response: "The request could not be matched to a supported workflow.",
      errorCode: "UNKNOWN_INTENT",
    };
  }

  const plan = compileToolPlan(task, context);

  if (!plan.ok) {
    return {
      status: "needs_clarification",
      response: clarificationFor(task, plan.missing),
      errorCode: "MISSING_INFORMATION",
    };
  }

  const observations: ToolObservation[] = [];
  let interpretation: Interpretation = { kind: "empty" };

  for (const [index, step] of plan.attempts.entries()) {
    const tool = getTool(step.tool);

    if (!tool) {
      return {
        status: "failed",
        response: "The requested action is not available.",
        errorCode: "UNKNOWN_TOOL",
      };
    }

    if (!isToolAllowedForAgent(step.tool, task.agent)) {
      return {
        status: "failed",
        response: "The requested action is not permitted for this workflow.",
        errorCode: "TOOL_NOT_ALLOWED",
      };
    }

    const validated = validateToolArgs(step.tool, step.args);

    if (!validated.ok) {
      return {
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
        status: "escalated",
        response: "This action is blocked by policy, so I've passed it to the support team.",
        errorCode: "POLICY_BLOCKED",
      };
    }

    const stepId = `${context.turnId ? `${context.turnId}:` : ""}${task.taskId}:${index}:${step.tool}`;
    const result = await context.tools.invoke({
      caseId: context.caseId,
      stepId,
      tool: step.tool,
      args: validated.data,
      customerId: context.customerId,
      workflowLevel: context.workflowLevel,
    });

    if (
      policy.decision === "hold_for_approval" ||
      result.state === "pending_approval"
    ) {
      return {
        status: "escalated",
        response: `To ${task.intent === "COMPLAINT_CREATE" ? "raise a complaint" : "do this"}, I need approval from our support team first. Your request is recorded on this case, and you'll get the reference once it's done.`,
        errorCode: "APPROVAL_REQUIRED",
        observations:
          result.state === "pending_approval"
            ? [
                {
                  tool: step.tool,
                  state: "failed" as const,
                  errorCode: "APPROVAL_REQUIRED",
                },
              ]
            : undefined,
        data: {
          stepId,
          tool: step.tool,
          intentId:
            result.state === "pending_approval" ? result.intentId : undefined,
        },
      };
    }

    if (result.state === "unknown") {
      observations.push({ tool: step.tool, state: "unknown", errorCode: result.errorCode });
      return {
        status: "escalated",
        response: `I couldn't get a confirmed answer about your ${labelFor(task)} because the system didn't respond in time. I won't guess, so I've flagged it for a check.`,
        observations,
        errorCode: "UNKNOWN_OUTCOME",
      };
    }

    if (result.state === "failed") {
      observations.push({ tool: step.tool, state: "failed", errorCode: result.errorCode });

      if (result.errorCode === "NOT_FOUND") {
        continue;
      }

      return {
        status: "failed",
        response: `I couldn't check your ${labelFor(task)} right now because the system returned an error. Please try again in a little while.`,
        observations,
        errorCode: result.errorCode,
      };
    }

    observations.push({ tool: step.tool, state: "confirmed", data: result.data });
    interpretation = interpretObservation(step.tool, result.data, context.message);

    if (interpretation.kind !== "empty") {
      break;
    }
  }

  if (interpretation.kind === "ambiguous") {
    return {
      status: "needs_clarification",
      response: interpretation.text,
      references: interpretation.references,
      observations,
      errorCode: "MULTIPLE_MATCHES",
    };
  }

  if (interpretation.kind === "verified") {
    return {
      status: "completed",
      response: interpretation.text,
      references: interpretation.references,
      observations,
    };
  }

  const confirmedWrite = observations.some(
    (observation) => observation.state === "confirmed" && getTool(observation.tool)?.risk !== "read",
  );

  if (confirmedWrite) {
    return {
      status: "escalated",
      response: "The request was accepted, but no reference came back yet, so I've flagged it for a check.",
      observations,
      errorCode: "NO_REFERENCE",
    };
  }

  return {
    status: "needs_clarification",
    response: notFoundFor(task),
    observations,
    errorCode: "NOT_FOUND",
  };
}

export function createAgentRunner(): AgentRunner {
  return async function runTask(
    task: AgentTask,
    context: AgentRunContext,
  ): Promise<AgentTaskResult> {
    const [draft, grounding] = await Promise.all([
      execute(task, context),
      lookupCitations(task, context),
    ]);

    return finish(task, applyRisk(task, context, draft), grounding);
  };
}
