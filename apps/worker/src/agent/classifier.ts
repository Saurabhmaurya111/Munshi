import { isSupportedIntent } from "./intents.js";
import { detectRiskSignals } from "./risk.js";
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
  /** Recorded as the classification source, e.g. `sarvam:sarvam-105b`. */
  name?: string;
};

export function createLlmClassifier(
  model: ClassificationModel,
  options: LlmClassifierOptions = {},
): IntentClassifier {
  const source = options.name ?? "llm";

  return {
    async classify(input: IntentClassifierInput): Promise<ClassificationOutcome> {
      let raw: unknown;

      try {
        raw = await model(input);
      } catch {
        if (options.fallback) {
          const outcome = await options.fallback.classify(input);
          return outcome.status === "classified"
            ? { ...outcome, fallbackReason: "llm_unavailable" }
            : outcome;
        }

        return {
          status: "invalid",
          reason: "The language model is unavailable.",
          issues: ["classifier_unavailable"],
          source,
        };
      }

      const intents = (raw as { intents?: unknown } | null)?.intents;

      if (Array.isArray(intents) && intents.length === 0 && options.fallback) {
        const outcome = await options.fallback.classify(input);
        return outcome.status === "classified"
          ? { ...outcome, fallbackReason: "llm_no_intents" }
          : outcome;
      }

      const parsed = rawClassificationSchema.safeParse(raw);

      if (!parsed.success) {
        return {
          status: "invalid",
          reason: "The language model returned an invalid classification.",
          issues: parsed.error.issues.map((issue) => issue.message),
          source,
        };
      }

      return {
        status: "classified",
        classification: parsed.data as RawClassification,
        source,
      };
    },
  };
}

const AMOUNT_PATTERNS: RegExp[] = [
  /(?:₹|\brs\.?|\binr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi,
  /\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:rs\b\.?|rupees?\b|rupaye\b|inr\b|₹)/gi,
];

function extractAmounts(text: string): number[] {
  const values = new Set<number>();

  for (const pattern of AMOUNT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]?.replaceAll(",", ""));

      if (Number.isFinite(value) && value > 0) {
        values.add(value);
      }
    }
  }

  return [...values];
}

function extractReferenceEntities(message: string): Record<string, unknown> {
  const entities: Record<string, unknown> = {};
  const transactionId = message.match(/\b(txn_[A-Za-z0-9_-]+)\b/i)?.[1];
  const refundId = message.match(/\b(refund_[A-Za-z0-9_-]+)\b/i)?.[1];
  const rechargeId = message.match(/\b(rech_[A-Za-z0-9_-]+)\b/i)?.[1];
  const complaintId = message.match(/\b(cmp_[A-Za-z0-9_-]+)\b/i)?.[1];
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

  if (/\btoday\b|\baaj\b|\bthis morning\b/i.test(message)) {
    return "today";
  }

  if (/\blast\s*week\b|\bpichhle\s*hafte\b|\bfew days\b/i.test(message)) {
    return "last_week";
  }

  if (/\blast\s*month\b|\bpichhle\s*mahine\b/i.test(message)) {
    return "last_month";
  }

  return undefined;
}

const RECHARGE = /recharge|prepaid|mobile plan|data pack|\brech_/;
const REFUND = /\brefund|reversal|reversed|paisa wapas|paise wapas|money back|return(?:ed)? (?:my )?money/;
const UPI_STRONG = /\bupi\b|\btxn_|\btransaction\b|\btransfer(?:red)?\b|sent money/;
const UPI_WEAK =
  /\bpayment\b|\bpaid\b|\bpay\b|debited|deducted|\bkat gaye\b|charged twice|double charged/;
const ACCOUNT =
  /\blog\s?in\b|sign in|\botp\b|\bkyc\b|\bblocked\b|account (?:access|locked|blocked|restricted|frozen|suspended)|\bpassword\b|locked out/;
const COMPLAINT = /complaint|\bticket\b|\bcmp_/;
const COMPLAINT_CREATE_WORDS =
  /\b(raise|create|file|lodge|register|darj)\b|\bopen (?:a|new)\b|\bnew complaint\b/;
const COMPLAINT_STATUS_WORDS = /\b(status|check|track|update|kya hua|where is|progress)\b|\bcmp_/;

