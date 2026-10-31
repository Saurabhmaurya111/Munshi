import { randomUUID } from "node:crypto";
import { END, START, Annotation, StateGraph } from "@langchain/langgraph";
import { aggregateResults, toTaskSummaries } from "./aggregation.js";
import { answerInputFrom, phraseWithModel, type AnswerModel } from "./answer.js";
import type { AgentRunContext, AgentRunner } from "./agents.js";
import { buildExecutionBatches, planTasks } from "./planning.js";
import { detectRiskSignals, redactSecrets } from "./risk.js";
import { supervisorRequestSchema, supervisorResponseSchema } from "./schemas.js";
import { createTraceRecorder, type SupervisorTrace, type TraceRecorder } from "./trace.js";
import { validateClassification } from "./validation.js";
import type {
  AgentTask,
  AgentTaskResult,
  AuthenticatedContext,
  ClassificationOutcome,
  IntentClassifier,
  KnowledgeLookup,
  RiskSignals,
  SupervisorRequest,
  SupervisorResponse,
  ToolInvoker,
  ValidationIssue,
  ValidationOutcome,
  WorkflowLevel,
} from "./types.js";

export const PROMPT_VERSION = "supervisor-v3";

const DEFAULT_TASK_TIMEOUT_MS = 20_000;
const GRAPH_RECURSION_LIMIT = 25;

export type SupervisorDependencies = {
  classifier: IntentClassifier;
  runner: AgentRunner;
  tools: ToolInvoker;
  workflowLevel: WorkflowLevel;
  amountApprovalThreshold?: number;
  confidenceThreshold?: number;
  knowledge?: KnowledgeLookup;
  /** Phrases the customer reply. The verified draft is kept when this is absent or fails. */
  answer?: AnswerModel;
  taskTimeoutMs?: number;
};

export type SupervisorRun = {
  response: SupervisorResponse;
  trace: SupervisorTrace;
};

const SUPPORTED_SCOPE =
  "I can help with UPI payments, refunds, mobile recharges, account and KYC questions, and complaints.";

const SECRET_WARNING =
  "For your safety, please don't share OTPs, UPI PINs, passwords, or card numbers here. I'll never ask for them, and I haven't used what you sent.";

const SECURITY_ESCALATION =
  "This may involve activity you didn't authorise, so I've flagged your case for review by our security team. Please don't share your OTP, UPI PIN, or password with anyone, including support.";

