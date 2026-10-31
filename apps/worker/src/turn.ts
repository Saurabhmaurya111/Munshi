import { randomUUID } from "node:crypto";
import {
  appendEventWithEpoch,
  listCaseEvents,
  releaseCase,
  requestWriteApproval,
  type CaseRow,
  type Db,
} from "@repo/core";
import { buildSupervisorRequest } from "./agent/case-context.js";
import {
  runSupervisorWithTrace,
  type SupervisorDependencies,
} from "./agent/supervisor.js";

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
};

/**
 * Claimed-case turn: rebuild context → supervisor → persist reply events.
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
