import { END, START, Annotation, StateGraph } from "@langchain/langgraph";
import { aggregateResults, toTaskSummaries } from "./aggregation.js";
import type { AgentRunner } from "./agents.js";
import { evaluateReplyPolicy } from "./policy.js";
import { buildExecutionBatches, planTasks } from "./planning.js";
import { supervisorRequestSchema, supervisorResponseSchema } from "./schemas.js";
import { validateClassification } from "./validation.js";
import type {
  AgentTask,
  AgentTaskResult,
  AuthenticatedContext,
  ClassificationOutcome,
  IntentClassifier,
  SupervisorRequest,
  SupervisorResponse,
  ToolInvoker,
  ValidationIssue,
  ValidationOutcome,
  WorkflowLevel,
} from "./types.js";

export type SupervisorDependencies = {
  classifier: IntentClassifier;
  runner: AgentRunner;
  tools: ToolInvoker;
  workflowLevel: WorkflowLevel;
  amountApprovalThreshold?: number;
  confidenceThreshold?: number;
};

const SupervisorState = Annotation.Root({
  conversationId: Annotation<string>(),
  customerMessage: Annotation<string>(),
  authenticatedContext: Annotation<AuthenticatedContext>(),
  facts: Annotation<Record<string, unknown>>(),
  recentEvents: Annotation<string[]>(),
  classification: Annotation<ClassificationOutcome | null>(),
  validation: Annotation<ValidationOutcome | null>(),
  tasks: Annotation<AgentTask[]>(),
  results: Annotation<AgentTaskResult[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  response: Annotation<SupervisorResponse | null>(),
});

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

function responseFromValidation(state: typeof SupervisorState.State): SupervisorResponse {
  const validation = state.validation;

  if (!validation || validation.status === "runnable") {
    return fallbackResponse(
      state.conversationId,
      "invalid",
      "The request could not be validated safely.",
    );
  }

  return {
    conversationId: state.conversationId,
    status: validation.status,
    message: validation.reason,
    tasks: [],
    requiresCustomerInput: validation.status === "needs_clarification",
  };
}

function applyReplyPolicy(
  response: SupervisorResponse,
  workflowLevel: WorkflowLevel,
): SupervisorResponse {
  const decision = evaluateReplyPolicy(workflowLevel);

  if (decision.decision !== "hold_for_approval") {
    return response;
  }

  // Tool policy already escalated — keep the agent wording (mentions approval).
  if (response.status === "escalated") {
    return response;
  }

  return {
    ...response,
    status: "escalated",
    message:
      "This reply is waiting for human approval before it is sent to the customer.",
    requiresCustomerInput: false,
  };
}

export function initialSupervisorState(
  request: SupervisorRequest,
): typeof SupervisorState.State {
  return {
    conversationId: request.conversationId,
    customerMessage: request.message,
    authenticatedContext: request.authenticatedContext,
    facts: request.context?.facts ?? {},
    recentEvents: request.context?.recentEvents ?? [],
    classification: null,
    validation: null,
    tasks: [],
    results: [],
    response: null,
  };
}

export function buildSupervisorGraph(dependencies: SupervisorDependencies) {
  const graph = new StateGraph(SupervisorState)
    .addNode("classify_intents", async (state: typeof SupervisorState.State) => {
      const outcome = await dependencies.classifier.classify({
        conversationId: state.conversationId,
        message: state.customerMessage,
        authenticatedContext: state.authenticatedContext,
        recentEvents: state.recentEvents,
      });

      return { classification: outcome };
    })
    .addNode("validate_intents", (state: typeof SupervisorState.State) => {
      const outcome = state.classification;

      if (!outcome || outcome.status !== "classified") {
        return {
          validation: {
            status: "invalid",
            reason:
              outcome?.status === "invalid"
                ? outcome.reason
                : "The request could not be classified.",
            issues: validationIssues(
              outcome?.status === "invalid" ? outcome.issues : ["classification_failed"],
            ),
          } satisfies ValidationOutcome,
        };
      }

      return {
        validation: validateClassification(outcome.classification, {
          confidenceThreshold: dependencies.confidenceThreshold,
        }),
      };
    })
    .addNode("plan_tasks", (state: typeof SupervisorState.State) => {
      if (!state.validation || state.validation.status !== "runnable") {
        return { tasks: [] };
      }

      return { tasks: planTasks(state.validation.intents, state.facts) };
    })
    .addNode("dispatch_tasks", async (state: typeof SupervisorState.State) => {
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
            dependencies.runner(task, {
              caseId: state.conversationId,
              conversationId: state.conversationId,
              customerId: state.authenticatedContext.customerId,
              workflowLevel: dependencies.workflowLevel,
              message: state.customerMessage,
              tools: dependencies.tools,
              results: resultsById,
              amountApprovalThreshold: dependencies.amountApprovalThreshold,
            }),
          ),
        );

        for (const result of batchResults) {
          resultsById.set(result.taskId, result);
          results.push(result);
        }
      }

      return { results };
    })
    .addNode("aggregate_results", (state: typeof SupervisorState.State) => {
      if (!state.validation || state.validation.status !== "runnable") {
        return { response: responseFromValidation(state) };
      }

      const aggregated = aggregateResults(state.results);
      const response = applyReplyPolicy(
        {
          conversationId: state.conversationId,
          status: aggregated.status,
          message: aggregated.message,
          tasks: toTaskSummaries(state.results),
          requiresCustomerInput: aggregated.requiresCustomerInput,
        },
        dependencies.workflowLevel,
      );

      return { response };
    })
    .addEdge(START, "classify_intents")
    .addEdge("classify_intents", "validate_intents")
    .addConditionalEdges("validate_intents", (state: typeof SupervisorState.State) =>
      state.validation?.status === "runnable" ? "plan_tasks" : "aggregate_results",
    )
    .addConditionalEdges("plan_tasks", (state: typeof SupervisorState.State) =>
      state.tasks.length > 0 ? "dispatch_tasks" : "aggregate_results",
    )
    .addEdge("dispatch_tasks", "aggregate_results")
    .addEdge("aggregate_results", END);

  return graph.compile();
}

export async function runSupervisor(
  request: unknown,
  dependencies: SupervisorDependencies,
): Promise<SupervisorResponse> {
  const parsed = supervisorRequestSchema.safeParse(request);

  if (!parsed.success) {
    const conversationId =
      request !== null &&
      typeof request === "object" &&
      typeof (request as { conversationId?: unknown }).conversationId === "string"
        ? ((request as { conversationId: string }).conversationId)
        : "unknown";

    return fallbackResponse(
      conversationId,
      "invalid",
      "The request could not be validated.",
    );
  }

  const graph = buildSupervisorGraph(dependencies);
  const state = await graph.invoke(initialSupervisorState(parsed.data));

  if (!state.response) {
    return fallbackResponse(
      state.conversationId,
      "invalid",
      "The request could not be completed.",
    );
  }

  const checked = supervisorResponseSchema.safeParse(state.response);

  return checked.success
    ? (checked.data as SupervisorResponse)
    : fallbackResponse(state.conversationId, "invalid", "The response could not be validated safely.");
}
