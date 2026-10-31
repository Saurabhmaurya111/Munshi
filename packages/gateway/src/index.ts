/** Tool gateway: validate, guardrail, record intent, call with idempotency key. */

export type IntentState =
  | "intended"
  | "sent"
  | "confirmed"
  | "failed"
  | "unknown";
