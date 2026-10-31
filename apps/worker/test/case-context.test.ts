import { describe, expect, it } from "vitest";
import { createAgentRunner } from "../src/agent/agents.js";
import {
  buildSupervisorRequest,
  type CaseContextEvent,
} from "../src/agent/case-context.js";
import { planTasks } from "../src/agent/planning.js";
import { runSupervisor } from "../src/agent/supervisor.js";
import type { IntentClassifier } from "../src/agent/types.js";
import { confirmed, createFakeInvoker, makeIntent } from "./helpers.js";

function event(
  type: string,
  audience: CaseContextEvent["audience"],
  text: string,
): CaseContextEvent {
  return { type, audience, payload: { text } };
}

describe("buildSupervisorRequest", () => {
  it("uses the latest customer message and excludes internal events", () => {
    const result = buildSupervisorRequest({
      caseId: "case-1",
      customerId: "customer-1",
      facts: { refundId: "RFD12345" },
      events: [
        event("customer_message", "customer", "First message"),
        event("agent_message", "customer", "First reply"),
        event("internal_note", "internal", "Do not expose this"),
        event("customer_message", "customer", "My refund is still pending"),
      ],
    });

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.request).toEqual({
      conversationId: "case-1",
      message: "My refund is still pending",
      authenticatedContext: { customerId: "customer-1", roles: ["customer"] },
      context: {
        facts: { refundId: "RFD12345" },
        recentEvents: [
          "[customer_message] First message",
          "[agent_message] First reply",
        ],
      },
    });
  });

  it("carries pending intents from the previous turn's worker step", () => {
    const result = buildSupervisorRequest({
      caseId: "case-1",
      customerId: "customer-1",
      correlationId: "corr-1",
      events: [
        event("customer_message", "customer", "My refund is late"),
        {
          type: "worker_step",
          audience: "internal",
          payload: { trace: { pendingIntents: ["REFUND_STATUS"] } },
        },
        event("assistant_message", "customer", "Which refund?"),
        event("customer_message", "customer", "refund_5001"),
      ],
    });

    expect(result.ok && result.request.context?.pendingIntents).toEqual(["REFUND_STATUS"]);
    expect(result.ok && result.request.correlationId).toBe("corr-1");
  });

  it("derives the turn id from the triggering customer event", () => {
    const result = buildSupervisorRequest({
      caseId: "case-1",
      customerId: "customer-1",
      events: [
        { ...event("customer_message", "customer", "first"), seq: "1" },
        { ...event("customer_message", "customer", "second"), seq: "4" },
      ],
    });

    expect(result.ok && result.request.turnId).toBe("m4");
  });

  it("does not carry pending intents across an unanswered customer message", () => {
    const result = buildSupervisorRequest({
      caseId: "case-1",
      customerId: "customer-1",
      events: [
        {
          type: "worker_step",
          audience: "internal",
          payload: { trace: { pendingIntents: ["REFUND_STATUS"] } },
        },
        event("customer_message", "customer", "first"),
        event("customer_message", "customer", "second"),
      ],
    });

    expect(result.ok && result.request.context?.pendingIntents).toBeUndefined();
  });

  it("returns a missing message result when no customer message exists", () => {
    const result = buildSupervisorRequest({
      caseId: "case-1",
      customerId: "customer-1",
      events: [event("internal_note", "internal", "No customer message")],
    });

    expect(result).toEqual({ ok: false, reason: "missing_customer_message" });
  });
});

describe("planTasks facts", () => {
  it("fills missing entities from trusted facts", () => {
    const tasks = planTasks(
      [
        makeIntent({
          intent: "COMPLAINT_STATUS",
          agent: "complaint_agent",
          domain: "complaint",
          entities: {},
          missingEntities: ["complaintId"],
        }),
      ],
      { complaintId: "CMP12345" },
    );

    expect(tasks[0]?.entities).toEqual({ complaintId: "CMP12345" });
    expect(tasks[0]?.missingEntities).toEqual([]);
  });

  it("does not override message entities or accept invalid facts", () => {
    const tasks = planTasks(
      [
        makeIntent({
          entities: { refundId: "RFD11111" },
        }),
      ],
      { refundId: "RFD22222", transactionId: 42 },
    );

    expect(tasks[0]?.entities).toEqual({ refundId: "RFD11111" });
  });
});

describe("runSupervisor context", () => {
  it("uses case facts to run a task without asking for the same reference", async () => {
    const { invoker, calls } = createFakeInvoker({
      getRefundStatus: () => confirmed({ status: "processed", refundId: "RFD12345" }),
    });
    const classifier: IntentClassifier = {
      async classify(input) {
        expect(input.recentEvents).toEqual(["[customer_message] Earlier message"]);

        return {
          status: "classified",
          classification: {
            intents: [{ intent: "REFUND_STATUS", entities: {} }],
          },
        };
      },
    };

    const response = await runSupervisor(
      {
        conversationId: "case-1",
        message: "Is it done?",
        authenticatedContext: { customerId: "customer-1", roles: ["customer"] },
        context: {
          facts: { refundId: "RFD12345" },
          recentEvents: ["[customer_message] Earlier message"],
        },
      },
      {
        classifier,
        runner: createAgentRunner(),
        tools: invoker,
        workflowLevel: 2,
      },
    );

    expect(response.status).toBe("completed");
    expect(calls.map((call) => call.args)).toEqual([{ refundId: "RFD12345" }]);
  });
});
