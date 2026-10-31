import type {
  AgentTaskResult,
  RunStatus,
  SupervisorTaskSummary,
} from "./types.js";

export type AggregatedResult = {
  status: RunStatus;
  message: string;
  requiresCustomerInput: boolean;
};

export function aggregateResults(results: AgentTaskResult[]): AggregatedResult {
  if (results.length === 0) {
    return {
      status: "failed",
      message: "No supported task could be processed.",
      requiresCustomerInput: false,
    };
  }

  const completed = results.filter((result) => result.status === "completed").length;
  const hasClarification = results.some((result) => result.status === "needs_clarification");
  const hasEscalation = results.some((result) => result.status === "escalated");

  let status: RunStatus;

  if (completed === results.length) {
    status = "completed";
  } else if (completed > 0) {
    status = "partial";
  } else if (hasEscalation) {
    status = "escalated";
  } else if (hasClarification) {
    status = "needs_clarification";
  } else {
    status = "failed";
  }

  const message = [...new Set(results.map((result) => result.response.trim()))]
    .filter((part) => part.length > 0)
    .join(" ");

  return {
    status,
    message: message.length > 0 ? message : "The request could not be completed.",
    requiresCustomerInput: hasClarification,
  };
}

export function toTaskSummaries(results: AgentTaskResult[]): SupervisorTaskSummary[] {
  return results.map((result) => ({
    taskId: result.taskId,
    agent: result.agent,
    status: result.status,
    summary: result.response,
    ...(result.references && result.references.length > 0
      ? { references: result.references }
      : {}),
  }));
}
