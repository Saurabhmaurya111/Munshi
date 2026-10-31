import { rawClassificationSchema } from "./schemas.js";
import type {
  ClassificationOutcome,
  IntentClassifier,
  IntentClassifierInput,
  RawClassification,
  RawClassificationIntent,
} from "./types.js";

export type ClassificationModel = (
  input: IntentClassifierInput,
) => Promise<unknown>;

export type LlmClassifierOptions = {
  fallback?: IntentClassifier;
};

export function createLlmClassifier(
  model: ClassificationModel,
  options: LlmClassifierOptions = {},
): IntentClassifier {
  return {
    async classify(input: IntentClassifierInput): Promise<ClassificationOutcome> {
      let raw: unknown;

      try {
        raw = await model(input);
      } catch {
        if (options.fallback) {
          return options.fallback.classify(input);
        }

        return {
          status: "invalid",
          reason: "The language model is unavailable.",
          issues: ["classifier_unavailable"],
        };
      }

      const parsed = rawClassificationSchema.safeParse(raw);

      if (!parsed.success) {
        return {
          status: "invalid",
          reason: "The language model returned an invalid classification.",
          issues: parsed.error.issues.map((issue) => issue.message),
        };
      }

      return { status: "classified", classification: parsed.data as RawClassification };
    },
  };
}

function extractAmount(message: string): number | undefined {
  const matches = [...message.matchAll(/(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi)];

  if (matches.length !== 1) {
    return undefined;
  }

  const raw = matches[0]?.[1];

  if (!raw) {
    return undefined;
  }

  const value = Number(raw.replaceAll(",", ""));

  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractRelativeDate(message: string): string | undefined {
  if (/\byesterday\b|\bkal\b/i.test(message)) {
    return "yesterday";
  }

  if (/\btoday\b|\baaj\b/i.test(message)) {
    return "today";
  }

  return undefined;
}

function detectIntents(message: string): string[] {
  const text = message.toLowerCase();
  const detected: string[] = [];

  if (/\bupi\b|payment failed|debited|transaction/.test(text)) {
    detected.push("UPI_PAYMENT_ISSUE");
  }

  if (/\brefund\b|reversal|not received|paisa wapas/.test(text)) {
    detected.push("REFUND_STATUS");
  }

  if (/recharge|prepaid|mobile plan/.test(text)) {
    detected.push("RECHARGE_ISSUE");
  }

  if (/\blogin\b|\botp\b|\bkyc\b|blocked|account access|\bpassword\b/.test(text)) {
    detected.push("ACCOUNT_ISSUE");
  }

  if (/complaint|\bticket\b/.test(text)) {
    if (/status|check|track/.test(text)) {
      detected.push("COMPLAINT_STATUS");
    } else {
      detected.push("COMPLAINT_CREATE");
    }
  }

  if (/\bescalate\b/.test(text) && !detected.includes("COMPLAINT_CREATE")) {
    detected.push("COMPLAINT_CREATE");
  }

  return [...new Set(detected)];
}

export function createRuleBasedClassifier(): IntentClassifier {
  return {
    async classify(input: IntentClassifierInput): Promise<ClassificationOutcome> {
      const intents = detectIntents(input.message);

      if (intents.length === 0) {
        return {
          status: "invalid",
          reason: "No supported intent was detected.",
          issues: ["no_rule_match"],
        };
      }

      const entities: Record<string, unknown> = {};

      if (intents.length === 1) {
        const amount = extractAmount(input.message);

        if (amount !== undefined) {
          entities.amount = amount;
        }

        const relativeDate = extractRelativeDate(input.message);

        if (relativeDate !== undefined) {
          entities.relativeDate = relativeDate;
        }
      }

      const classification: RawClassification = {
        intents: intents.map<RawClassificationIntent>((intent) => ({
          intent,
          confidence: 0.7,
          entities: { ...entities },
        })),
      };

      return { status: "classified", classification };
    },
  };
}
