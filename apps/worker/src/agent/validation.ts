import { AGENT_ALLOWLIST, INTENT_ORDER, getIntentDefinition } from "./intents.js";
import { ENTITY_SCHEMAS } from "./schemas.js";
import type {
  RawClassification,
  RawClassificationIntent,
  ValidatedIntent,
  ValidationIssue,
  ValidationOutcome,
} from "./types.js";

export type ValidateOptions = {
  confidenceThreshold?: number;
  maxIntents?: number;
};

type NormalizedIntent = {
  intent: string;
  agent: ValidatedIntent["agent"];
  domain: ValidatedIntent["domain"];
  entities: Record<string, unknown>;
  confidence: number;
};

function normalizeEntities(
  raw: RawClassificationIntent,
  issues: ValidationIssue[],
): Record<string, unknown> | undefined {
  if (typeof raw.entities !== "object" || raw.entities === null || Array.isArray(raw.entities)) {
    issues.push({
      code: "INVALID_ENTITIES",
      message: "entities must be an object",
      intent: raw.intent,
    });
    return undefined;
  }

  const entities: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(raw.entities)) {
    const schema = ENTITY_SCHEMAS[name];

    if (!schema) {
      continue;
    }

    const parsed = schema.safeParse(value);

    if (!parsed.success) {
      issues.push({
        code: "INVALID_ENTITY",
        message: `invalid ${name}`,
        intent: raw.intent,
      });
      return undefined;
    }

    entities[name] = parsed.data;
  }

  return entities;
}

function hasEntity(intent: ValidatedIntent, name: string): boolean {
  return intent.entities[name] !== undefined;
}

function mergeDuplicate(
  existing: ValidatedIntent,
  incoming: ValidatedIntent,
  requiredEntities: string[],
): ValidatedIntent | undefined {
  const entities: Record<string, unknown> = { ...existing.entities };

  for (const [name, value] of Object.entries(incoming.entities)) {
    if (
      hasEntity(existing, name) &&
      JSON.stringify(existing.entities[name]) !== JSON.stringify(value)
    ) {
      return undefined;
    }
    entities[name] = value;
  }

  return {
    intent: existing.intent,
    agent: existing.agent,
    domain: existing.domain,
    entities,
    missingEntities: requiredEntities.filter((name) => entities[name] === undefined),
    confidence: Math.min(existing.confidence, incoming.confidence),
  };
}

export function validateClassification(
  raw: RawClassification,
  options: ValidateOptions = {},
): ValidationOutcome {
  const confidenceThreshold = options.confidenceThreshold ?? 0.5;
  const maxIntents = options.maxIntents ?? 5;

  if (!Array.isArray(raw.intents) || raw.intents.length === 0) {
    return {
      status: "invalid",
      reason: "No supported intent was detected.",
      issues: [{ code: "NO_INTENTS", message: "classification contained no intents" }],
    };
  }

  if (raw.intents.length > maxIntents) {
    return {
      status: "invalid",
      reason: "Too many intents were detected in one message.",
      issues: [{ code: "TOO_MANY_INTENTS", message: `limit is ${maxIntents}` }],
    };
  }

  const issues: ValidationIssue[] = [];
  const unsupported: string[] = [];
  const lowConfidence: string[] = [];
  const normalized: NormalizedIntent[] = [];

  for (const item of raw.intents) {
    const definition = getIntentDefinition(item.intent);

    if (!definition) {
      unsupported.push(item.intent);
      continue;
    }

    if (item.agent !== undefined) {
      if (!AGENT_ALLOWLIST.includes(item.agent as ValidatedIntent["agent"])) {
        issues.push({
          code: "AGENT_NOT_ALLOWED",
          message: "agent is not in the allowlist",
          intent: item.intent,
        });
        continue;
      }

      if (item.agent !== definition.agent) {
        issues.push({
          code: "AGENT_MAPPING_MISMATCH",
          message: `agent does not match intent ${item.intent}`,
          intent: item.intent,
        });
        continue;
      }
    }

    const confidence = item.confidence ?? 1;

    if (confidence < confidenceThreshold) {
      lowConfidence.push(item.intent);
      continue;
    }

    const entities = normalizeEntities(item, issues);

    if (!entities) {
      continue;
    }

    normalized.push({
      intent: definition.intent,
      agent: definition.agent,
      domain: definition.domain,
      entities,
      confidence,
    });
  }

  if (unsupported.length > 0) {
    return {
      status: "unsupported",
      reason: "Part of the request is outside what Munshi can handle.",
      unsupported,
    };
  }

  if (issues.length > 0) {
    return {
      status: "invalid",
      reason: "The request could not be validated safely.",
      issues,
    };
  }

  if (lowConfidence.length > 0) {
    return {
      status: "needs_clarification",
      reason: "The request was ambiguous, so no action was taken.",
      missing: lowConfidence,
    };
  }

  if (normalized.length === 0) {
    return {
      status: "invalid",
      reason: "No supported intent was detected.",
      issues: [{ code: "NO_VALID_INTENTS", message: "classification contained no valid intents" }],
    };
  }

  const byIntent = new Map<string, ValidatedIntent>();

  for (const item of normalized) {
    const definition = getIntentDefinition(item.intent);

    if (!definition) {
      continue;
    }

    const missingEntities = definition.requiredEntities.filter(
      (name) => item.entities[name] === undefined,
    );

    const candidate: ValidatedIntent = {
      intent: item.intent,
      agent: item.agent,
      domain: item.domain,
      entities: item.entities,
      missingEntities,
      confidence: item.confidence,
    };

    const existing = byIntent.get(item.intent);

    if (!existing) {
      byIntent.set(item.intent, candidate);
      continue;
    }

    const merged = mergeDuplicate(existing, candidate, definition.requiredEntities);

    if (!merged) {
      return {
        status: "needs_clarification",
        reason: "Multiple different records were described for the same request.",
        missing: [item.intent],
      };
    }

    byIntent.set(item.intent, merged);
  }

  const intents = [...byIntent.values()].sort(
    (left, right) => INTENT_ORDER.indexOf(left.intent) - INTENT_ORDER.indexOf(right.intent),
  );

  return { status: "runnable", intents };
}
