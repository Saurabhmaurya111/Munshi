import type {
  ToolInvocationInput,
  ToolInvocationResult,
  ToolInvoker,
} from "./types.js";

export type ToolTransport = {
  invoke(
    input: ToolInvocationInput & {
      idempotencyKey: string;
      signal: AbortSignal;
    },
  ): Promise<ToolInvocationResult>;
};

export type ToolClientOptions = {
  timeoutMs?: number;
};

export function idempotencyKeyFor(caseId: string, stepId: string): string {
  return `${caseId}:${stepId}`;
}

export function createToolClient(
  transport: ToolTransport,
  options: ToolClientOptions = {},
): ToolInvoker {
  const timeoutMs = options.timeoutMs ?? 5000;

  return {
    async invoke(input: ToolInvocationInput): Promise<ToolInvocationResult> {
      const controller = new AbortController();
      const idempotencyKey = idempotencyKeyFor(input.caseId, input.stepId);

      let timer: ReturnType<typeof setTimeout> | undefined;

      const timeoutResult = new Promise<ToolInvocationResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({
            state: "unknown",
            reason: "timeout",
            errorCode: "TIMEOUT",
          });
        }, timeoutMs);
      });

      try {
        return await Promise.race([
          transport.invoke({
            ...input,
            idempotencyKey,
            signal: controller.signal,
          }),
          timeoutResult,
        ]);
      } catch {
        return {
          state: "unknown",
          reason: "transport",
          errorCode: "TRANSPORT_ERROR",
        };
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}
