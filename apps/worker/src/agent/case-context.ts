import type { CaseEventRow } from "@repo/core";
import type { SupervisorRequest } from "./types.js";

export type CaseContextEvent = Pick<CaseEventRow, "type" | "audience" | "payload">;

export type CaseContextInput = {
  caseId: string;
  customerId: string;
  events: CaseContextEvent[];
  facts?: Record<string, unknown>;
  roles?: string[];
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
      },
    },
  };
}