const SupervisorState = Annotation.Root({
  conversationId: Annotation<string>(),
  customerMessage: Annotation<string>(),
  authenticatedContext: Annotation<AuthenticatedContext>(),
  facts: Annotation<Record<string, unknown>>(),
  recentEvents: Annotation<string[]>(),
  pendingIntents: Annotation<string[]>(),
  turnId: Annotation<string | undefined>(),
  risk: Annotation<RiskSignals>(),
  classification: Annotation<ClassificationOutcome | null>(),
  validation: Annotation<ValidationOutcome | null>(),
  tasks: Annotation<AgentTask[]>(),
  results: Annotation<AgentTaskResult[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  response: Annotation<SupervisorResponse | null>(),
});

type State = typeof SupervisorState.State;

function validationIssues(issues: string[]): ValidationIssue[] {
  return issues.map((issue) => ({ code: "CLASSIFICATION_FAILED", message: issue }));
}

function fallbackResponse(
  conversationId: string,
  status: SupervisorResponse["status"],
  message: string,
): SupervisorResponse {
  return {
    conversationId,
    status,
    message,
    tasks: [],
    requiresCustomerInput: status === "needs_clarification",
  };
}

function customerMessageFor(validation: Exclude<ValidationOutcome, { status: "runnable" }>): string {
  switch (validation.status) {
    case "unsupported":
      return `That part of your request is outside what I can handle here. ${SUPPORTED_SCOPE}`;
    case "needs_clarification":
      return `I want to be sure I check the right thing. Could you tell me a bit more about the issue? ${SUPPORTED_SCOPE}`;
    case "invalid":
      return `I couldn't work out what you need help with. ${SUPPORTED_SCOPE} Could you describe the problem in a sentence?`;
  }
}

function responseFromValidation(state: State): SupervisorResponse {
  const validation = state.validation;

  if (!validation || validation.status === "runnable") {
    return fallbackResponse(
      state.conversationId,
      "invalid",
      "The request could not be validated safely.",
    );
  }

  const notes = state.risk.sharedSecret ? [SECRET_WARNING] : [];

  return {
    conversationId: state.conversationId,
    status: validation.status,
    message: [...notes, customerMessageFor(validation)].join("\n\n"),
    tasks: [],
    requiresCustomerInput: validation.status !== "unsupported",
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(onTimeout()), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function runTaskSafely(
  runner: AgentRunner,
  task: AgentTask,
  context: AgentRunContext,
  timeoutMs: number,
): Promise<AgentTaskResult> {
  const base = { taskId: task.taskId, agent: task.agent, intent: task.intent };

  try {
    return await withTimeout(runner(task, context), timeoutMs, () => ({
      ...base,
      status: "escalated",
      response: "This check took too long to confirm, so I've flagged it for a follow-up instead of guessing.",
      errorCode: "TASK_TIMEOUT",
    }));
  } catch {
    return {
      ...base,
      status: "failed",
      response: "Something went wrong while checking this. Please try again in a little while.",
      errorCode: "AGENT_ERROR",
    };
  }
}

export function initialSupervisorState(request: SupervisorRequest): State {
  return {
    conversationId: request.conversationId,
    customerMessage: request.message,
    authenticatedContext: request.authenticatedContext,
    facts: request.context?.facts ?? {},
    recentEvents: request.context?.recentEvents ?? [],
    pendingIntents: request.context?.pendingIntents ?? [],
    turnId: request.turnId,
    risk: detectRiskSignals(request.message),
    classification: null,
    validation: null,
    tasks: [],
    results: [],
    response: null,
  };
}

export function buildSupervisorGraph(
  dependencies: SupervisorDependencies,
  recorder?: TraceRecorder,
) {
  const tools = recorder ? recorder.tools(dependencies.tools) : dependencies.tools;
  const knowledge = recorder ? recorder.knowledge(dependencies.knowledge) : dependencies.knowledge;
  const taskTimeoutMs = dependencies.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  const graph = new StateGraph(SupervisorState)
    .addNode("classify_intents", async (state: State) => {
      let outcome: ClassificationOutcome;

      try {
        outcome = await dependencies.classifier.classify({
          conversationId: state.conversationId,
          message: redactSecrets(state.customerMessage),
          authenticatedContext: state.authenticatedContext,
          recentEvents: state.recentEvents.map(redactSecrets),
          pendingIntents: state.pendingIntents,
        });
      } catch {
        outcome = {
          status: "invalid",
          reason: "The classifier failed.",
          issues: ["classifier_error"],
        };
      }

      recorder?.classification(outcome);
      return { classification: outcome };
    })
    .addNode("validate_intents", (state: State) => {
      const outcome = state.classification;
      let validation: ValidationOutcome;

      if (!outcome || outcome.status !== "classified") {
        validation = {
          status: "invalid",
          reason:
            outcome?.status === "invalid" ? outcome.reason : "The request could not be classified.",
          issues: validationIssues(
            outcome?.status === "invalid" ? outcome.issues : ["classification_failed"],
          ),
        };
      } else {
        validation = validateClassification(outcome.classification, {
          confidenceThreshold: dependencies.confidenceThreshold,
        });
      }

      recorder?.validation(validation);
      return { validation };
    })
    .addNode("plan_tasks", (state: State) => {
      if (!state.validation || state.validation.status !== "runnable") {
        return { tasks: [] };
      }

      const tasks = planTasks(state.validation.intents, state.facts);
      recorder?.tasks(tasks);
      return { tasks };
    })
    .addNode("dispatch_tasks", async (state: State) => {
      const plan = buildExecutionBatches(state.tasks);

      if (!plan.ok) {
        return {
          results: [
            {
              taskId: "plan",
              agent: "account_agent",
              status: "failed",
              response: "The task plan could not be executed safely.",
              errorCode: "INVALID_PLAN",
            } satisfies AgentTaskResult,
          ],
        };
      }

      const resultsById = new Map<string, AgentTaskResult>();
      const results: AgentTaskResult[] = [];

      for (const batch of plan.batches) {
        const batchResults = await Promise.all(
          batch.map((task) =>
            runTaskSafely(
              dependencies.runner,
              task,
              {
                caseId: state.conversationId,
                conversationId: state.conversationId,
                customerId: state.authenticatedContext.customerId,
                workflowLevel: dependencies.workflowLevel,
                message: state.customerMessage,
                tools,
                results: resultsById,
                amountApprovalThreshold: dependencies.amountApprovalThreshold,
                risk: state.risk,
                knowledge,
                turnId: state.turnId,
              },
              taskTimeoutMs,
            ),
          ),
        );

        for (const result of batchResults) {
          resultsById.set(result.taskId, result);
          results.push(result);
        }
      }

      recorder?.results(results);
      return { results };
    })
    .addNode("aggregate_results", async (state: State) => {
      const notes = [
        ...(state.risk.sharedSecret ? [SECRET_WARNING] : []),
        ...(state.results.some((result) => result.errorCode === "FRAUD_SUSPECTED")
          ? [SECURITY_ESCALATION]
          : []),
      ];
      const aggregated =
        state.validation?.status === "runnable"
          ? aggregateResults(state.results, { notes })
          : undefined;
      const drafted: SupervisorResponse = aggregated
        ? {
            conversationId: state.conversationId,
            status: aggregated.status,
            message: aggregated.message,
            tasks: toTaskSummaries(state.results),
            requiresCustomerInput: aggregated.requiresCustomerInput,
          }
        : responseFromValidation(state);

      const message = await phraseWithModel(
        dependencies.answer,
        answerInputFrom({
          customerMessage: redactSecrets(state.customerMessage),
          status: drafted.status,
          draft: drafted.message,
          results: state.results,
        }),
        notes,
      );

      return {
        response: { ...drafted, message } satisfies SupervisorResponse,
      };
    })
    .addNode("format_response", (state: State) => {
      if (!state.response) {
        return {
          response: fallbackResponse(
            state.conversationId,
            "invalid",
            "The request could not be completed.",
          ),
        };
      }

      const checked = supervisorResponseSchema.safeParse(state.response);

      if (!checked.success) {
        return {
          response: fallbackResponse(
            state.conversationId,
            "invalid",
            "The response could not be validated safely.",
          ),
        };
      }

      return { response: checked.data as SupervisorResponse };
    })
    .addEdge(START, "classify_intents")
    .addEdge("classify_intents", "validate_intents")
    .addEdge("validate_intents", "plan_tasks")
    .addConditionalEdges("plan_tasks", (state: State) =>
      state.tasks.length > 0 ? "dispatch_tasks" : "aggregate_results",
    )
    .addEdge("dispatch_tasks", "aggregate_results")
    .addEdge("aggregate_results", "format_response")
    .addEdge("format_response", END);

  return graph.compile();
}

function requestConversationId(request: unknown): string {
  return request !== null &&
    typeof request === "object" &&
    typeof (request as { conversationId?: unknown }).conversationId === "string"
    ? (request as { conversationId: string }).conversationId
    : "unknown";
}

export async function runSupervisorWithTrace(
  request: unknown,
  dependencies: SupervisorDependencies,
): Promise<SupervisorRun> {
  const parsed = supervisorRequestSchema.safeParse(request);

  if (!parsed.success) {
    const recorder = createTraceRecorder({
      runId: randomUUID(),
      promptVersion: PROMPT_VERSION,
      risk: { fraudSuspected: false, sharedSecret: false },
    });

    return {
      response: fallbackResponse(
        requestConversationId(request),
        "invalid",
        "The request could not be validated.",
      ),
      trace: recorder.finish(),
    };
  }

  const initial = initialSupervisorState(parsed.data);
  const recorder = createTraceRecorder({
    runId: randomUUID(),
    correlationId: parsed.data.correlationId,
    promptVersion: PROMPT_VERSION,
    risk: initial.risk,
  });

  const graph = buildSupervisorGraph(dependencies, recorder);
  const state = await graph.invoke(initial, { recursionLimit: GRAPH_RECURSION_LIMIT });
  const checked = state.response ? supervisorResponseSchema.safeParse(state.response) : null;

  return {
    response:
      checked?.success === true
        ? (checked.data as SupervisorResponse)
        : fallbackResponse(
            state.conversationId,
            "invalid",
            "The response could not be validated safely.",
          ),
    trace: recorder.finish(),
  };
}

export async function runSupervisor(
  request: unknown,
  dependencies: SupervisorDependencies,
): Promise<SupervisorResponse> {
  return (await runSupervisorWithTrace(request, dependencies)).response;
}
