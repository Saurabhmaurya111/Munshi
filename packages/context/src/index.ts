/** Context builder and token budgets. Rebuilds prompts from the case log. */

export type CallType =
  | "triage"
  | "planner"
  | "step_runner"
  | "reasoning"
  | "customer_reply"
  | "escalation_summary";
