export type AgentName =
  | "upi_agent"
  | "refund_agent"
  | "recharge_agent"
  | "account_agent"
  | "complaint_agent";

export type Domain = "upi" | "refund" | "recharge" | "account" | "complaint";

export type ToolRisk = "read" | "write" | "money";

export type WorkflowLevel = 0 | 1 | 2;

export type AuthenticatedContext = {
  customerId: string;
  roles: string[];
};

export type SupervisorContext = {
  facts?: Record<string, unknown>;
  recentEvents?: string[];
};

export type SupervisorRequest = {
  conversationId: string;
  message: string;
  authenticatedContext: AuthenticatedContext;
  context?: SupervisorContext;
};

export type RawClassificationIntent = {
  intent: string;
  agent?: string;
  confidence?: number;
  entities: Record<string, unknown>;
};

export type RawClassification = {
  intents: RawClassificationIntent[];
};

export type ValidatedIntent = {
  intent: string;
  agent: AgentName;
  domain: Domain;
  entities: Record<string, unknown>;
  missingEntities: string[];
  confidence: number;
};

export type ValidationIssue = {
  code: string;
  message: string;
  intent?: string;
};

export type ValidationOutcome =
  | { status: "runnable"; intents: ValidatedIntent[] }
  | { status: "needs_clarification"; reason: string; missing: string[] }
  | { status: "unsupported"; reason: string; unsupported: string[] }
  | { status: "invalid"; reason: string; issues: ValidationIssue[] };

export type AgentTask = {
  taskId: string;
  intent: string;
  agent: AgentName;
  domain: Domain;
  entities: Record<string, unknown>;
  dependsOn: string[];
  missingEntities: string[];
  confidence: number;
};

export type TaskStatus =
  | "completed"
  | "needs_clarification"
  | "failed"
  | "escalated";

export type ToolObservation = {
  tool: string;
  state: "confirmed" | "failed" | "unknown";
  data?: unknown;
  errorCode?: string;
};

export type AgentTaskResult = {
  taskId: string;
  agent: AgentName;
  status: TaskStatus;
  response: string;
  references?: string[];
  observations?: ToolObservation[];
  errorCode?: string;
  data?: Record<string, unknown>;
};

export type ToolInvocationInput = {
  caseId: string;
  stepId: string;
  tool: string;
  args: Record<string, unknown>;
  customerId: string;
  executeApproved?: boolean;
  approvedBy?: string;
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

export type IntentClassifierInput = {
  conversationId: string;
  message: string;
  authenticatedContext: AuthenticatedContext;
  recentEvents?: string[];
};

export type ClassificationOutcome =
  | { status: "classified"; classification: RawClassification }
  | { status: "invalid"; reason: string; issues: string[] };

export type IntentClassifier = {
  classify(input: IntentClassifierInput): Promise<ClassificationOutcome>;
};

export type RunStatus =
  | "completed"
  | "needs_clarification"
  | "failed"
  | "escalated"
  | "partial"
  | "unsupported"
  | "invalid";

export type SupervisorTaskSummary = {
  taskId: string;
  agent: AgentName;
  status: TaskStatus;
  summary: string;
  references?: string[];
  errorCode?: string;
  data?: Record<string, unknown>;
};

export type SupervisorResponse = {
  conversationId: string;
  status: RunStatus;
  message: string;
  tasks: SupervisorTaskSummary[];
  requiresCustomerInput: boolean;
};
