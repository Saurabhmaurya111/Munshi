import { apiBase } from "../lib/api-base";
import { readDeskSession } from "../lib/desk-session";
import type { DeskSession as DeskAuthSession } from "./session";

export type DeskQueueItem = {
  conversationId: string;
  ownership: string;
  status: string;
  customerId: string;
  priority: number;
  waitingFor: "human" | "approval";
  updatedAt: string;
  latestCustomerText: string | null;
  escalationSummary: string | null;
  recommendation: string | null;
  ticketId: string | null;
  ticketStatus: string | null;
  parkedAtWorkflowName: string | null;
  parkedAtWorkflowLevel: 0 | 1 | 2 | null;
  currentWorkflowLevel: 0 | 1 | 2 | null;
  promotionHint: string | null;
};

export type DeskCaseEvent = {
  seq: number;
  type: string;
  audience: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type DeskCaseSnapshot = {
  conversationId: string;
  status: string;
  ownership: string;
  customerId: string;
  runnable: boolean;
  lastEventSeq: number;
  events: DeskCaseEvent[];
};

function agentId(): string {
  const session = readDeskSession();
  if (session?.agentId) return session.agentId;
  return "desk-priya";
}

async function deskFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-desk-agent-id": agentId(),
      ...(init?.headers ?? {}),
    },
  });
}

export async function loginDesk(input: {
  id: string;
  password: string;
}): Promise<DeskAuthSession> {
  const response = await fetch(`${apiBase()}/v1/desk/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: input.id,
      password: input.password,
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || "Sign in failed.");
  }

  const body = (await response.json()) as {
    token: string;
    actorId: string;
    role: string;
  };

  return {
    token: body.token,
    actorId: body.actorId,
    role: body.role,
  };
}

export async function getDeskMe(): Promise<{
  agentId: string;
  displayName: string;
  role: string;
}> {
  const response = await deskFetch("/v1/desk/me");
  if (!response.ok) {
    throw new Error("Desk sign-in failed");
  }
  return (await response.json()) as {
    agentId: string;
    displayName: string;
    role: string;
  };
}

export async function getDeskQueue(): Promise<DeskQueueItem[]> {
  const response = await deskFetch("/v1/desk/queue");
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }
  const body = (await response.json()) as { items: DeskQueueItem[] };
  return body.items;
}

export async function getDeskCase(caseId: string): Promise<DeskCaseSnapshot> {
  const response = await deskFetch(`/v1/desk/cases/${caseId}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }
  return (await response.json()) as DeskCaseSnapshot;
}

export async function approveDeskItem(input: {
  caseId: string;
  stepId: string;
  commandId: string;
  note?: string;
}): Promise<void> {
  const response = await deskFetch(`/v1/desk/cases/${input.caseId}/approve`, {
    method: "POST",
    body: JSON.stringify({
      commandId: input.commandId,
      stepId: input.stepId,
      note: input.note,
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }
}

export async function rejectDeskItem(input: {
  caseId: string;
  stepId: string;
  commandId: string;
  note?: string;
}): Promise<void> {
  const response = await deskFetch(`/v1/desk/cases/${input.caseId}/reject`, {
    method: "POST",
    body: JSON.stringify({
      commandId: input.commandId,
      stepId: input.stepId,
      note: input.note,
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }
}

export async function takeoverCase(input: {
  caseId: string;
  commandId: string;
  note?: string;
}): Promise<void> {
  const response = await deskFetch(
    `/v1/desk/cases/${input.caseId}/takeover`,
    {
      method: "POST",
      body: JSON.stringify({
        commandId: input.commandId,
        note: input.note,
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }
}

export async function handBackCase(input: {
  caseId: string;
  commandId: string;
  note: string;
}): Promise<void> {
  const response = await deskFetch(
    `/v1/desk/cases/${input.caseId}/hand-back`,
    {
      method: "POST",
      body: JSON.stringify({
        commandId: input.commandId,
        note: input.note,
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }
}

export async function postDeskMessage(input: {
  caseId: string;
  message: string;
  commandId: string;
}): Promise<void> {
  const response = await deskFetch(
    `/v1/desk/cases/${input.caseId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        message: input.message,
        commandId: input.commandId,
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }
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

export async function listWorkflows(): Promise<WorkflowStatus[]> {
  const response = await deskFetch("/v1/workflows");
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }
  const body = (await response.json()) as { items: WorkflowStatus[] };
  return body.items ?? [];
}

export async function promoteWorkflow(
  name: string,
  level?: 0 | 1 | 2,
): Promise<WorkflowStatus> {
  const response = await deskFetch(
    `/v1/workflows/${encodeURIComponent(name)}/promote`,
    {
      method: "POST",
      body: JSON.stringify(level === undefined ? {} : { level }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error || `API ${response.status}`);
  }
  return (await response.json()) as WorkflowStatus;
}
