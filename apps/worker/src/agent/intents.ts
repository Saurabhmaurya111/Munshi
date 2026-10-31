import type { AgentName, Domain } from "./types.js";

export type IntentDefinition = {
  intent: string;
  agent: AgentName;
  domain: Domain;
  description: string;
  requiredEntities: string[];
  dependsOnIntents: string[];
};

export const INTENT_REGISTRY: Record<string, IntentDefinition> = {
  UPI_PAYMENT_ISSUE: {
    intent: "UPI_PAYMENT_ISSUE",
    agent: "upi_agent",
    domain: "upi",
    description: "Investigate a UPI payment that failed, is pending, or was debited without credit.",
    requiredEntities: [],
    dependsOnIntents: [],
  },
  REFUND_STATUS: {
    intent: "REFUND_STATUS",
    agent: "refund_agent",
    domain: "refund",
    description: "Check the lifecycle and status of a refund.",
    requiredEntities: [],
    dependsOnIntents: [],
  },
  RECHARGE_ISSUE: {
    intent: "RECHARGE_ISSUE",
    agent: "recharge_agent",
    domain: "recharge",
    description: "Investigate a failed, pending, or duplicate mobile recharge.",
    requiredEntities: [],
    dependsOnIntents: [],
  },
  ACCOUNT_ISSUE: {
    intent: "ACCOUNT_ISSUE",
    agent: "account_agent",
    domain: "account",
    description: "Provide account, login, OTP, KYC, and blocked-account guidance.",
    requiredEntities: [],
    dependsOnIntents: [],
  },
  WALLET_BALANCE: {
    intent: "WALLET_BALANCE",
    agent: "wallet_agent",
    domain: "wallet",
    description: "Check Paytm wallet balance, freeze, or limited-wallet status.",
    requiredEntities: [],
    dependsOnIntents: [],
  },
  WALLET_PAYMENT_TRACK: {
    intent: "WALLET_PAYMENT_TRACK",
    agent: "wallet_agent",
    domain: "wallet",
    description:
      "Track Paytm wallet payments including wallet spends and UPI add-money or wallet-linked UPI.",
    requiredEntities: [],
    dependsOnIntents: [],
  },
  WALLET_REFUND_TRACK: {
    intent: "WALLET_REFUND_TRACK",
    agent: "wallet_agent",
    domain: "wallet",
    description: "Track refunds that credit or should credit the Paytm wallet.",
    requiredEntities: [],
    dependsOnIntents: [],
  },
  COMPLAINT_CREATE: {
    intent: "COMPLAINT_CREATE",
    agent: "complaint_agent",
    domain: "complaint",
    description: "Create a complaint after the relevant investigation.",
    requiredEntities: [],
    dependsOnIntents: [
      "UPI_PAYMENT_ISSUE",
      "REFUND_STATUS",
      "RECHARGE_ISSUE",
      "ACCOUNT_ISSUE",
      "WALLET_BALANCE",
      "WALLET_PAYMENT_TRACK",
      "WALLET_REFUND_TRACK",
    ],
  },
  COMPLAINT_STATUS: {
    intent: "COMPLAINT_STATUS",
    agent: "complaint_agent",
    domain: "complaint",
    description: "Retrieve the status of an existing complaint.",
    requiredEntities: ["complaintId"],
    dependsOnIntents: [],
  },
};

export const INTENT_ORDER: string[] = Object.keys(INTENT_REGISTRY);

export const AGENT_ALLOWLIST: AgentName[] = [
  "upi_agent",
  "refund_agent",
  "recharge_agent",
  "account_agent",
  "complaint_agent",
  "wallet_agent",
];

export function getIntentDefinition(intent: string): IntentDefinition | undefined {
  return Object.hasOwn(INTENT_REGISTRY, intent) ? INTENT_REGISTRY[intent] : undefined;
}

export function isSupportedIntent(intent: string): boolean {
  return getIntentDefinition(intent) !== undefined;
}
