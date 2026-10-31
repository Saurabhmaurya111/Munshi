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

export type HybridClassifierOptions = {
  rules: IntentClassifier;
  llm: IntentClassifier;
};

const LOOKUP_INTENTS = new Set([
  "UPI_PAYMENT_ISSUE",
  "REFUND_STATUS",
  "RECHARGE_ISSUE",
  "WALLET_PAYMENT_TRACK",
  "WALLET_REFUND_TRACK",
]);

const LOOKUP_ENTITY_KEYS = [
  "transactionId",
  "refundId",
  "rechargeNumber",
  "amount",
  "relativeDate",
  "complaintId",
] as const;

export function extractMessageEntities(message: string): Record<string, unknown> {
  const entities: Record<string, unknown> = {
    ...extractReferenceEntities(message),
  };

  const amount = extractAmount(message);
  if (amount !== undefined) {
    entities.amount = amount;
  }

  const relativeDate = extractRelativeDate(message);
  if (relativeDate !== undefined) {
    entities.relativeDate = relativeDate;
  }

  return entities;
}

export function mergeClassificationEntities(
  classification: RawClassification,
  extracted: Record<string, unknown>,
): RawClassification {
  return {
    intents: classification.intents.map((intent) => ({
      ...intent,
      entities: fillMissingEntities(intent.entities ?? {}, extracted),
    })),
  };
}

function fillMissingEntities(
  entities: Record<string, unknown>,
  extracted: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...entities };

  for (const [name, value] of Object.entries(extracted)) {
    if (merged[name] === undefined) {
      merged[name] = value;
    }
  }

  return merged;
}

function hasLookupEntity(entities: Record<string, unknown>): boolean {
  return LOOKUP_ENTITY_KEYS.some((key) => entities[key] !== undefined);
}

export function shouldPreferRuleClassification(
  classification: RawClassification,
): boolean {
  if (classification.intents.length !== 1) {
    return false;
  }

  const intent = classification.intents[0];

  if (!intent) {
    return false;
  }

  if (intent.intent === "ACCOUNT_ISSUE" || intent.intent === "WALLET_BALANCE") {
    return true;
  }

  if (LOOKUP_INTENTS.has(intent.intent)) {
    // Wallet payment tracking can run the combined ledger with no filters.
    if (intent.intent === "WALLET_PAYMENT_TRACK") {
      return true;
    }

    return hasLookupEntity(intent.entities ?? {});
  }

  if (intent.intent === "COMPLAINT_STATUS") {
    return intent.entities?.complaintId !== undefined;
  }

  return false;
}

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
        if (options.fallback) {
          return options.fallback.classify(input);
        }

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

export function createHybridClassifier(
  options: HybridClassifierOptions,
): IntentClassifier {
  return {
    async classify(input: IntentClassifierInput): Promise<ClassificationOutcome> {
      const rulesOutcome = await options.rules.classify(input);

      if (
        rulesOutcome.status === "classified" &&
        shouldPreferRuleClassification(rulesOutcome.classification)
      ) {
        return rulesOutcome;
      }

      const llmOutcome = await options.llm.classify(input);

      if (llmOutcome.status === "classified") {
        return {
          status: "classified",
          classification: mergeClassificationEntities(
            llmOutcome.classification,
            extractMessageEntities(input.message),
          ),
        };
      }

      if (rulesOutcome.status === "classified") {
        return rulesOutcome;
      }

      return llmOutcome;
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

function extractReferenceEntities(message: string): Record<string, unknown> {
  const entities: Record<string, unknown> = {};
  const transactionId = message.match(
    /\b((?:txn_|TXN)[A-Za-z0-9_-]{3,60})\b/,
  )?.[1];
  const refundId = message.match(
    /\b((?:refund_|RFD|rfd_)[A-Za-z0-9_-]{3,60})\b/,
  )?.[1];
  const rechargeId = message.match(/\b((?:rech_|RECH)[A-Za-z0-9_-]{3,60})\b/)?.[1];
  const complaintId = message.match(
    /\b((?:cmp_|CMP)[A-Za-z0-9_-]{3,60})\b/,
  )?.[1];
  const rechargeNumber = message.match(/\b([6-9]\d{9})\b/)?.[1];

  if (transactionId) entities.transactionId = transactionId;
  if (refundId) entities.refundId = refundId;
  if (rechargeId) entities.transactionId = rechargeId;
  if (complaintId) entities.complaintId = complaintId;
  if (rechargeNumber) entities.rechargeNumber = rechargeNumber;

  return entities;
}

function extractRelativeDate(message: string): string | undefined {
  if (/\byesterday\b|\bkal\b/i.test(message)) {
    return "yesterday";
  }

  if (/\btoday\b|\baaj\b/i.test(message)) {
    return "today";
  }

  if (/\blast\s*week\b|\bpichhle\s*hafte\b/i.test(message)) {
    return "last_week";
  }

  if (/\blast\s*month\b|\bpichhle\s*mahine\b/i.test(message)) {
    return "last_month";
  }

  return undefined;
}

export function detectIntents(message: string): string[] {
  const text = message.toLowerCase();
  const detected: string[] = [];
  const mentionsWallet = /\bwallet\b|paytm\s*wallet|wallet\s*balance|add\s*money/.test(
    text,
  );

  if (mentionsWallet) {
    if (/\bbalance\b|\bkitna\b|how\s+much|\bfrozen\b|\blimited\b/.test(text)) {
      detected.push("WALLET_BALANCE");
    }

    if (/\brefund\b|reversal|paisa\s*wapas|credit(ed)?\s*(back|to\s*wallet)/.test(text)) {
      detected.push("WALLET_REFUND_TRACK");
    }

    if (
      /\bpayment\b|\bupi\b|transaction|history|ledger|statement|track|spent|debited|add\s*money/.test(
        text,
      ) ||
      detected.length === 0
    ) {
      if (!detected.includes("WALLET_REFUND_TRACK") || /\bpayment\b|\bupi\b|history|ledger|statement|track/.test(text)) {
        detected.push("WALLET_PAYMENT_TRACK");
      }
    }

    // Wallet-scoped messages should not also fan out to generic UPI/refund agents.
    return [...new Set(detected)];
  }

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

      const entities = extractMessageEntities(input.message);

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
