import type {
  AgentTask,
  ToolInvocationInput,
  ToolInvocationResult,
  ToolInvoker,
  ValidatedIntent,
} from "../src/agent/types.js";

export type ToolHandler = (
  input: ToolInvocationInput,
) => ToolInvocationResult | Promise<ToolInvocationResult>;

export function createFakeInvoker(handlers: Record<string, ToolHandler>) {
  const calls: ToolInvocationInput[] = [];

  const invoker: ToolInvoker = {
    async invoke(input: ToolInvocationInput): Promise<ToolInvocationResult> {
      calls.push(input);
      const handler = handlers[input.tool];

      if (!handler) {
        return {
          state: "failed",
          errorCode: "NO_HANDLER",
          message: `no handler for ${input.tool}`,
        };
      }

      return handler(input);
    },
  };

  return { invoker, calls };
}

export function confirmed(data: unknown): ToolInvocationResult {
  return { state: "confirmed", data };
}

export function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskId: "task-1",
    intent: "UPI_PAYMENT_ISSUE",
    agent: "upi_agent",
    domain: "upi",
    entities: { transactionId: "TXN12345" },
    dependsOn: [],
    missingEntities: [],
    confidence: 1,
    ...overrides,
  };
}

export function makeIntent(overrides: Partial<ValidatedIntent> = {}): ValidatedIntent {
  return {
    intent: "UPI_PAYMENT_ISSUE",
    agent: "upi_agent",
    domain: "upi",
    entities: { transactionId: "TXN12345" },
    missingEntities: [],
    confidence: 1,
    ...overrides,
  };
}
