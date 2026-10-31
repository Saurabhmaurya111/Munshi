import { z } from "zod";
import type { PolicyDocumentInput, RetrieveInput } from "./types.js";

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)")
  .refine((value) => {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value);
  }, "Expected a valid calendar date");

export class KnowledgeValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid knowledge input: ${issues.join("; ")}`);
    this.name = "KnowledgeValidationError";
    this.issues = issues;
  }
}

export const policyDocumentSchema = z
  .object({
    documentId: z.string().trim().min(1).max(200),
    documentTitle: z.string().trim().min(1).max(300),
    source: z.string().trim().min(1).max(500),
    version: z.string().trim().min(1).max(100),
    content: z.string().trim().min(1).max(500_000),
    category: z.string().trim().min(1).max(100).optional(),
    language: z.string().trim().min(2).max(20).optional(),
    effectiveFrom: isoDateSchema.optional(),
    effectiveTo: isoDateSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((document, context) => {
    if (
      document.effectiveFrom &&
      document.effectiveTo &&
      document.effectiveFrom > document.effectiveTo
    ) {
      context.addIssue({
        code: "custom",
        path: ["effectiveTo"],
        message: "effectiveTo must not be before effectiveFrom",
      });
    }
  });

export const retrieveInputSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(20).optional(),
  asOf: isoDateSchema.optional(),
  category: z.string().trim().min(1).max(100).optional(),
  language: z.string().trim().min(2).max(20).optional(),
  minScore: z.number().min(-1).max(1).optional(),
});

export function parsePolicyDocument(input: unknown): PolicyDocumentInput {
  const result = policyDocumentSchema.safeParse(input);

  if (!result.success) {
    throw new KnowledgeValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".") || "document"}: ${issue.message}`,
      ),
    );
  }

  return result.data;
}

export function parseRetrieveInput(input: unknown): RetrieveInput {
  const result = retrieveInputSchema.safeParse(input);

  if (!result.success) {
    throw new KnowledgeValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".") || "query"}: ${issue.message}`,
      ),
    );
  }

  return result.data;
}
