import { randomUUID } from "node:crypto";
import {
  appendEventWithEpoch,
  getWorkflowStatus,
  listCaseEvents,
  recordWorkflowRun,
  releaseCase,
  requestReplyApproval,
  requestWriteApproval,
  transferCaseToHumanWithEpoch,
  type CaseRow,
  type Db,
  type WorkflowLevel,
} from "@repo/core";
import { buildSupervisorRequest } from "./agent/case-context.js";
import {
  runSupervisorWithTrace,
  type SupervisorDependencies,
} from "./agent/supervisor.js";
import type { SupervisorResponse } from "./agent/types.js";
import { workflowNameFromClassification } from "./agent/workflow-route.js";

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
  workflowName?: string;
  workflowLevel?: WorkflowLevel;
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

const WRITE_TOOLS = new Set([
  "createComplaint",
  "addComplaintDetails",
  "escalateComplaint",
]);

function includedWrite(response: SupervisorResponse): boolean {
  return response.tasks.some((task) => {
    if (typeof task.data?.tool === "string" && WRITE_TOOLS.has(task.data.tool)) {
      return true;
    }
    if (task.errorCode === "APPROVAL_REQUIRED") {
      return true;
    }
    return task.agent === "complaint_agent" && task.status === "completed";
  });
}

function isCleanRun(status: string, response: SupervisorResponse): boolean {
  if (
    status === "completed" ||
    status === "needs_clarification" ||
    status === "pending_approval"
  ) {
    return true;
  }

  if (status === "escalated") {
    return response.tasks.every(
      (task) =>
        task.status !== "escalated" ||
        task.errorCode === "APPROVAL_REQUIRED" ||
        response.pendingReplyApproval,
    );
  }

  return false;
}

/**
 * Claimed-case turn: pick domain workflow → supervisor → persist reply events.
 * L0 reply holds park for desk approve (no human takeover).
 * Write holds and real escalations still go to Desk.
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
    const workflow = await getWorkflowStatus(db);
    await releaseCase(db, {
      caseId: caseRow.id,
      heldEpoch,
      runnable: false,
    });
    return {
      caseId: caseRow.id,
      status: "skipped",
      message: built.reason,
      workflowName: workflow.name,
      workflowLevel: workflow.level,
    };
  }

  // Route this turn onto the domain workflow (upi / wallet / …) before policy runs.
  let workflowName = "default";
  try {
    const classified = await dependencies.classifier.classify({
      conversationId: built.request.conversationId,
      message: built.request.message,
      authenticatedContext: built.request.authenticatedContext,
      recentEvents: built.request.context?.recentEvents,
      pendingIntents: built.request.context?.pendingIntents,
    });
    if (classified.status === "classified") {
      workflowName = workflowNameFromClassification(classified.classification);
    }
  } catch {
    workflowName = "default";
  }

  const workflow = await getWorkflowStatus(db, workflowName);
  const deps: SupervisorDependencies = {
    ...dependencies,
    workflowLevel: workflow.level,
  };

  const { response, trace } = await runSupervisorWithTrace(built.request, deps);

  const approvalTask = response.tasks.find(
    (task) =>
      task.status === "escalated" &&
      task.errorCode === "APPROVAL_REQUIRED" &&
      typeof task.data?.stepId === "string" &&
      typeof task.data?.tool === "string",
  );

  if (response.pendingReplyApproval && response.draftReply) {
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
        workflowName: workflow.name,
        workflowLevel: workflow.level,
        pendingReplyApproval: true,
      },
      releaseLease: false,
    });

    await requestReplyApproval(db, {
      caseId: caseRow.id,
      stepId: `reply:${correlationId}`,
      draftReply: response.draftReply,
      previewMessage: response.message,
      workflowName: workflow.name,
      workflowLevel: workflow.level,
    });

    const updated = await recordWorkflowRun(
      db,
      { clean: true, includedWrite: false },
      workflow.name,
    );

    return {
      caseId: caseRow.id,
      status: "pending_approval",
      message: response.message,
      workflowName: updated.name,
      workflowLevel: updated.level,
    };
  }

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
        workflowName: workflow.name,
        workflowLevel: workflow.level,
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
      workflowName: workflow.name,
      workflowLevel: workflow.level,
    });

    const updated = await recordWorkflowRun(
      db,
      { clean: true, includedWrite: true },
      workflow.name,
    );

    return {
      caseId: caseRow.id,
      status: "pending_approval",
      message: response.message,
      workflowName: updated.name,
      workflowLevel: updated.level,
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
      workflowName: workflow.name,
      workflowLevel: workflow.level,
      trace,
    },
    releaseLease: false,
  });

  const shouldTransfer =
    response.status === "escalated" && !response.pendingReplyApproval;
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
      workflowName: workflow.name,
      workflowLevel: workflow.level,
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

    const pendingApproval =
      escalationOwnership(response) === "PENDING_APPROVAL";

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
        pendingApproval,
        workflowName: workflow.name,
        workflowLevel: workflow.level,
        ...(ticketId ? { ticketId } : {}),
      },
      runnable: false,
      releaseLease: true,
    });

    return {
      caseId: caseRow.id,
      status: pendingApproval ? "pending_approval" : response.status,
      message: customerText,
      transferredToHuman: true,
      workflowName: workflow.name,
      workflowLevel: workflow.level,
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
      workflowName: workflow.name,
      workflowLevel: workflow.level,
    },
    runnable: false,
    releaseLease: true,
  });

  const updated = await recordWorkflowRun(
    db,
    {
      clean: isCleanRun(response.status, response),
      includedWrite: includedWrite(response),
    },
    workflow.name,
  );

  return {
    caseId: caseRow.id,
    status: response.status,
    message: response.message,
    workflowName: updated.name,
    workflowLevel: updated.level,
  };
}
