import { describe, expect, it } from "vitest";
import {
  createLlmClassifier,
  createRuleBasedClassifier,
} from "../src/agent/classifier.js";
import type { IntentClassifierInput } from "../src/agent/types.js";

const input: IntentClassifierInput = {
  conversationId: "case-1",
  message: "My UPI payment failed and my refund is pending.",
  authenticatedContext: { customerId: "customer-1", roles: ["customer"] },
};

describe("createLlmClassifier", () => {
  it("accepts a valid structured classification", async () => {
    const classifier = createLlmClassifier(async () => ({
      intents: [
        {
          intent: "UPI_PAYMENT_ISSUE",
          agent: "upi_agent",
          entities: { amount: 2000 },
        },
      ],
    }));

    const outcome = await classifier.classify(input);

    expect(outcome.status).toBe("classified");

    if (outcome.status === "classified") {
      expect(outcome.classification.intents).toHaveLength(1);
    }
  });

  it("rejects a malformed classification without falling back", async () => {
    let fallbackCalled = false;

    const classifier = createLlmClassifier(
      async () => ({ intents: "not-an-array" }),
      {
        fallback: {
          async classify() {
            fallbackCalled = true;
            return {
              status: "classified",
              classification: {
                intents: [{ intent: "UPI_PAYMENT_ISSUE", entities: {} }],
              },
            };
          },
        },
      },
    );

    const outcome = await classifier.classify(input);

    expect(outcome.status).toBe("invalid");
    expect(fallbackCalled).toBe(false);
  });

  it("uses the fallback when the model is unavailable", async () => {
    const classifier = createLlmClassifier(
      async () => {
        throw new Error("provider down");
      },
      { fallback: createRuleBasedClassifier() },
    );

    const outcome = await classifier.classify(input);

    expect(outcome.status).toBe("classified");

    if (outcome.status === "classified") {
      expect(outcome.classification.intents.map((intent) => intent.intent)).toEqual([
        "UPI_PAYMENT_ISSUE",
        "REFUND_STATUS",
      ]);
    }
  });

  it("falls back to rules when the model finds no intent", async () => {
    const classifier = createLlmClassifier(async () => ({ intents: [] }), {
      fallback: createRuleBasedClassifier(),
      name: "test-llm",
    });

    const outcome = await classifier.classify(input);

    expect(outcome).toMatchObject({
      status: "classified",
      source: "rules",
      fallbackReason: "llm_no_intents",
    });
  });

  it("records the model as the classification source", async () => {
    const classifier = createLlmClassifier(
      async () => ({ intents: [{ intent: "REFUND_STATUS", entities: {} }] }),
      { name: "sarvam:test" },
    );

    expect(await classifier.classify(input)).toMatchObject({ source: "sarvam:test" });
  });

  it("reports invalid when the model is unavailable and no fallback exists", async () => {
    const classifier = createLlmClassifier(async () => {
      throw new Error("provider down");
    });

    const outcome = await classifier.classify(input);

    expect(outcome).toMatchObject({ status: "invalid" });
  });
});

describe("createRuleBasedClassifier", () => {
  it("detects multiple intents in one message", async () => {
    const outcome = await createRuleBasedClassifier().classify(input);

    expect(outcome.status).toBe("classified");

    if (outcome.status === "classified") {
      const intents = outcome.classification.intents.map((intent) => intent.intent);
      expect(intents).toContain("UPI_PAYMENT_ISSUE");
      expect(intents).toContain("REFUND_STATUS");
    }
  });

  it("extracts a single amount only for a single-intent message", async () => {
    const outcome = await createRuleBasedClassifier().classify({
      ...input,
      message: "My refund of ₹500 has not arrived",
    });

    expect(outcome.status).toBe("classified");

    if (outcome.status === "classified") {
      expect(outcome.classification.intents).toHaveLength(1);
      expect(outcome.classification.intents[0]?.entities.amount).toBe(500);
    }
  });

  it("assigns each amount and date to the issue it belongs to", async () => {
    const outcome = await createRuleBasedClassifier().classify({
      ...input,
      message: "My UPI payment of ₹2,000 failed yesterday, and my ₹500 refund has not arrived.",
    });

    expect(outcome.status).toBe("classified");
    if (outcome.status !== "classified") return;

    const byIntent = Object.fromEntries(
      outcome.classification.intents.map((intent) => [intent.intent, intent.entities]),
    );
    expect(byIntent.UPI_PAYMENT_ISSUE).toEqual({ amount: 2000, relativeDate: "yesterday" });
    expect(byIntent.REFUND_STATUS).toEqual({ amount: 500 });
  });

  it("routes OTP problems to the account agent, not refunds", async () => {
    const outcome = await createRuleBasedClassifier().classify({
      ...input,
      message: "OTP not received, cannot login",
    });

    expect(outcome.status === "classified" && outcome.classification.intents.map((i) => i.intent))
      .toEqual(["ACCOUNT_ISSUE"]);
  });

  it("routes suspected fraud to the account agent", async () => {
    const outcome = await createRuleBasedClassifier().classify({
      ...input,
      message: "Someone hacked me and did a transaction I didn't make",
    });

    expect(outcome.status).toBe("classified");
    if (outcome.status === "classified") {
      expect(outcome.classification.intents.map((i) => i.intent)).toContain("ACCOUNT_ISSUE");
    }
  });

  it("continues the pending intent when the reply only contains a reference", async () => {
    const outcome = await createRuleBasedClassifier().classify({
      ...input,
      message: "it is txn_upi_1001",
      pendingIntents: ["REFUND_STATUS"],
    });

    expect(outcome.status).toBe("classified");
    if (outcome.status === "classified") {
      expect(outcome.classification.intents).toEqual([
        { intent: "REFUND_STATUS", confidence: 0.7, entities: { transactionId: "txn_upi_1001" } },
      ]);
    }
  });

  it("infers the intent from a bare reference", async () => {
    const outcome = await createRuleBasedClassifier().classify({ ...input, message: "cmp_9001" });

    expect(outcome.status === "classified" && outcome.classification.intents[0]?.intent).toBe(
      "COMPLAINT_STATUS",
    );
  });

  it("reads a complaint that is still open as a status question", async () => {
    const outcome = await createRuleBasedClassifier().classify({
      ...input,
      message: "my complaint is still open, what is the status?",
    });

    expect(outcome.status === "classified" && outcome.classification.intents[0]?.intent).toBe(
      "COMPLAINT_STATUS",
    );
  });

  it("returns invalid when no supported intent matches", async () => {
    const outcome = await createRuleBasedClassifier().classify({
      ...input,
      message: "What is the weather today?",
    });

    expect(outcome.status).toBe("invalid");
  });
});
