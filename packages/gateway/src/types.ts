export type ToolInvocationInput = {
  caseId: string;
  stepId: string;
  tool: string;
  args: Record<string, unknown>;
  customerId: string;
};

export type ToolInvocationResult =
  | { state: "confirmed"; data: unknown }
  | { state: "failed"; errorCode: string; message: string }
  | { state: "unknown"; reason: "timeout" | "transport"; errorCode?: string };

export type ToolInvoker = {
  invoke(input: ToolInvocationInput): Promise<ToolInvocationResult>;
};

export type IntentState =
  | "intended"
  | "sent"
  | "confirmed"
  | "failed"
  | "unknown";
