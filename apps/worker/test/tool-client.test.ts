import { describe, expect, it } from "vitest";
import { createToolClient, idempotencyKeyFor } from "../src/agent/tool-client.js";
import type { ToolInvocationInput } from "../src/agent/types.js";

const input: ToolInvocationInput = {
  caseId: "case-1",
  stepId: "task-1:0:getTransactionStatus",
  tool: "getTransactionStatus",
  args: { transactionId: "TXN12345" },
  customerId: "customer-1",
};

describe("createToolClient", () => {
  it("passes a stable idempotency key and the session customer id", async () => {
    let captured:
      | (ToolInvocationInput & { idempotencyKey: string; signal: AbortSignal })
      | undefined;

    const client = createToolClient({
      async invoke(call) {
        captured = call;
        return { state: "confirmed", data: { status: "success" } };
      },
    });

    const result = await client.invoke(input);

    expect(result).toEqual({ state: "confirmed", data: { status: "success" } });
    expect(captured?.idempotencyKey).toBe(
      idempotencyKeyFor("case-1", "task-1:0:getTransactionStatus"),
    );
    expect(captured?.customerId).toBe("customer-1");
  });

  it("marks a timeout as unknown and aborts the call", async () => {
    let aborted = false;
    let calls = 0;

    const client = createToolClient(
      {
        invoke({ signal }) {
          calls += 1;
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise(() => {});
        },
      },
      { timeoutMs: 10 },
    );

    const result = await client.invoke(input);

    expect(result).toMatchObject({ state: "unknown", reason: "timeout" });
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
  });

  it("marks a transport failure as unknown instead of failed", async () => {
    const client = createToolClient({
      async invoke() {
        throw new Error("socket hang up");
      },
    });

    const result = await client.invoke(input);

    expect(result).toMatchObject({ state: "unknown", reason: "transport" });
  });

  it("does not retry a write after an unknown result", async () => {
    let calls = 0;

    const client = createToolClient(
      {
        invoke() {
          calls += 1;
          return new Promise(() => {});
        },
      },
      { timeoutMs: 5 },
    );

    await client.invoke({ ...input, tool: "createComplaint" });
    await client.invoke({ ...input, tool: "createComplaint" });

    expect(calls).toBe(2);
  });
});
