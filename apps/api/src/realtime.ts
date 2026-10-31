import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import {
  getCaseById,
  getCaseForCustomer,
  listCaseEventsAfter,
  onCaseEvent,
  type Db,
} from "@repo/core";

export type RealtimeServer = {
  io: Server;
  stop: () => void;
};

function wsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return (
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:")
  );
}

export function attachRealtime(httpServer: HttpServer, db: Db): RealtimeServer {
  const io = new Server(httpServer, {
    transports: ["websocket"],
    cors: {
      origin: (origin, callback) => {
        callback(null, wsOriginAllowed(origin));
      },
    },
  });

  const customerNs = io.of("/customer");
  const deskNs = io.of("/desk");

  customerNs.use((socket, next) => {
    const customerId =
      (socket.handshake.auth?.customerId as string | undefined)?.trim() ||
      (socket.handshake.headers["x-customer-id"] as string | undefined)?.trim();
    if (!customerId) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.customerId = customerId;
    next();
  });

  deskNs.use((socket, next) => {
    const role =
      (socket.handshake.auth?.role as string | undefined)?.trim() ||
      (socket.handshake.headers["x-desk-role"] as string | undefined)?.trim();
    const actorId =
      (socket.handshake.auth?.actorId as string | undefined)?.trim() ||
      (socket.handshake.headers["x-desk-actor"] as string | undefined)?.trim();
    if (!role || !actorId) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.role = role;
    socket.data.actorId = actorId;
    next();
  });

  customerNs.on("connection", (socket) => {
    socket.on(
      "subscribe",
      async (payload: { caseId?: string; lastSeq?: number }, ack?) => {
        try {
          const caseId = payload?.caseId;
          const lastSeq = Number(payload?.lastSeq ?? 0);
          if (!caseId) {
            ack?.({ ok: false, error: "caseId required" });
            return;
          }
          const customerId = socket.data.customerId as string;
          await getCaseForCustomer(db, { caseId, customerId });
          await socket.join(`case:${caseId}`);
          const gap = await listCaseEventsAfter(db, {
            caseId,
            afterSeq: lastSeq,
            audience: "customer",
          });
          for (const event of gap) {
            socket.emit("case_event", {
              caseId,
              seq: Number(event.seq),
              type: event.type,
              audience: event.audience,
              payload: event.payload,
              createdAt: event.createdAt.toISOString(),
            });
          }
          ack?.({ ok: true, replayed: gap.length });
        } catch (error) {
          ack?.({
            ok: false,
            error: error instanceof Error ? error.message : "subscribe_failed",
          });
        }
      },
    );
  });

  deskNs.on("connection", (socket) => {
    socket.on(
      "subscribe",
      async (payload: { caseId?: string; lastSeq?: number }, ack?) => {
        try {
          const caseId = payload?.caseId;
          const lastSeq = Number(payload?.lastSeq ?? 0);
          if (!caseId) {
            ack?.({ ok: false, error: "caseId required" });
            return;
          }
          await getCaseById(db, caseId);
          await socket.join(`case:${caseId}`);
          const gap = await listCaseEventsAfter(db, {
            caseId,
            afterSeq: lastSeq,
            audience: ["desk", "customer", "internal"],
          });
          for (const event of gap) {
            socket.emit("case_event", {
              caseId,
              seq: Number(event.seq),
              type: event.type,
              audience: event.audience,
              payload: event.payload,
              createdAt: event.createdAt.toISOString(),
            });
          }
          ack?.({ ok: true, replayed: gap.length });
        } catch (error) {
          ack?.({
            ok: false,
            error: error instanceof Error ? error.message : "subscribe_failed",
          });
        }
      },
    );
  });

  const unsubscribe = onCaseEvent(async (notice) => {
    try {
      const gap = await listCaseEventsAfter(db, {
        caseId: notice.caseId,
        afterSeq: notice.seq - 1,
        limit: 1,
      });
      const event = gap[0];
      if (!event || Number(event.seq) !== notice.seq) return;

      const payload = {
        caseId: notice.caseId,
        seq: Number(event.seq),
        type: event.type,
        audience: event.audience,
        payload: event.payload,
        createdAt: event.createdAt.toISOString(),
      };

      if (event.audience === "customer") {
        customerNs.to(`case:${notice.caseId}`).emit("case_event", payload);
      }
      if (event.audience === "desk" || event.audience === "internal") {
        deskNs.to(`case:${notice.caseId}`).emit("case_event", payload);
      }
      if (event.audience === "customer") {
        deskNs.to(`case:${notice.caseId}`).emit("case_event", payload);
      }
    } catch {
      // Fan-out must not crash the API.
    }
  });

  return {
    io,
    stop: () => {
      unsubscribe();
      void io.close();
    },
  };
}
