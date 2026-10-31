import { randomUUID } from "node:crypto";
import {
  appendEventWithEpoch,
  listCaseEvents,
  releaseCase,
  requestWriteApproval,
  transferCaseToHumanWithEpoch,
  type CaseRow,
  type Db,
} from "@repo/core";
import { buildSupervisorRequest } from "./agent/case-context.js";
import {
  runSupervisorWithTrace,
  type SupervisorDependencies,
} from "./agent/supervisor.js";
import type { SupervisorResponse } from "./agent/types.js";

export type ProcessClaimInput = {
  db: Db;
  caseRow: CaseRow;
  heldEpoch: string;
  workerId: string;
  dependencies: SupervisorDependencies;
};

export type ProcessClaimResult = {
  caseId: string;
  status: string;
  message: string;
  transferredToHuman?: boolean;
  ticketId?: string;
};

function escalationOwnership(
  response: SupervisorResponse,
): "HUMAN_OWNED" | "PENDING_APPROVAL" {
  const needsApproval = response.tasks.some(
    (task) =>
      task.status === "escalated" &&
      (task.errorCode === "APPROVAL_REQUIRED" ||
        task.errorCode === "POLICY_BLOCKED"),
  );
  return needsApproval ? "PENDING_APPROVAL" : "HUMAN_OWNED";
}

function buildEscalationPayload(response: SupervisorResponse): {
  reason: string;
  summary: string;
  recommendation: string;
  neededFromHuman: string;
  customerNotice: string;
} {
  const escalated = response.tasks.filter((task) => task.status === "escalated");
  const reason =
    escalated.map((task) => task.summary).join(" ") || response.message;

  const ownership = escalationOwnership(response);
  if (ownership === "PENDING_APPROVAL") {
    return {
      reason,
      summary: `Munshi held a write action for approval. Customer message context and task outcomes: ${response.message}`,
      recommendation:
        "Review the proposed action, approve or reject it, then continue the conversation.",
      neededFromHuman:
        "Approve or reject the pending write, then reply to the customer.",
      customerNotice:
        "I’ve handed this to a support specialist for review. They’ll continue helping you here.",
    };
  }

  return {
    reason,
    summary: `Munshi escalated this case. Status: ${response.status}. Details: ${response.message}`,
    recommendation:
      "Take over the conversation, verify the facts on the case, and resolve the customer's issue.",
    neededFromHuman: "Join the chat and help the customer finish their request.",
    customerNotice:
      "I’ve connected you with a support specialist who can help resolve this. Please stay on this chat.",
  };
}

/**
 * Claimed-case turn: rebuild context → supervisor → persist reply events.
 * Escalations raise a complaint ticket and transfer ownership to Desk.
 */
export async function processClaimedCase(
  input: ProcessClaimInput,
): Promise<ProcessClaimResult> {
  const { db, caseRow, heldEpoch, workerId, dependencies } = input;
  const correlationId = randomUUID();
  const events = await listCaseEvents(db, { caseId: caseRow.id, limit: 100 });
  const built = buildSupervisorRequest({
    caseId: caseRow.id,
    customerId: caseRow.customerId,
    events,
    correlationId,
  });

  if (!built.ok) {
    await releaseCase(db, {
      caseId: caseRow.id,
      heldEpoch,
      runnable: false,
    });
    return {
      caseId: caseRow.id,
      status: "skipped",
      message: built.reason,
    };
  }

  const { response, trace } = await runSupervisorWithTrace(built.request, dependencies);

  const approvalTask = response.tasks.find(
    (task) =>
      task.status === "escalated" &&
      task.errorCode === "APPROVAL_REQUIRED" &&
      typeof task.data?.stepId === "string" &&
      typeof task.data?.tool === "string",
  );

  if (approvalTask?.data) {
    await appendEventWithEpoch(db, {
      caseId: caseRow.id,
      heldEpoch,
      type: "worker_step",
      audience: "internal",
      payload: {
        workerId,
        status: response.status,
        tasks: response.tasks,
        requiresCustomerInput: response.requiresCustomerInput,
      },
      releaseLease: false,
    });

    await requestWriteApproval(db, {
      caseId: caseRow.id,
      stepId: String(approvalTask.data.stepId),
      tool: String(approvalTask.data.tool),
      intentId:
        typeof approvalTask.data.intentId === "string"
          ? approvalTask.data.intentId
          : undefined,
      message: response.message,
    });

    return {
      caseId: caseRow.id,
      status: "pending_approval",
      message: response.message,
    };
  }

  await appendEventWithEpoch(db, {
    caseId: caseRow.id,
    heldEpoch,
    type: "worker_step",
    audience: "internal",
    payload: {
      workerId,
      correlationId,
      status: response.status,
      tasks: response.tasks,
      requiresCustomerInput: response.requiresCustomerInput,
      trace,
    },
    releaseLease: false,
  });

  const shouldTransfer = response.status === "escalated";
  const escalation = shouldTransfer
    ? buildEscalationPayload(response)
    : null;

  if (shouldTransfer && escalation) {
    const transfer = await transferCaseToHumanWithEpoch(db, {
      caseId: caseRow.id,
      heldEpoch,
      reason: escalation.reason,
      summary: escalation.summary,
      recommendation: escalation.recommendation,
      neededFromHuman: escalation.neededFromHuman,
      ownership: escalationOwnership(response),
      customerNotice: escalation.customerNotice,
      includeCustomerNotice: false,
      source: "ai_escalate",
    });

    const ticketId = transfer.ticket?.complaintId;
    const customerText = [
      response.message,
      escalation.customerNotice,
      ticketId ? `Your ticket ID is ${ticketId}.` : null,
    ]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(" ")
      .trim();

    await appendEventWithEpoch(db, {
      caseId: caseRow.id,
      heldEpoch,
      type: "assistant_message",
      audience: "customer",
      payload: {
        text: customerText,
        status: response.status,
        tasks: response.tasks,
        requiresCustomerInput: response.requiresCustomerInput,
        transferredToHuman: true,
        ...(ticketId ? { ticketId } : {}),
      },
      runnable: false,
      releaseLease: true,
    });

    return {
      caseId: caseRow.id,
      status: response.status,
      message: customerText,
      transferredToHuman: true,
      ...(ticketId ? { ticketId } : {}),
    };
  }

  await appendEventWithEpoch(db, {
    caseId: caseRow.id,
    heldEpoch,
    type: "assistant_message",
    audience: "customer",
    payload: {
      text: response.message,
      status: response.status,
      tasks: response.tasks,
      requiresCustomerInput: response.requiresCustomerInput,
    },
    runnable: false,
    releaseLease: true,
  });

  return {
    caseId: caseRow.id,
    status: response.status,
    message: response.message,
  };
}
