import { describe, expect, it } from "vitest";
import { aggregateResults, toTaskSummaries } from "../src/agent/aggregation.js";
import type { AgentTaskResult } from "../src/agent/types.js";

function result(overrides: Partial<AgentTaskResult>): AgentTaskResult {
  return {
    taskId: "task-1",
    agent: "upi_agent",
    status: "completed",
    response: "Verified the payment.",
    ...overrides,
  };
}

describe("aggregateResults", () => {
  it("reports completed when every task completed", () => {
    const aggregated = aggregateResults([
      result({ taskId: "task-1" }),
      result({ taskId: "task-2", agent: "refund_agent", response: "Refund is processing." }),
    ]);

    expect(aggregated.status).toBe("completed");
    expect(aggregated.requiresCustomerInput).toBe(false);
    expect(aggregated.message).toContain("Verified the payment.");
    expect(aggregated.message).toContain("Refund is processing.");
  });

  it("keeps successful results when another task needs clarification", () => {
    const aggregated = aggregateResults([
      result({ taskId: "task-1" }),
      result({
        taskId: "task-2",
        agent: "refund_agent",
        status: "needs_clarification",
        response: "Please share the refund reference.",
      }),
    ]);

    expect(aggregated.status).toBe("partial");
    expect(aggregated.requiresCustomerInput).toBe(true);
    expect(aggregated.message).toContain("Verified the payment.");
    expect(aggregated.message).toContain("Please share the refund reference.");
  });

  it("keeps successful results when another task fails", () => {
    const aggregated = aggregateResults([
      result({ taskId: "task-1" }),
      result({
        taskId: "task-2",
        agent: "refund_agent",
        status: "failed",
        response: "The refund check did not complete.",
      }),
    ]);

    expect(aggregated.status).toBe("partial");
    expect(aggregated.message).toContain("Verified the payment.");
  });

  it("reports escalated when nothing completed and a task was escalated", () => {
    const aggregated = aggregateResults([
      result({
        taskId: "task-1",
        status: "escalated",
        response: "Needs human approval.",
      }),
    ]);

    expect(aggregated.status).toBe("escalated");
  });

  it("reports failed when no task could be processed", () => {
    expect(aggregateResults([]).status).toBe("failed");
  });
});

describe("toTaskSummaries", () => {
  it("preserves references only when present", () => {
    const summaries = toTaskSummaries([
      result({ taskId: "task-1", references: ["TXN12345"] }),
      result({ taskId: "task-2", agent: "refund_agent" }),
    ]);

    expect(summaries[0]?.references).toEqual(["TXN12345"]);
    expect(summaries[1]?.references).toBeUndefined();
  });
});
