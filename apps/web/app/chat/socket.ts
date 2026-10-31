"use client";

import { io, type Socket } from "socket.io-client";
import { apiOrigin, customerId, type CaseEvent } from "./api";

export type LiveCaseEvent = CaseEvent & { caseId: string };

export function connectCustomerSocket(): Socket {
  return io(`${apiOrigin()}/customer`, {
    transports: ["websocket"],
    auth: { customerId: customerId() },
  });
}

export function subscribeCase(
  socket: Socket,
  caseId: string,
  lastSeq: number,
  onEvent: (event: LiveCaseEvent) => void,
): () => void {
  const handler = (event: LiveCaseEvent) => {
    if (event.caseId === caseId) onEvent(event);
  };
  socket.on("case_event", handler);
  socket.emit("subscribe", { caseId, lastSeq });
  return () => {
    socket.off("case_event", handler);
  };
}
