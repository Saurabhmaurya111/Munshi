import { describe, expect, it } from "vitest";
import type { EvalScenario, JudgeVerdict } from "../../../../evals/schema.js";
import type { SupervisorResponse } from "../../src/agent/types.js";
import {
  buildJudgeUserPayload,
  createLlmJudge,
  loadJudgeRubric,
} from "./judge.js";
import { aggregateScores, scoreCase } from "./score.js";
import { loadThresholds } from "./load-scenarios.js";

const scenario: EvalScenario = {
  id: "judge-fixture",
  version: "2026-10",
  tags: ["easy"],
  input: {
    message: "Status of TXN12345?",
    authenticatedContext: { customerId: "customer-eval-001", roles: ["customer"] },
    workflowLevel: 2,
  },
  classification: {
    intents: [{ intent: "UPI_PAYMENT_ISSUE", entities: { transactionId: "TXN12345" } }],
  },
  mockTools: {
    getTransactionStatus: {
      state: "confirmed",
      data: { status: "failed", transactionId: "TXN12345" },
    },
  },
  expect: {
    status: "completed",
    toolsMustRun: ["getTransactionStatus"],
    toolsMustNotRun: ["createComplaint"],
    escalate: false,
    replyMustMatch: ["failed"],
    replyMustNotMatch: ["refunded"],
    wrongActionIf: ["createComplaint"],
  },
};

const response: SupervisorResponse = {
  conversationId: "eval-judge-fixture",
  status: "completed",
  message: 'Verified: getTransactionStatus returned status "failed".',
  tasks: [
    {
      taskId: "task-1",
      agent: "upi_agent",
      status: "completed",
      summary: 'Verified: getTransactionStatus returned status "failed".',
    },
  ],
  requiresCustomerInput: false,
};

const passingVerdict: JudgeVerdict = {
  groundedness: { pass: true, score: 1, rationale: "Status matches mock facts." },
  clarity: { pass: true, score: 0.9, rationale: "Clear enough." },
  tone: { pass: true, score: 0.9, rationale: "Neutral support tone." },
  etaHonesty: { pass: true, score: 1, rationale: "No invented ETA." },
};

describe("LLM judge", () => {
  it("loads the written rubric", async () => {
    const rubric = await loadJudgeRubric();
    expect(rubric).toContain("groundedness");
    expect(rubric).toContain("etaHonesty");
  });

  it("builds a judge payload with mock facts and reply", () => {
    const payload = JSON.parse(
      buildJudgeUserPayload({
        scenario,
        response,
        calledTools: ["getTransactionStatus"],
      }),
    ) as {
      assistantReply: string;
      mockToolFacts: Record<string, unknown>;
    };

    expect(payload.assistantReply).toContain("failed");
    expect(payload.mockToolFacts.getTransactionStatus).toMatchObject({
      state: "confirmed",
    });
  });

  it("parses a structured verdict from the model", async () => {
    const rubric = await loadJudgeRubric();
    const judge = createLlmJudge(async () => passingVerdict, rubric);
    const verdict = await judge.judge({
      scenario,
      response,
      calledTools: ["getTransactionStatus"],
    });

    expect(verdict.groundedness.pass).toBe(true);
    expect(verdict.etaHonesty.pass).toBe(true);
  });

  it("rejects a malformed judge response", async () => {
    const rubric = await loadJudgeRubric();
    const judge = createLlmJudge(async () => ({ groundedness: "nope" }), rubric);

    await expect(
      judge.judge({
        scenario,
        response,
        calledTools: ["getTransactionStatus"],
      }),
    ).rejects.toThrow();
  });

  it("gates on groundedness failure but not tone alone", async () => {
    const thresholds = await loadThresholds();
    const calls = [
      {
        caseId: "c1",
        stepId: "s1",
        tool: "getTransactionStatus",
        args: { transactionId: "TXN12345" },
        customerId: "customer-eval-001",
      },
    ];

    const toneOnly = scoreCase(scenario, response, calls, {
      ...passingVerdict,
      tone: { pass: false, score: 0.2, rationale: "Slightly curt." },
    });
    expect(toneOnly.pass).toBe(true);
    expect(toneOnly.toneFail).toBe(true);

    const ungrounded = scoreCase(scenario, response, calls, {
      ...passingVerdict,
      groundedness: {
        pass: false,
        score: 0,
        rationale: "Invented a refund.",
      },
    });
    expect(ungrounded.pass).toBe(false);
    expect(ungrounded.groundednessFail).toBe(true);

    const suite = aggregateScores([toneOnly, ungrounded], thresholds);
    expect(suite.toneFailRate).toBeGreaterThan(0);
    expect(suite.groundednessFailRate).toBeGreaterThan(0);
    expect(suite.gatesPass).toBe(false);
    expect(suite.gateFailures.some((item) => item.includes("groundedness"))).toBe(
      true,
    );
  });
});
