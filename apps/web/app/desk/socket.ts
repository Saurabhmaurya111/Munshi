"use client";

import { io, type Socket } from "socket.io-client";
import { readDeskSession } from "./session";

export type DeskLiveEvent = {
  caseId: string;
  seq: number;
  type: string;
  audience: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

function apiOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
    "http://127.0.0.1:3001"
  );
}

export function connectDeskSocket(): Socket | null {
  const session = readDeskSession();
  if (!session) return null;
  return io(`${apiOrigin()}/desk`, {
    transports: ["websocket"],
    auth: {
      actorId: session.actorId,
      role: session.role,
    },
  });
}

export function subscribeDeskQueue(
  socket: Socket,
  onEvent: (event: DeskLiveEvent) => void,
): () => void {
  socket.on("desk_event", onEvent);
  return () => {
    socket.off("desk_event", onEvent);
  };
}
