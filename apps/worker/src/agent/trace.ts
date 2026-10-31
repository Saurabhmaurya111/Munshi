import type {
  AgentTask,
  AgentTaskResult,
  ClassificationOutcome,
  Domain,
  KnowledgeLookup,
  RiskSignals,
  ToolInvoker,
  ValidationOutcome,
} from "./types.js";

export type ToolCallTrace = {
  stepId: string;
  tool: string;
  state: "confirmed" | "failed" | "unknown";
  errorCode?: string;
  durationMs: number;
};

export type RetrievalTrace = {
  category: Domain;
  citations: string[];
  durationMs: number;
  error?: string;
};

export type TaskTrace = {
  taskId: string;
  intent: string;
  agent: string;
  dependsOn: string[];
  status?: AgentTaskResult["status"];
  errorCode?: string;
  references?: string[];
  citations?: string[];
};

/** Audit record for one graph run. Holds no message text and no tool arguments. */
export type SupervisorTrace = {
  runId: string;
  correlationId?: string;
  promptVersion: string;
  startedAt: string;
  durationMs: number;
  classification?: {
    status: ClassificationOutcome["status"];
    source?: string;
    fallbackReason?: string;
    intents: string[];
    issues?: string[];
  };
  validation?: {
    status: ValidationOutcome["status"];
    reason?: string;
    codes?: string[];
  };
  risk: RiskSignals;
  tasks: TaskTrace[];
  toolCalls: ToolCallTrace[];
  retrievals: RetrievalTrace[];
  pendingIntents: string[];
};

export type TraceRecorder = {
  trace: SupervisorTrace;
  tools(inner: ToolInvoker): ToolInvoker;
  knowledge(inner: KnowledgeLookup | undefined): KnowledgeLookup | undefined;
  classification(outcome: ClassificationOutcome): void;
  validation(outcome: ValidationOutcome): void;
  tasks(tasks: AgentTask[]): void;
  results(results: AgentTaskResult[]): void;
  finish(): SupervisorTrace;
};

export function createTraceRecorder(input: {
  runId: string;
  correlationId?: string;
  promptVersion: string;
  risk: RiskSignals;
  now?: () => number;
}): TraceRecorder {
  const now = input.now ?? (() => Date.now());
  const started = now();
  const trace: SupervisorTrace = {
    runId: input.runId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    promptVersion: input.promptVersion,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    risk: input.risk,
    tasks: [],
    toolCalls: [],
    retrievals: [],
    pendingIntents: [],
  };

  return {
    trace,

    tools(inner) {
      return {
        async invoke(call) {
          const begin = now();
          const result = await inner.invoke(call);
          trace.toolCalls.push({
            stepId: call.stepId,
            tool: call.tool,
            state: result.state,
            ...(result.state !== "confirmed" && result.errorCode
              ? { errorCode: result.errorCode }
              : {}),
            durationMs: now() - begin,
          });
          return result;
        },
      };
    },

    knowledge(inner) {
      if (!inner) {
        return undefined;
      }

      return async (query) => {
        const begin = now();

        try {
          const passages = await inner(query);
          trace.retrievals.push({
            category: query.category,
            citations: passages.map(
              (passage) =>
                `${passage.documentId}@${passage.documentVersion}#${passage.chunkIndex}`,
            ),
            durationMs: now() - begin,
          });
          return passages;
        } catch (error) {
          trace.retrievals.push({
            category: query.category,
            citations: [],
            durationMs: now() - begin,
            error: error instanceof Error ? error.message.slice(0, 200) : "retrieval_failed",
          });
          throw error;
        }
      };
    },

    classification(outcome) {
      trace.classification =
        outcome.status === "classified"
          ? {
              status: outcome.status,
              source: outcome.source,
              fallbackReason: outcome.fallbackReason,
              intents: outcome.classification.intents.map((intent) => intent.intent),
            }
          : {
              status: outcome.status,
              source: outcome.source,
              intents: [],
              issues: outcome.issues.slice(0, 10),
            };
    },

    validation(outcome) {
      trace.validation =
        outcome.status === "runnable"
          ? { status: outcome.status }
          : outcome.status === "invalid"
            ? {
                status: outcome.status,
                reason: outcome.reason,
                codes: outcome.issues.map((issue) => issue.code),
              }
            : { status: outcome.status, reason: outcome.reason };
    },

    tasks(tasks) {
      trace.tasks = tasks.map((task) => ({
        taskId: task.taskId,
        intent: task.intent,
        agent: task.agent,
        dependsOn: task.dependsOn,
      }));
    },

    results(results) {
      for (const result of results) {
        const task = trace.tasks.find((entry) => entry.taskId === result.taskId);

        if (!task) {
          continue;
        }

        task.status = result.status;
        if (result.errorCode) task.errorCode = result.errorCode;
        if (result.references?.length) task.references = result.references;
        if (result.citations?.length) task.citations = result.citations;
      }

      trace.pendingIntents = trace.tasks
        .filter((task) => task.status === "needs_clarification")
        .map((task) => task.intent);
    },

    finish() {
      trace.durationMs = now() - started;
      return trace;
    },
  };
}
