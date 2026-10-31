import type { RiskSignals } from "./types.js";

const FRAUD_PATTERNS: RegExp[] = [
  /\bhack(?:ed|ing)?\b/i,
  /\bfraud\w*\b/i,
  /\bscam\w*\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bcompromised\b/i,
  /\bstolen\b/i,
  /\bsuspicious\b/i,
  /\b(?:did\s*n[o']?t|did not|never)\s+(?:make|do|authori[sz]e|initiate|recogni[sz]e)\b/i,
  /\bnot\s+(?:done|made)\s+by\s+me\b/i,
  /\bsomeone\s+(?:else\s+)?(?:used|accessed|logged|took|stole)\b/i,
  /\bmaine\s+nahi\s+(?:kiya|kia)\b/i,
];

const SECRET_KEYWORD = String.raw`(?:otp|one[\s-]?time[\s-]?password|upi[\s-]?pin|m?pin|cvv|password|passcode)`;

const NUMERIC_SECRET = new RegExp(
  String.raw`\b(${SECRET_KEYWORD})\b(\s*(?:is|hai|=|:|-)?\s*)([0-9]{3,8})\b`,
  "gi",
);

const DECLARED_SECRET = new RegExp(
  String.raw`\b(${SECRET_KEYWORD})\b(\s*(?:is|hai|=|:)\s*)(\S{4,64})`,
  "gi",
);

const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/g;

function matches(pattern: RegExp, message: string): boolean {
  pattern.lastIndex = 0;
  const found = pattern.test(message);
  pattern.lastIndex = 0;
  return found;
}

export function detectRiskSignals(message: string): RiskSignals {
  return {
    fraudSuspected: FRAUD_PATTERNS.some((pattern) => pattern.test(message)),
    sharedSecret:
      matches(NUMERIC_SECRET, message) ||
      matches(DECLARED_SECRET, message) ||
      matches(CARD_NUMBER, message),
  };
}

/** Remove OTPs, PINs, passwords, and card numbers before text leaves the worker. */
export function redactSecrets(message: string): string {
  const redact = (_match: string, keyword: string, separator: string) =>
    `${keyword}${separator}[redacted]`;

  return message
    .replace(NUMERIC_SECRET, redact)
    .replace(DECLARED_SECRET, redact)
    .replace(CARD_NUMBER, "[redacted-card]");
}
