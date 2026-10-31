import { describe, expect, it } from "vitest";
import { buildExecutionBatches, planTasks } from "../src/agent/planning.js";
import type { AgentTask } from "../src/agent/types.js";
import { makeIntent, makeTask } from "./helpers.js";

describe("planTasks", () => {
  it("creates stable task ids in registry order", () => {
    const tasks = planTasks([
      makeIntent({ intent: "REFUND_STATUS", agent: "refund_agent", domain: "refund" }),
      makeIntent({ intent: "UPI_PAYMENT_ISSUE" }),
    ]);

    expect(tasks.map((task) => task.taskId)).toEqual(["task-1", "task-2"]);
    expect(tasks.map((task) => task.intent)).toEqual([
      "UPI_PAYMENT_ISSUE",
      "REFUND_STATUS",
    ]);
  });

  it("makes a complaint depend on the investigation in the same message", () => {
    const tasks = planTasks([
      makeIntent({
        intent: "COMPLAINT_CREATE",
        agent: "complaint_agent",
        domain: "complaint",
        entities: {},
      }),
      makeIntent({ intent: "UPI_PAYMENT_ISSUE" }),
      makeIntent({
        intent: "REFUND_STATUS",
        agent: "refund_agent",
        domain: "refund",
        entities: { refundId: "RFD12345" },
      }),
    ]);

    const complaint = tasks.find((task) => task.intent === "COMPLAINT_CREATE");

    expect(complaint?.dependsOn).toEqual(["task-1", "task-2"]);
  });
});

describe("buildExecutionBatches", () => {
  it("runs independent tasks together and dependent tasks later", () => {
    const tasks = planTasks([
      makeIntent({
        intent: "COMPLAINT_CREATE",
        agent: "complaint_agent",
        domain: "complaint",
        entities: {},
      }),
      makeIntent({ intent: "UPI_PAYMENT_ISSUE" }),
      makeIntent({
        intent: "REFUND_STATUS",
        agent: "refund_agent",
        domain: "refund",
        entities: { refundId: "RFD12345" },
      }),
    ]);

    const plan = buildExecutionBatches(tasks);

    expect(plan.ok).toBe(true);

    if (plan.ok) {
      expect(plan.batches.map((batch) => batch.map((task) => task.intent))).toEqual([
        ["UPI_PAYMENT_ISSUE", "REFUND_STATUS"],
        ["COMPLAINT_CREATE"],
      ]);
    }
  });

  it("puts unrelated tasks in one batch", () => {
    const tasks = planTasks([
      makeIntent({ intent: "UPI_PAYMENT_ISSUE" }),
      makeIntent({
        intent: "ACCOUNT_ISSUE",
        agent: "account_agent",
        domain: "account",
        entities: {},
      }),
    ]);

    const plan = buildExecutionBatches(tasks);

    expect(plan.ok).toBe(true);

    if (plan.ok) {
      expect(plan.batches).toHaveLength(1);
      expect(plan.batches[0]).toHaveLength(2);
    }
  });

  it("refuses a dependency cycle", () => {
    const tasks: AgentTask[] = [
      makeTask({ taskId: "a", dependsOn: ["b"] }),
      makeTask({ taskId: "b", dependsOn: ["a"] }),
    ];

    expect(buildExecutionBatches(tasks).ok).toBe(false);
  });

  it("refuses an unknown dependency", () => {
    const tasks: AgentTask[] = [makeTask({ taskId: "a", dependsOn: ["missing"] })];

    expect(buildExecutionBatches(tasks).ok).toBe(false);
  });
});
