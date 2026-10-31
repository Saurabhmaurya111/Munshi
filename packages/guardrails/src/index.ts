/** Policy engine and risk rules. Deterministic code; cannot approve. */

export type RiskDecision = "allow" | "block" | "escalate";

export type GuardrailInput = {
  tool: string;
  risk: "read" | "write" | "money";
  caseId: string;
  customerId: string;
  args: Record<string, unknown>;
  workflowLevel?: 0 | 1 | 2;
};

/**
 * B4: allow all reads. Writes/money escalate/block until B5 approval path exists.
 */
export function evaluateGuardrail(input: GuardrailInput): RiskDecision {
  if (input.risk === "read") {
    return "allow";
  }
  if (input.risk === "money") {
    return "escalate";
  }
  return "block";
}
