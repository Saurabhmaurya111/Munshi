import type { ToolRisk, WorkflowLevel } from "./types.js";

export type PolicyDecision =
  | { decision: "allow"; reason: string }
  | { decision: "hold_for_approval"; reason: string }
  | { decision: "block"; reason: string };

export type ToolPolicyContext = {
  workflowLevel: WorkflowLevel;
  amount?: number;
  amountApprovalThreshold?: number;
};

export const DEFAULT_AMOUNT_APPROVAL_THRESHOLD = 5000;

export function evaluateToolPolicy(
  risk: ToolRisk,
  context: ToolPolicyContext,
): PolicyDecision {
  if (risk === "read") {
    return { decision: "allow", reason: "read tool" };
  }

  if (risk === "money") {
    const threshold = context.amountApprovalThreshold ?? DEFAULT_AMOUNT_APPROVAL_THRESHOLD;

    if (context.amount !== undefined && context.amount > threshold) {
      return {
        decision: "hold_for_approval",
        reason: "money-adjacent action above the approval threshold",
      };
    }

    return {
      decision: "hold_for_approval",
      reason: "money-adjacent actions always require human approval",
    };
  }

  if (context.workflowLevel < 2) {
    return {
      decision: "hold_for_approval",
      reason: "low-risk writes need workflow level 2",
    };
  }

  return { decision: "allow", reason: "low-risk write at workflow level 2" };
}

export function evaluateReplyPolicy(workflowLevel: WorkflowLevel): PolicyDecision {
  if (workflowLevel < 1) {
    return {
      decision: "hold_for_approval",
      reason: "customer replies need workflow level 1",
    };
  }

  return { decision: "allow", reason: "customer reply allowed" };
}
