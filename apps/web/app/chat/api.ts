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

function apiBase(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
    "http://127.0.0.1:3001"
  );
}

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

export function latestAssistantText(
  events: CaseEvent[],
  afterSeq: number,
): string | null {
  const replies = events.filter(
    (event) =>
      event.seq > afterSeq &&
      event.type === "assistant_message" &&
      typeof event.payload.text === "string",
  );
  const last = replies[replies.length - 1];
  return last ? String(last.payload.text) : null;
}

export type IncomingReply = {
  text: string;
  role: "munshi" | "human" | "system";
  seq: number;
};

/** Next customer-visible reply after `afterSeq` (assistant, human, or transfer). */
export function nextIncomingReply(
  events: CaseEvent[],
  afterSeq: number,
): IncomingReply | null {
  const candidates = events
    .filter(
      (event) =>
        event.seq > afterSeq &&
        (event.type === "assistant_message" ||
          event.type === "human_message" ||
          event.type === "human_transfer") &&
        typeof event.payload.text === "string",
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
