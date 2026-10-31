import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PolicyDocumentInput } from "./types.js";

export const POLICY_VERSION = "2026-10";

/** Mapping from docs/policies/README.md. */
export const POLICY_SOURCES: Array<{ file: string; documentId: string; category: string }> = [
  { file: "upi-troubleshooting.md", documentId: "policy-upi-troubleshooting", category: "upi" },
  { file: "refund-policy.md", documentId: "policy-refund", category: "refund" },
  { file: "recharge-troubleshooting.md", documentId: "policy-recharge", category: "recharge" },
  { file: "account-kyc-help.md", documentId: "policy-account-kyc", category: "account" },
  { file: "complaint-escalation.md", documentId: "policy-complaint", category: "complaint" },
  { file: "wallet-payments.md", documentId: "policy-wallet-payments", category: "wallet" },
  { file: "support-faq.md", documentId: "policy-support-faq", category: "faq" },
];

function titleOf(content: string, fallback: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
}

export async function loadPolicyDocuments(
  policiesDir: string,
  options: { version?: string; embedder?: string } = {},
): Promise<PolicyDocumentInput[]> {
  const version = options.version ?? POLICY_VERSION;

  return Promise.all(
    POLICY_SOURCES.map(async (source) => {
      const content = await readFile(join(policiesDir, source.file), "utf8");

      return {
        documentId: source.documentId,
        documentTitle: titleOf(content, source.documentId),
        source: `docs/policies/${source.file}`,
        version,
        content,
        category: source.category,
        language: "en",
        metadata: options.embedder ? { embedder: options.embedder } : {},
      };
    }),
  );
}
