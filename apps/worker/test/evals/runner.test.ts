import { describe, expect, it } from "vitest";
import type { EvalScenario, MockToolResult } from "../../../../evals/schema.js";
import { createAgentRunner } from "../../src/agent/agents.js";
import { runSupervisor } from "../../src/agent/supervisor.js";
import type {
  IntentClassifier,
  RawClassification,
  ToolInvocationResult,
  WorkflowLevel,
} from "../../src/agent/types.js";
import { createFakeInvoker, type ToolHandler } from "../helpers.js";
import { loadScenarios, loadThresholds } from "./load-scenarios.js";
import { aggregateScores, scoreCase } from "./score.js";

function classifierFor(classification: RawClassification): IntentClassifier {
  return {
    async classify() {
      return { status: "classified", classification };
    },
  };
}

function toInvocationResult(result: MockToolResult): ToolInvocationResult {
  if (result.state === "confirmed") {
    return { state: "confirmed", data: result.data };
  }

  if (result.state === "failed") {
    return {
      state: "failed",
      errorCode: result.errorCode,
      message: result.message ?? result.errorCode,
    };
  }

  return {
    state: "unknown",
    reason: result.reason ?? "timeout",
    errorCode: result.errorCode,
  };
}

function handlersFromMocks(
  mockTools: EvalScenario["mockTools"],
): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};

  for (const [tool, result] of Object.entries(mockTools)) {
    handlers[tool] = () => toInvocationResult(result);
  }

  return handlers;
}

async function runScenario(scenario: EvalScenario) {
  const { invoker, calls } = createFakeInvoker(handlersFromMocks(scenario.mockTools));
  const workflowLevel = (scenario.input.workflowLevel ?? 2) as WorkflowLevel;

  const response = await runSupervisor(
    {
      conversationId: scenario.input.conversationId ?? `eval-${scenario.id}`,
      message: scenario.input.message,
      authenticatedContext: scenario.input.authenticatedContext,
    },
    {
      classifier: classifierFor(scenario.classification),
      runner: createAgentRunner(),
      tools: invoker,
      workflowLevel,
    },
  );

  return { response, calls };
}

describe("offline eval suite", async () => {
  const thresholds = await loadThresholds();
  const scenarios = await loadScenarios(thresholds.datasetVersion);

  it.each(scenarios.map((scenario) => [scenario.id, scenario] as const))(
    "scenario %s",
    async (_id, scenario) => {
      const { response, calls } = await runScenario(scenario);
      const score = scoreCase(scenario, response, calls);

      expect(score.failures, score.failures.join("; ")).toEqual([]);
      expect(score.pass).toBe(true);
      expect(score.wrongAction).toBe(false);
      expect(score.injectionSuccess).toBe(false);
    },
  );

  it("meets dataset gate thresholds", async () => {
    const scores = [];

    for (const scenario of scenarios) {
      const { response, calls } = await runScenario(scenario);
      scores.push(scoreCase(scenario, response, calls));
    }

    const suite = aggregateScores(scores, thresholds);

    expect(suite.gateFailures, suite.gateFailures.join("; ")).toEqual([]);
    expect(suite.gatesPass).toBe(true);
    expect(suite.wrongActionRate).toBeLessThanOrEqual(thresholds.wrongActionRate);
    expect(suite.injectionSuccessRate).toBeLessThanOrEqual(
      thresholds.injectionSuccessRate,
    );
    expect(suite.planValidityRate).toBeGreaterThanOrEqual(thresholds.planValidityMin);
    expect(suite.toolSelectionRate).toBeGreaterThanOrEqual(thresholds.toolSelectionMin);
  });
});
