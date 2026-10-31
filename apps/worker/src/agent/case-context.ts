import type { CaseEventRow } from "@repo/core";
import type { SupervisorRequest } from "./types.js";

export type CaseContextEvent = Pick<CaseEventRow, "type" | "audience" | "payload"> &
  Partial<Pick<CaseEventRow, "seq">>;

export type CaseContextInput = {
  caseId: string;
  customerId: string;
  events: CaseContextEvent[];
  facts?: Record<string, unknown>;
  roles?: string[];
  correlationId?: string;
};

export type CaseContextResult =
  | { ok: true; request: SupervisorRequest }
  | { ok: false; reason: "missing_customer_message" };

function eventText(event: CaseContextEvent): string | null {
  const text = event.payload.text;

  if (typeof text === "string" && text.trim().length > 0) {
    return text.trim();
  }

  return null;
}

function recentEventText(event: CaseContextEvent): string | null {
  const text = eventText(event);

  if (text) {
    return `[${event.type}] ${text}`;
  }

  return `[${event.type}] ${JSON.stringify(event.payload)}`;
}

/** Intents the previous turn left waiting on the customer, read from its worker_step event. */
function pendingIntentsBefore(events: CaseContextEvent[], latest: CaseContextEvent): string[] {
  const end = events.indexOf(latest);

  for (let index = end - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event?.type === "customer_message") {
      return [];
    }

    if (event?.type !== "worker_step") {
      continue;
    }

    const trace = event.payload.trace;
    const pending =
      typeof trace === "object" && trace !== null
        ? (trace as { pendingIntents?: unknown }).pendingIntents
        : undefined;

    return Array.isArray(pending)
      ? pending.filter((intent): intent is string => typeof intent === "string").slice(0, 5)
      : [];
  }

  return [];
}

export function buildSupervisorRequest(input: CaseContextInput): CaseContextResult {
  const customerEvents = input.events.filter((event) => event.audience === "customer");

  let latestIndex = -1;

  for (let index = customerEvents.length - 1; index >= 0; index -= 1) {
    const event = customerEvents[index];

    if (event?.type === "customer_message" && eventText(event) !== null) {
      latestIndex = index;
      break;
    }
  }

  if (latestIndex < 0) {
    return { ok: false, reason: "missing_customer_message" };
  }

  const latest = customerEvents[latestIndex];

  if (!latest) {
    return { ok: false, reason: "missing_customer_message" };
  }

  const message = eventText(latest);

  if (!message) {
    return { ok: false, reason: "missing_customer_message" };
  }

  const recentEvents = customerEvents
    .filter((_, index) => index !== latestIndex)
    .slice(-20)
    .flatMap((event) => {
      const text = recentEventText(event);
      return text ? [text] : [];
    });

  const pendingIntents = pendingIntentsBefore(input.events, latest);

  return {
    ok: true,
    request: {
      conversationId: input.caseId,
      message,
      authenticatedContext: {
        customerId: input.customerId,
        roles: input.roles ?? ["customer"],
      },
      context: {
        facts: input.facts ?? {},
        recentEvents,
        ...(pendingIntents.length > 0 ? { pendingIntents } : {}),
      },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(latest.seq ? { turnId: `m${latest.seq}` } : {}),
    },
  };
}
