/** Policy engine and risk rules. Deterministic code; cannot approve. */

export type RiskDecision = "allow" | "block" | "escalate";

export type GuardrailInput = {
  tool: string;
  risk: "read" | "write" | "money";
  caseId: string;
  customerId: string;
  args: Record<string, unknown>;
  workflowLevel?: 0 | 1 | 2;
  /** Desk has approved this specific write for execution. */
  executeApproved?: boolean;
};

/**
 * Reads always allow. Money always escalates unless desk-approved.
 * Low-risk writes allow when desk-approved or workflow level >= 2.
 */
export function evaluateGuardrail(input: GuardrailInput): RiskDecision {
  if (input.risk === "read") {
    return "allow";
  }
  if (input.executeApproved) {
    return "allow";
  }
  if (input.risk === "money") {
    return "escalate";
  }
  if ((input.workflowLevel ?? 0) >= 2) {
    return "allow";
  }
  // Park path still validates the tool; escalate signals approval needed.
  return "escalate";
}
