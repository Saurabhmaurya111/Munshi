import { describe, expect, it, vi } from "vitest";
import {
  createHybridClassifier,
  createLlmClassifier,
  createRuleBasedClassifier,
  extractMessageEntities,
  mergeClassificationEntities,
  shouldPreferRuleClassification,
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

  it("falls back when the classification schema is invalid", async () => {
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

    expect(outcome.status).toBe("classified");
    expect(fallbackCalled).toBe(true);
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

  it("does not invent a relativeDate when lookup filters are missing", async () => {
    const outcome = await createRuleBasedClassifier().classify({
      ...input,
      message: "My UPI payment failed",
    });

    expect(outcome.status).toBe("classified");

    if (outcome.status === "classified") {
      expect(outcome.classification.intents[0]?.entities.relativeDate).toBeUndefined();
    }
  });

  it("returns invalid when no supported intent matches", async () => {
    const outcome = await createRuleBasedClassifier().classify({
      ...input,
      message: "What is the weather today?",
    });

    expect(outcome.status).toBe("invalid");
  });

  it("routes Paytm wallet messages to wallet intents", async () => {
    const balance = await createRuleBasedClassifier().classify({
      ...input,
      message: "What is my Paytm wallet balance?",
    });
    expect(balance.status).toBe("classified");
    if (balance.status === "classified") {
      expect(balance.classification.intents.map((item) => item.intent)).toEqual([
        "WALLET_BALANCE",
      ]);
    }

    const track = await createRuleBasedClassifier().classify({
      ...input,
      message: "Track my wallet payments and UPI add money",
    });
    expect(track.status).toBe("classified");
    if (track.status === "classified") {
      expect(track.classification.intents.map((item) => item.intent)).toContain(
        "WALLET_PAYMENT_TRACK",
      );
      expect(track.classification.intents.map((item) => item.intent)).not.toContain(
        "UPI_PAYMENT_ISSUE",
      );
    }
  });
});

describe("createHybridClassifier", () => {
  it("skips the LLM when rules have one clear UPI intent with a transaction id", async () => {
    const llm = vi.fn(async () => {
      throw new Error("llm should not be called");
    });

    const classifier = createHybridClassifier({
      rules: createRuleBasedClassifier(),
      llm: createLlmClassifier(llm),
    });

    const outcome = await classifier.classify({
      ...input,
      message: "My UPI payment TXN12345 failed",
    });

    expect(llm).not.toHaveBeenCalled();
    expect(outcome.status).toBe("classified");

    if (outcome.status === "classified") {
      expect(outcome.classification.intents).toHaveLength(1);
      expect(outcome.classification.intents[0]).toMatchObject({
        intent: "UPI_PAYMENT_ISSUE",
        entities: { transactionId: "TXN12345" },
      });
    }
  });

  it("merges deterministic entities into an LLM classification", async () => {
    const classifier = createHybridClassifier({
      rules: createRuleBasedClassifier(),
      llm: createLlmClassifier(async () => ({
        intents: [
          {
            intent: "UPI_PAYMENT_ISSUE",
            confidence: 0.9,
            entities: {},
          },
        ],
      })),
    });

    const outcome = await classifier.classify({
      ...input,
      message: "Payment issue with TXN99999 please check",
    });

    expect(outcome.status).toBe("classified");

    if (outcome.status === "classified") {
      expect(outcome.classification.intents[0]?.entities.transactionId).toBe("TXN99999");
    }
  });

  it("does not overwrite LLM entity values when merging", () => {
    const merged = mergeClassificationEntities(
      {
        intents: [
          {
            intent: "UPI_PAYMENT_ISSUE",
            entities: { transactionId: "TXN_FROM_LLM" },
          },
        ],
      },
      { transactionId: "TXN_FROM_RULES", amount: 100 },
    );

    expect(merged.intents[0]?.entities).toEqual({
      transactionId: "TXN_FROM_LLM",
      amount: 100,
    });
  });

  it("prefers rules only for clear single-intent matches", () => {
    expect(
      shouldPreferRuleClassification({
        intents: [
          {
            intent: "UPI_PAYMENT_ISSUE",
            entities: { transactionId: "TXN12345" },
          },
        ],
      }),
    ).toBe(true);

    expect(
      shouldPreferRuleClassification({
        intents: [
          { intent: "UPI_PAYMENT_ISSUE", entities: {} },
          { intent: "REFUND_STATUS", entities: {} },
        ],
      }),
    ).toBe(false);
  });

  it("extracts common reference prefixes from messages", () => {
    expect(extractMessageEntities("Status of RFD12345 and CMP99999")).toMatchObject({
      refundId: "RFD12345",
      complaintId: "CMP99999",
    });
  });
});
