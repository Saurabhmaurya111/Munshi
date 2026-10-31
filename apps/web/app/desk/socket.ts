"use client";

import { io, type Socket } from "socket.io-client";
import { apiBase } from "../lib/api-base";
import { readDeskSession } from "./session";

export type DeskLiveEvent = {
  caseId: string;
  seq: number;
  type: string;
  audience: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export function connectDeskSocket(): Socket | null {
  const session = readDeskSession();
  if (!session) return null;
  return io(`${apiBase()}/desk`, {
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
