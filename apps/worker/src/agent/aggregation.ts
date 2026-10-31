import type {
  AgentName,
  AgentTaskResult,
  RunStatus,
  SupervisorTaskSummary,
} from "./types.js";

export type AggregatedResult = {
  status: RunStatus;
  message: string;
  requiresCustomerInput: boolean;
};

export type AggregateOptions = {
  /** Safety notes shown before the task answers. */
  notes?: string[];
};

const AGENT_LABELS: Record<AgentName, string> = {
  upi_agent: "UPI payment",
  refund_agent: "Refund",
  recharge_agent: "Recharge",
  account_agent: "Account",
  complaint_agent: "Complaint",
};

function composeMessage(results: AgentTaskResult[], notes: string[]): string {
  const seen = new Set<string>();
  const answers = results.flatMap((result) => {
    const response = result.response.trim();

    if (response.length === 0 || seen.has(response)) {
      return [];
    }

    seen.add(response);
    return [{ agent: result.agent, response }];
  });

  const body =
    answers.length > 1
      ? answers.map((answer) => `${AGENT_LABELS[answer.agent]}: ${answer.response}`).join("\n\n")
      : (answers[0]?.response ?? "");

  return [...notes, body].filter((part) => part.length > 0).join("\n\n");
}

export function aggregateResults(
  results: AgentTaskResult[],
  options: AggregateOptions = {},
): AggregatedResult {
  const notes = options.notes ?? [];

  if (results.length === 0) {
    return {
      status: "failed",
      message: [...notes, "No supported task could be processed."].join("\n\n"),
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

  const message = composeMessage(results, notes);

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
    ...(result.citations && result.citations.length > 0
      ? { citations: result.citations }
      : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  }));
}
