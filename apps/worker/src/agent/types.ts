export type AgentName =
  | "upi_agent"
  | "refund_agent"
  | "recharge_agent"
  | "account_agent"
  | "complaint_agent"
  | "wallet_agent";

export type Domain =
  | "upi"
  | "refund"
  | "recharge"
  | "account"
  | "complaint"
  | "wallet";

export type ToolRisk = "read" | "write" | "money";

export type WorkflowLevel = 0 | 1 | 2;

export type AuthenticatedContext = {
  customerId: string;
  roles: string[];
};

export type SupervisorContext = {
  facts?: Record<string, unknown>;
  recentEvents?: string[];
  /** Intents from the previous turn that were waiting on customer input. */
  pendingIntents?: string[];
};

export type SupervisorRequest = {
  conversationId: string;
  message: string;
  authenticatedContext: AuthenticatedContext;
  context?: SupervisorContext;
  correlationId?: string;
  /**
   * Stable id of the customer event that triggered this turn. Part of every
   * tool step id, so a retried turn reuses its idempotency keys and a new turn does not.
   */
  turnId?: string;
};

export type RiskSignals = {
  fraudSuspected: boolean;
  sharedSecret: boolean;
};

export type KnowledgePassage = {
  documentId: string;
  documentTitle: string;
  documentVersion: string;
  chunkIndex: number;
  heading?: string;
  content: string;
  score: number;
};

/** Policy text kept for the answer model. It is not copied onto the customer event. */
export type GroundingPassage = {
  citation: string;
  title: string;
  heading?: string;
  content: string;
};

export type KnowledgeLookup = (input: {
  query: string;
  category: Domain;
}) => Promise<KnowledgePassage[]>;

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
  intent?: string;
  status: TaskStatus;
  response: string;
  references?: string[];
  /** Policy passages the answer was grounded on, as `documentId@version#chunk`. */
  citations?: string[];
  /** Passage text used to phrase the reply. Omitted from task summaries. */
  passages?: GroundingPassage[];
  observations?: ToolObservation[];
  errorCode?: string;
};

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

export type IntentClassifierInput = {
  conversationId: string;
  message: string;
  authenticatedContext: AuthenticatedContext;
  recentEvents?: string[];
  pendingIntents?: string[];
};

export type ClassificationOutcome =
  | {
      status: "classified";
      classification: RawClassification;
      source?: string;
      fallbackReason?: string;
    }
  | { status: "invalid"; reason: string; issues: string[]; source?: string };

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
  citations?: string[];
  errorCode?: string;
};

export type SupervisorResponse = {
  conversationId: string;
  status: RunStatus;
  message: string;
  tasks: SupervisorTaskSummary[];
  requiresCustomerInput: boolean;
};