function detectIntents(message: string): string[] {
  const text = message.toLowerCase();
  const detected: string[] = [];
  const recharge = RECHARGE.test(text);

  if (UPI_STRONG.test(text) || (!recharge && UPI_WEAK.test(text))) {
    detected.push("UPI_PAYMENT_ISSUE");
  }

  if (REFUND.test(text)) {
    detected.push("REFUND_STATUS");
  }

  if (recharge) {
    detected.push("RECHARGE_ISSUE");
  }

  if (ACCOUNT.test(text) || detectRiskSignals(message).fraudSuspected) {
    detected.push("ACCOUNT_ISSUE");
  }

  if (COMPLAINT.test(text)) {
    const create = COMPLAINT_CREATE_WORDS.test(text);
    const status = COMPLAINT_STATUS_WORDS.test(text);
    detected.push(status && !create ? "COMPLAINT_STATUS" : "COMPLAINT_CREATE");
  }

  if (/\bescalate\b/.test(text) && !detected.includes("COMPLAINT_CREATE")) {
    detected.push("COMPLAINT_CREATE");
  }

  return [...new Set(detected)];
}

function intentsFromReferences(entities: Record<string, unknown>): string[] {
  const intents: string[] = [];
  const transactionId = entities.transactionId;

  if (typeof transactionId === "string") {
    intents.push(transactionId.toLowerCase().startsWith("rech_") ? "RECHARGE_ISSUE" : "UPI_PAYMENT_ISSUE");
  }

  if (entities.refundId) intents.push("REFUND_STATUS");
  if (entities.complaintId) intents.push("COMPLAINT_STATUS");

  return intents;
}

const REFERENCE_TOKENS = /\b(?:txn|refund|rech|cmp)_[A-Za-z0-9_-]+\b|\b[6-9]\d{9}\b/gi;

function stripReferences(message: string): string {
  return message.replace(REFERENCE_TOKENS, " ");
}

function splitClauses(message: string): string[] {
  return message
    .split(/[,;.!?](?=\s|$)|[;!?]|\band\b|\baur\b|\balso\b|\bbut\b/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

type ClauseEntities = { amount?: number; relativeDate?: string };

function clauseEntities(message: string, intent: string): ClauseEntities | undefined {
  const clauses = splitClauses(message).filter((clause) => detectIntents(clause).includes(intent));

  if (clauses.length === 0) {
    return undefined;
  }

  const text = clauses.join(" ");
  const amounts = extractAmounts(text);
  const relativeDate = extractRelativeDate(text);

  return {
    ...(amounts.length === 1 ? { amount: amounts[0] } : {}),
    ...(relativeDate ? { relativeDate } : {}),
  };
}

const LOOKUP_INTENTS = ["UPI_PAYMENT_ISSUE", "REFUND_STATUS", "RECHARGE_ISSUE"];

export function createRuleBasedClassifier(): IntentClassifier {
  return {
    async classify(input: IntentClassifierInput): Promise<ClassificationOutcome> {
      const references = extractReferenceEntities(input.message);
      const globalAmounts = extractAmounts(input.message);
      const globalDate = extractRelativeDate(input.message);
      const hasEntity =
        Object.keys(references).length > 0 || globalAmounts.length > 0 || globalDate !== undefined;

      let intents = detectIntents(stripReferences(input.message));

      if (
        references.complaintId &&
        intents.includes("COMPLAINT_CREATE") &&
        !COMPLAINT_CREATE_WORDS.test(input.message.toLowerCase())
      ) {
        intents = intents.map((intent) =>
          intent === "COMPLAINT_CREATE" ? "COMPLAINT_STATUS" : intent,
        );
      }

      if (intents.length === 0 && hasEntity) {
        const pending = (input.pendingIntents ?? []).filter(isSupportedIntent);
        intents = pending.length > 0 ? pending : intentsFromReferences(references);
      }

      if (intents.length === 0) {
        return {
          status: "invalid",
          reason: "No supported intent was detected.",
          issues: ["no_rule_match"],
          source: "rules",
        };
      }

      const classification: RawClassification = {
        intents: intents.map<RawClassificationIntent>((intent) => {
          const scoped = intents.length > 1 ? clauseEntities(input.message, intent) : undefined;
          const entities: Record<string, unknown> = { ...references };

          if (scoped) {
            Object.assign(entities, scoped);
          } else {
            if (globalAmounts.length === 1) entities.amount = globalAmounts[0];
            if (globalDate) entities.relativeDate = globalDate;
          }

          const anchored =
            entities.transactionId !== undefined ||
            entities.refundId !== undefined ||
            entities.rechargeNumber !== undefined ||
            entities.amount !== undefined ||
            entities.relativeDate !== undefined;

          if (!anchored && LOOKUP_INTENTS.includes(intent)) {
            entities.relativeDate = intent === "REFUND_STATUS" ? "last_month" : "last_week";
          }

          return { intent, confidence: 0.7, entities };
        }),
      };

      return { status: "classified", classification, source: "rules" };
    },
  };
}
