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

  it("returns invalid when no supported intent matches", async () => {
    const outcome = await createRuleBasedClassifier().classify({
      ...input,
      message: "What is the weather today?",
    });

    expect(outcome.status).toBe("invalid");
  });
});
