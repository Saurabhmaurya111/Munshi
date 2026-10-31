import { describe, expect, it } from "vitest";
import { validateClassification } from "../src/agent/validation.js";
import type { RawClassification } from "../src/agent/types.js";

function classification(
  intents: RawClassification["intents"],
): RawClassification {
  return { intents };
}

describe("validateClassification", () => {
  it("accepts a valid single intent and maps the agent deterministically", () => {
    const outcome = validateClassification(
      classification([
        {
          intent: "UPI_PAYMENT_ISSUE",
          agent: "upi_agent",
          confidence: 0.9,
          entities: { transactionId: "TXN12345", amount: 2000 },
        },
      ]),
    );

    expect(outcome.status).toBe("runnable");

    if (outcome.status !== "runnable") {
      return;
    }

    expect(outcome.intents).toHaveLength(1);
    expect(outcome.intents[0]).toMatchObject({
      intent: "UPI_PAYMENT_ISSUE",
      agent: "upi_agent",
      domain: "upi",
      entities: { transactionId: "TXN12345", amount: 2000 },
    });
  });

  it("rejects an intent outside the supported registry", () => {
    const outcome = validateClassification(
      classification([{ intent: "ISSUE_REFUND", entities: {} }]),
    );

    expect(outcome.status).toBe("unsupported");

    if (outcome.status === "unsupported") {
      expect(outcome.unsupported).toEqual(["ISSUE_REFUND"]);
    }
  });

  it("keeps supported intents when an unsupported sibling is present", () => {
    const outcome = validateClassification(
      classification([
        { intent: "ISSUE_REFUND", entities: {} },
        {
          intent: "UPI_PAYMENT_ISSUE",
          confidence: 0.9,
          entities: { transactionId: "TXN12345" },
        },
      ]),
    );

    expect(outcome.status).toBe("runnable");

    if (outcome.status === "runnable") {
      expect(outcome.intents.map((intent) => intent.intent)).toEqual([
        "UPI_PAYMENT_ISSUE",
      ]);
    }
  });

  it("rejects an agent that does not match the intent mapping", () => {
    const outcome = validateClassification(
      classification([
        {
          intent: "UPI_PAYMENT_ISSUE",
          agent: "refund_agent",
          entities: { transactionId: "TXN12345" },
        },
      ]),
    );

    expect(outcome.status).toBe("invalid");

    if (outcome.status === "invalid") {
      expect(outcome.issues.map((issue) => issue.code)).toContain(
        "AGENT_MAPPING_MISMATCH",
      );
    }
  });

  it("rejects an agent outside the allowlist", () => {
    const outcome = validateClassification(
      classification([
        {
          intent: "UPI_PAYMENT_ISSUE",
          agent: "shell_agent",
          entities: {},
        },
      ]),
    );

    expect(outcome.status).toBe("invalid");

    if (outcome.status === "invalid") {
      expect(outcome.issues.map((issue) => issue.code)).toContain(
        "AGENT_NOT_ALLOWED",
      );
    }
  });

  it("asks for clarification instead of dispatching on low confidence", () => {
    const outcome = validateClassification(
      classification([
        {
          intent: "REFUND_STATUS",
          confidence: 0.2,
          entities: { transactionId: "TXN12345" },
        },
      ]),
    );

    expect(outcome.status).toBe("needs_clarification");
  });

  it("asks for clarification when the same intent has conflicting records", () => {
    const outcome = validateClassification(
      classification([
        {
          intent: "UPI_PAYMENT_ISSUE",
          entities: { transactionId: "TXN12345" },
        },
        {
          intent: "UPI_PAYMENT_ISSUE",
          entities: { transactionId: "TXN67890" },
        },
      ]),
    );

    expect(outcome.status).toBe("needs_clarification");
  });

  it("deduplicates identical repeated intents", () => {
    const outcome = validateClassification(
      classification([
        {
          intent: "UPI_PAYMENT_ISSUE",
          entities: { transactionId: "TXN12345" },
        },
        {
          intent: "UPI_PAYMENT_ISSUE",
          entities: { transactionId: "TXN12345" },
        },
      ]),
    );

    expect(outcome.status).toBe("runnable");

    if (outcome.status === "runnable") {
      expect(outcome.intents).toHaveLength(1);
    }
  });

  it("rejects invalid entity values instead of coercing them", () => {
    const outcome = validateClassification(
      classification([
        {
          intent: "UPI_PAYMENT_ISSUE",
          entities: { amount: -500 },
        },
      ]),
    );

    expect(outcome.status).toBe("invalid");
  });

  it("drops an intent with invalid entities when another intent is valid", () => {
    const outcome = validateClassification(
      classification([
        {
          intent: "UPI_PAYMENT_ISSUE",
          confidence: 0.9,
          entities: { amount: -500 },
        },
        {
          intent: "REFUND_STATUS",
          confidence: 0.9,
          entities: { refundId: "RFD12345" },
        },
      ]),
    );

    expect(outcome.status).toBe("runnable");

    if (outcome.status === "runnable") {
      expect(outcome.intents.map((intent) => intent.intent)).toEqual([
        "REFUND_STATUS",
      ]);
    }
  });

  it("treats omitted confidence as threshold-edge rather than certainty", () => {
    const outcome = validateClassification(
      classification([
        {
          intent: "UPI_PAYMENT_ISSUE",
          entities: { transactionId: "TXN12345" },
        },
      ]),
      { confidenceThreshold: 0.51 },
    );

    expect(outcome.status).toBe("needs_clarification");
  });

  it("drops untrusted entity keys such as customerId and tool names", () => {
    const outcome = validateClassification(
      classification([
        {
          intent: "UPI_PAYMENT_ISSUE",
          entities: {
            transactionId: "TXN12345",
            customerId: "customer-evil",
            tool: "issueRefund",
          },
        },
      ]),
    );

    expect(outcome.status).toBe("runnable");

    if (outcome.status === "runnable") {
      expect(outcome.intents[0]?.entities.customerId).toBeUndefined();
      expect(outcome.intents[0]?.entities.tool).toBeUndefined();
      expect(outcome.intents[0]?.entities.transactionId).toBe("TXN12345");
    }
  });

  it("marks a missing required entity without discarding the intent", () => {
    const outcome = validateClassification(
      classification([
        {
          intent: "COMPLAINT_STATUS",
          entities: {},
        },
      ]),
    );

    expect(outcome.status).toBe("runnable");

    if (outcome.status === "runnable") {
      expect(outcome.intents[0]?.missingEntities).toEqual(["complaintId"]);
    }
  });
});
