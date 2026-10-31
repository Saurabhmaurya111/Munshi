import { apiBase } from "../lib/api-base";
import { readSession } from "../lib/session";

export type CaseEvent = {
  seq: number;
  type: string;
  audience: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type CaseSnapshot = {
  conversationId: string;
  status: string;
  ownership: string;
  customerId: string;
  runnable: boolean;
  lastEventSeq: number;
  events: CaseEvent[];
};

export type PostMessageResult = {
  conversationId: string;
  status: string;
  seq: number;
  ownership?: string;
};

export type TransferResult = {
  conversationId: string;
  ownership: string;
  status: string;
  lastEventSeq: number;
  ticketId?: string | null;
  ticketStatus?: string | null;
};

export function customerId(): string {
  const session = readSession();
  if (session?.customerId) return session.customerId;
  return process.env.NEXT_PUBLIC_CUSTOMER_ID?.trim() || "customer-soham";
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-customer-id": customerId(),
      ...(init?.headers ?? {}),
    },
  });
}

export async function postCustomerMessage(input: {
  message: string;
  caseId?: string;
  commandId: string;
}): Promise<PostMessageResult> {
  const response = await apiFetch("/v1/cases/messages", {
    method: "POST",
    body: JSON.stringify({
      message: input.message,
      caseId: input.caseId,
      commandId: input.commandId,
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }

  return (await response.json()) as PostMessageResult;
}

export async function requestHumanTransfer(input: {
  caseId: string;
  commandId: string;
  reason?: string;
}): Promise<TransferResult> {
  const response = await apiFetch(
    `/v1/cases/${input.caseId}/transfer-to-human`,
    {
      method: "POST",
      body: JSON.stringify({
        commandId: input.commandId,
        reason: input.reason,
      }),
    },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }

  return (await response.json()) as TransferResult;
}

export async function getCase(caseId: string): Promise<CaseSnapshot> {
  const response = await apiFetch(`/v1/cases/${caseId}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }
  return (await response.json()) as CaseSnapshot;
}

export function isPendingApprovalEvent(event: CaseEvent): boolean {
  if (typeof event.payload.text !== "string") return false;
  if (event.payload.pendingApproval === true) {
    return event.type === "status" || event.type === "assistant_message";
  }
  return false;
}

export function isTurnResolutionEvent(event: CaseEvent): boolean {
  if (typeof event.payload.text !== "string") return false;
  if (isPendingApprovalEvent(event)) return false;
  if (event.type === "assistant_message") return true;
  if (event.type === "human_message") return true;
  if (event.type === "status" && event.payload.pendingApproval === false) {
    return true;
  }
  return false;
}

/** Final customer-facing reply after `afterSeq`, skipping parked-approval notices. */
export function latestAssistantText(
  events: CaseEvent[],
  afterSeq: number,
): string | null {
  const replies = events.filter(
    (event) => event.seq > afterSeq && isTurnResolutionEvent(event),
  );
  const last = replies[replies.length - 1];
  return last ? String(last.payload.text) : null;
}

export function latestPendingApprovalText(
  events: CaseEvent[],
  afterSeq: number,
): { text: string; seq: number } | null {
  const pending = events.filter(
    (event) => event.seq > afterSeq && isPendingApprovalEvent(event),
  );
  const last = pending[pending.length - 1];
  if (!last || typeof last.payload.text !== "string") return null;
  return { text: String(last.payload.text), seq: last.seq };
}

export function apiOrigin(): string {
  return apiBase();
}

export type IncomingReply = {
  text: string;
  role: "munshi" | "human" | "system";
  seq: number;
};

/** Next customer-visible reply after `afterSeq` (assistant, status, human, or transfer). */
export function nextIncomingReply(
  events: CaseEvent[],
  afterSeq: number,
  options?: { includePendingApproval?: boolean },
): IncomingReply | null {
  const includePending = options?.includePendingApproval === true;
  const candidates = events
    .filter(
      (event) =>
        event.seq > afterSeq &&
        (event.type === "assistant_message" ||
          event.type === "status" ||
          event.type === "human_message" ||
          event.type === "human_transfer") &&
        typeof event.payload.text === "string" &&
        (includePending || !isPendingApprovalEvent(event)),
    )
    .sort((a, b) => a.seq - b.seq);

  const first = candidates[0];
  if (!first) return null;

  const role =
    first.type === "human_message"
      ? "human"
      : first.type === "human_transfer"
        ? "system"
        : "munshi";

  return {
    text: String(first.payload.text),
    role,
    seq: first.seq,
  };
}

export function isHumanOwned(ownership: string | undefined): boolean {
  return ownership === "HUMAN_OWNED" || ownership === "PENDING_APPROVAL";
}

export type WorkflowStatus = {
  name: string;
  level: 0 | 1 | 2;
  consecutiveCleanRuns: number;
  writeCleanRuns: number;
  promotionThreshold: number;
  progress: number;
  nextLevel: 0 | 1 | 2 | null;
  runsToNext: number;
  updatedAt: string;
};

export async function getWorkflow(
  name = "default",
): Promise<WorkflowStatus> {
  const safe = name.trim() || "default";
  const response = await apiFetch(
    `/v1/workflows/${encodeURIComponent(safe)}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }
  return (await response.json()) as WorkflowStatus;
}

/** Latest domain workflow stamped on turn / reply / status events. */
export function latestWorkflowName(
  events: CaseEvent[],
  fallback = "default",
): string {
  const ordered = [...events].sort((a, b) => b.seq - a.seq);
  for (const event of ordered) {
    const name = event.payload.workflowName;
    if (typeof name === "string" && name.trim()) {
      return name.trim();
    }
  }
  return fallback;
}
