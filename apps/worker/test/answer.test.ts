import { describe, expect, it } from "vitest";
import {
  answerInputFrom,
  buildAnswerUserContent,
  normalizeModelAnswer,
  phraseWithModel,
  withSafetyNotes,
} from "../src/agent/answer.js";
import type { AgentTaskResult } from "../src/agent/types.js";

const draft = "Your UPI payment (TXN12345) was successful according to our payment records.";

function result(overrides: Partial<AgentTaskResult> = {}): AgentTaskResult {
  return {
    taskId: "task-1",
    agent: "upi_agent",
    status: "completed",
    response: draft,
    references: ["TXN12345"],
    ...overrides,
  };
}

describe("normalizeModelAnswer", () => {
  it("unwraps a fenced reply", () => {
    expect(normalizeModelAnswer("```\nYour payment was successful.\n```")).toBe(
      "Your payment was successful.",
    );
  });

  it("rejects JSON and empty text", () => {
    expect(normalizeModelAnswer("")).toBeUndefined();
    expect(normalizeModelAnswer('{"message":"hi"}')).toBeUndefined();
  });
});

describe("phraseWithModel", () => {
  it("uses the model reply and redacts a secret it repeats", async () => {
    const message = await phraseWithModel(
      async () => "Your OTP is 482913 and the payment was successful.",
      {
        customerMessage: "my OTP is [redacted]",
        status: "completed",
        draft,
        answers: [],
        policies: [],
      },
    );

    expect(message).toContain("payment was successful");
    expect(message).not.toContain("482913");
    expect(message).toContain("[redacted]");
  });

  it("keeps the verified draft when the model fails or returns JSON", async () => {
    const input = {
      customerMessage: "where is my payment",
      status: "completed" as const,
      draft,
      answers: [],
      policies: [],
    };

    expect(await phraseWithModel(async () => { throw new Error("down"); }, input)).toBe(draft);
    expect(await phraseWithModel(async () => '{"intents":[]}', input)).toBe(draft);
  });

  it("puts a dropped safety note back in front", () => {
    const note = "Please don't share OTPs.";
    expect(withSafetyNotes([note], "The payment was successful.")).toBe(
      `${note}\n\nThe payment was successful.`,
    );
    expect(withSafetyNotes([note], `${note}\n\nThe payment was successful.`)).toBe(
      `${note}\n\nThe payment was successful.`,
    );
  });
});

describe("answerInputFrom", () => {
  it("sends verified answers and policy excerpts, not raw tool payloads", () => {
    const input = answerInputFrom({
      customerMessage: "refund status",
      status: "completed",
      draft,
      results: [
        result({
          passages: [
            {
              citation: "refund-policy@2026-10#1",
              title: "Refund policy",
              heading: "Delayed refunds",
              content: "Escalate when the refund requires manual investigation.",
            },
          ],
        }),
      ],
    });

    expect(input.policies).toEqual([
      {
        citation: "refund-policy@2026-10#1",
        title: "Refund policy",
        heading: "Delayed refunds",
        excerpt: "Escalate when the refund requires manual investigation.",
      },
    ]);
    expect(buildAnswerUserContent(input)).toContain("TXN12345");
    expect(buildAnswerUserContent(input)).not.toContain("getTransactionStatus");
  });
});
