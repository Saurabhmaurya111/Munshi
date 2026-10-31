import { getIntentDefinition } from "./intents.js";
import type { RawClassification } from "./types.js";

const DOMAIN_WORKFLOWS = new Set([
  "upi",
  "refund",
  "recharge",
  "wallet",
  "complaint",
  "account",
]);

/**
 * Pick the workflow for this turn from classified intents (highest confidence
 * domain wins). Falls back to `default` when nothing maps.
 */
export function workflowNameFromClassification(
  classification: RawClassification | null | undefined,
): string {
  if (!classification?.intents?.length) return "default";

  const ranked = [...classification.intents].sort(
    (left, right) => (right.confidence ?? 0) - (left.confidence ?? 0),
  );

  for (const intent of ranked) {
    const definition = getIntentDefinition(intent.intent);
    const domain = definition?.domain;
    if (domain && DOMAIN_WORKFLOWS.has(domain)) {
      return domain;
    }
  }

  return "default";
}
