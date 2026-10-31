export type ToolInvocationInput = {
  caseId: string;
  stepId: string;
  tool: string;
  args: Record<string, unknown>;
  customerId: string;
  /** When true, execute a parked (intended) write. Desk path only. */
  executeApproved?: boolean;
  approvedBy?: string;
  /** Fencing epoch held by the worker; stale writers must not confirm. */
  heldEpoch?: string;
  workflowLevel?: 0 | 1 | 2;
};

export type ToolInvocationResult =
  | { state: "confirmed"; data: unknown }
  | { state: "failed"; errorCode: string; message: string }
  | { state: "unknown"; reason: "timeout" | "transport"; errorCode?: string }
  | {
      state: "pending_approval";
      intentId: string;
      stepId: string;
      tool: string;
      message: string;
    };

export type ToolInvoker = {
  invoke(input: ToolInvocationInput): Promise<ToolInvocationResult>;
};

export type IntentState =
  | "intended"
  | "sent"
  | "confirmed"
  | "failed"
  | "unknown";
