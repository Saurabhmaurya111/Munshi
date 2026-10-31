import { z } from "zod";

export const EVAL_TAGS = [
  "easy",
  "ambiguous",
  "unseen",
  "fraud",
  "injection",
  "Hinglish",
  "missing-information",
  "partial-failure",
] as const;

export const mockToolResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("confirmed"),
    data: z.unknown(),
  }),
  z.object({
    state: z.literal("failed"),
    errorCode: z.string().min(1),
    message: z.string().min(1).optional(),
  }),
  z.object({
    state: z.literal("unknown"),
    reason: z.enum(["timeout", "transport"]).optional(),
    errorCode: z.string().min(1).optional(),
  }),
]);

export const classificationIntentSchema = z.object({
  intent: z.string().min(1).max(64),
  agent: z.string().min(1).max(64).optional(),
  confidence: z.number().min(0).max(1).optional(),
  entities: z.record(z.string(), z.unknown()).default({}),
});

export const evalScenarioSchema = z.object({
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(32),
  tags: z.array(z.enum(EVAL_TAGS)).min(1),
  input: z.object({
    message: z.string().min(1).max(4000),
    authenticatedContext: z.object({
      customerId: z.string().min(1).max(128),
      roles: z.array(z.string().min(1).max(64)).max(20),
    }),
    workflowLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(2),
    conversationId: z.string().min(1).max(128).optional(),
  }),
  classification: z.object({
    intents: z.array(classificationIntentSchema).min(1).max(5),
  }),
  mockTools: z.record(z.string(), mockToolResultSchema).default({}),
  expect: z.object({
    status: z.enum([
      "completed",
      "needs_clarification",
      "failed",
      "escalated",
      "partial",
      "unsupported",
      "invalid",
    ]),
    intents: z.array(z.string().min(1)).optional(),
    agents: z
      .array(
        z.enum([
          "upi_agent",
          "refund_agent",
          "recharge_agent",
          "account_agent",
          "complaint_agent",
          "wallet_agent",
        ]),
      )
      .optional(),
    toolsMustRun: z.array(z.string().min(1)).default([]),
    toolsMustNotRun: z.array(z.string().min(1)).default([]),
    toolsOrder: z.array(z.string().min(1)).optional(),
    escalate: z.boolean(),
    requiresCustomerInput: z.boolean().optional(),
    replyMustMatch: z.array(z.string().min(1)).default([]),
    replyMustNotMatch: z.array(z.string().min(1)).default([]),
    wrongActionIf: z.array(z.string().min(1)).default([]),
  }),
});

export type EvalScenario = z.infer<typeof evalScenarioSchema>;
export type MockToolResult = z.infer<typeof mockToolResultSchema>;

export const evalThresholdsSchema = z.object({
  datasetVersion: z.string().min(1),
  wrongActionRate: z.number().min(0).max(1),
  injectionSuccessRate: z.number().min(0).max(1),
  planValidityMin: z.number().min(0).max(1),
  toolSelectionMin: z.number().min(0).max(1),
});

export type EvalThresholds = z.infer<typeof evalThresholdsSchema>;
