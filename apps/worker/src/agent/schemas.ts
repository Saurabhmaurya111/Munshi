import { z } from "zod";

const referenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/, "must be a valid reference identifier");

const amountSchema = z
  .number()
  .finite()
  .positive()
  .max(10_000_000)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
    "amount must have at most two decimal places",
  );

const mobileSchema = z
  .string()
  .regex(/^[6-9]\d{9}$/, "must be a 10-digit Indian mobile number");

const relativeDateSchema = z.enum([
  "today",
  "yesterday",
  "last_week",
  "last_month",
]);

export const ENTITY_SCHEMAS: Record<string, z.ZodType> = {
  amount: amountSchema,
  transactionId: referenceSchema,
  refundId: referenceSchema,
  rechargeNumber: mobileSchema,
  complaintId: referenceSchema,
  relativeDate: relativeDateSchema,
};

export const rawClassificationSchema = z.object({
  intents: z
    .array(
      z.object({
        intent: z.string().min(1).max(64),
        agent: z.string().min(1).max(64).optional(),
        confidence: z.number().min(0).max(1).optional(),
        entities: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(5),
});

export const supervisorRequestSchema = z.object({
  conversationId: z.string().min(1).max(128),
  message: z.string().min(1).max(4000),
  authenticatedContext: z.object({
    customerId: z.string().min(1).max(128),
    roles: z.array(z.string().min(1).max(64)).max(20),
  }),
  context: z
    .object({
      facts: z.record(z.string(), z.unknown()).optional(),
      recentEvents: z.array(z.string().min(1).max(2000)).max(50).optional(),
      pendingIntents: z.array(z.string().min(1).max(64)).max(5).optional(),
    })
    .optional(),
  correlationId: z.string().min(1).max(128).optional(),
  turnId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
});

export const toolObservationSchema = z.object({
  tool: z.string().min(1),
  state: z.enum(["confirmed", "failed", "unknown"]),
  data: z.unknown().optional(),
  errorCode: z.string().optional(),
});

const agentNameSchema = z.enum([
  "upi_agent",
  "refund_agent",
  "recharge_agent",
  "account_agent",
  "complaint_agent",
  "wallet_agent",
]);

export const agentTaskResultSchema = z.object({
  taskId: z.string().min(1),
  agent: agentNameSchema,
  intent: z.string().optional(),
  status: z.enum(["completed", "needs_clarification", "failed", "escalated"]),
  response: z.string(),
  references: z.array(z.string()).optional(),
  citations: z.array(z.string()).optional(),
  observations: z.array(toolObservationSchema).optional(),
  errorCode: z.string().optional(),
});

export const supervisorResponseSchema = z.object({
  conversationId: z.string().min(1),
  status: z.enum([
    "completed",
    "needs_clarification",
    "failed",
    "escalated",
    "partial",
    "unsupported",
    "invalid",
  ]),
  message: z.string(),
  tasks: z.array(
    z.object({
      taskId: z.string().min(1),
      agent: agentNameSchema,
      status: z.enum([
        "completed",
        "needs_clarification",
        "failed",
        "escalated",
      ]),
      summary: z.string(),
      references: z.array(z.string()).optional(),
      citations: z.array(z.string()).optional(),
      errorCode: z.string().optional(),
    }),
  ),
  requiresCustomerInput: z.boolean(),
});

export type RawClassificationSchema = z.infer<typeof rawClassificationSchema>;
export type SupervisorRequestSchema = z.infer<typeof supervisorRequestSchema>;
