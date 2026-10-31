import { describe, expect, it } from "vitest";
import { createAgentRunner, type AgentRunContext } from "../src/agent/agents.js";
import type { AgentTask, AgentTaskResult, ToolInvoker } from "../src/agent/types.js";
import { confirmed, createFakeInvoker, makeTask } from "./helpers.js";

function context(
  tools: ToolInvoker,
  overrides: Partial<AgentRunContext> = {},
): AgentRunContext {
  return {
    caseId: "case-1",
    conversationId: "case-1",
    customerId: "customer-1",
    workflowLevel: 2,
    message: "My UPI payment failed yesterday",
    tools,
    results: new Map(),
    ...overrides,
  };
}

describe("createAgentRunner", () => {
  it("completes a verified read and cites the tool result", async () => {
    const { invoker, calls } = createFakeInvoker({
      getTransactionStatus: () =>
        confirmed({ status: "success", transactionId: "TXN12345" }),
    });

    const runner = createAgentRunner();
    const result = await runner(makeTask(), context(invoker));

    expect(result.status).toBe("completed");
    expect(result.response).toContain('returned status "success"');
    expect(result.references).toContain("TXN12345");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("getTransactionStatus");
    expect(calls[0]?.customerId).toBe("customer-1");
    expect(calls[0]?.stepId).toBe("task-1:0:getTransactionStatus");
  });

  it("asks for clarification and makes no tool call when no anchor is present", async () => {
    const { invoker, calls } = createFakeInvoker({});

    const runner = createAgentRunner();
    const result = await runner(
      makeTask({ entities: {} }),
      context(invoker),
    );

    expect(result.status).toBe("needs_clarification");
    expect(calls).toHaveLength(0);
  });

  it("reads wallet balance with no extra entities", async () => {
    const { invoker, calls } = createFakeInvoker({
      getWalletBalance: () =>
        confirmed({
          customerId: "customer-1",
          balancePaise: 125000,
          status: "active",
        }),
    });

    const runner = createAgentRunner();
    const result = await runner(
      makeTask({
        intent: "WALLET_BALANCE",
        agent: "wallet_agent",
        domain: "wallet",
        entities: {},
      }),
      context(invoker, { message: "What is my wallet balance?" }),
    );

    expect(result.status).toBe("completed");
    expect(calls.map((call) => call.tool)).toEqual(["getWalletBalance"]);
  });

  it("tracks wallet payments via ledger when no filters are present", async () => {
    const { invoker, calls } = createFakeInvoker({
      getWalletLedger: () =>
        confirmed({
          customerId: "customer-1",
          entryCount: 1,
          entries: [{ type: "payment", transactionId: "txn_wal_4001", status: "success" }],
        }),
    });

    const runner = createAgentRunner();
    const result = await runner(
      makeTask({
        intent: "WALLET_PAYMENT_TRACK",
        agent: "wallet_agent",
        domain: "wallet",
        entities: {},
      }),
      context(invoker, { message: "Track my wallet payments" }),
    );

    expect(result.status).toBe("completed");
    expect(calls.map((call) => call.tool)).toEqual(["getWalletLedger"]);
  });

  it("tracks a wallet refund by refund id", async () => {
    const { invoker, calls } = createFakeInvoker({
      getWalletRefundDetails: () =>
        confirmed({
          refundId: "refund_wal_6001",
          status: "completed",
          destination: "wallet",
        }),
    });

    const runner = createAgentRunner();
    const result = await runner(
      makeTask({
        intent: "WALLET_REFUND_TRACK",
        agent: "wallet_agent",
        domain: "wallet",
        entities: { refundId: "refund_wal_6001" },
      }),
      context(invoker, { message: "Is refund_wal_6001 credited to wallet?" }),
    );

    expect(result.status).toBe("completed");
    expect(calls.map((call) => call.tool)).toEqual(["getWalletRefundDetails"]);
  });

  it("asks for a complaint id without calling a tool", async () => {
    const { invoker, calls } = createFakeInvoker({});

    const runner = createAgentRunner();
    const result = await runner(
      makeTask({
        intent: "COMPLAINT_STATUS",
        agent: "complaint_agent",
        domain: "complaint",
        entities: {},
        missingEntities: ["complaintId"],
      }),
      context(invoker),
    );

    expect(result.status).toBe("needs_clarification");
    expect(result.response).toContain("complaint reference");
    expect(calls).toHaveLength(0);
  });

  it("holds a write for approval before level 2", async () => {
    const { invoker, calls } = createFakeInvoker({
      createComplaint: () => confirmed({ complaintId: "CMP99999" }),
    });

    const runner = createAgentRunner();
    const result = await runner(
      makeTask({
        intent: "COMPLAINT_CREATE",
        agent: "complaint_agent",
        domain: "complaint",
        entities: {},
      }),
      context(invoker, { workflowLevel: 1 }),
    );

    expect(result.status).toBe("escalated");
    expect(result.errorCode).toBe("APPROVAL_REQUIRED");
    expect(calls).toHaveLength(0);
  });

  it("runs a low-risk write at level 2", async () => {
    const { invoker, calls } = createFakeInvoker({
      createComplaint: () =>
        confirmed({ complaintId: "CMP99999", status: "created" }),
    });

    const runner = createAgentRunner();
    const result = await runner(
      makeTask({
        intent: "COMPLAINT_CREATE",
        agent: "complaint_agent",
        domain: "complaint",
        entities: {},
      }),
      context(invoker, { workflowLevel: 2 }),
    );

    expect(result.status).toBe("completed");
    expect(result.references).toContain("CMP99999");
    expect(calls.map((call) => call.tool)).toEqual(["createComplaint"]);
  });

  it("escalates an unknown tool outcome without inventing a status", async () => {
    const { invoker } = createFakeInvoker({
      getTransactionStatus: () => ({
        state: "unknown",
        reason: "timeout",
        errorCode: "TIMEOUT",
      }),
    });

    const runner = createAgentRunner();
    const result = await runner(makeTask(), context(invoker));

    expect(result.status).toBe("escalated");
    expect(result.errorCode).toBe("UNKNOWN_OUTCOME");
    expect(result.response).not.toContain("success");
    expect(result.response).not.toContain('status "');
  });

  it("fails honestly when the tool call fails", async () => {
    const { invoker } = createFakeInvoker({
      getTransactionStatus: () => ({
        state: "failed",
        errorCode: "DOWNSTREAM_5XX",
        message: "upstream error",
      }),
    });

    const runner = createAgentRunner();
    const result = await runner(makeTask(), context(invoker));

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("DOWNSTREAM_5XX");
  });

  it("does not run a dependent task when the investigation failed", async () => {
    const { invoker, calls } = createFakeInvoker({
      createComplaint: () => confirmed({ complaintId: "CMP99999" }),
    });

    const results = new Map<string, AgentTaskResult>([
      [
        "task-1",
        {
          taskId: "task-1",
          agent: "upi_agent",
          status: "failed",
          response: "failed",
        },
      ],
    ]);

    const task: AgentTask = makeTask({
      intent: "COMPLAINT_CREATE",
      agent: "complaint_agent",
      domain: "complaint",
      entities: {},
      dependsOn: ["task-1"],
    });

    const runner = createAgentRunner();
    const result = await runner(task, context(invoker, { results }));

    expect(result.status).toBe("escalated");
    expect(result.errorCode).toBe("DEPENDENCY_NOT_SATISFIED");
    expect(calls).toHaveLength(0);
  });

  it("refuses a tool that is not allowed for the agent", async () => {
    const { invoker, calls } = createFakeInvoker({
      getComplaintStatus: () => confirmed({ status: "open" }),
    });

    const runner = createAgentRunner();
    const result = await runner(
      makeTask({
        intent: "COMPLAINT_STATUS",
        agent: "upi_agent",
        domain: "complaint",
        entities: { complaintId: "CMP12345" },
      }),
      context(invoker),
    );

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("TOOL_NOT_ALLOWED");
    expect(calls).toHaveLength(0);
  });
});
