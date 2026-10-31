import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import {
  getCaseById,
  getCaseForCustomer,
  listCaseEventsAfter,
  onCaseEvent,
  startCaseEventListenBridge,
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

const DESK_QUEUE_ROOM = "desk:queue";

function isDeskQueueEvent(type: string): boolean {
  return (
    type === "approval_requested" ||
    type === "approval_granted" ||
    type === "approval_rejected" ||
    type === "takeover" ||
    type === "hand_back"
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
    void socket.join(DESK_QUEUE_ROOM);

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

  // Dedupe in-process bus + LISTEN/HTTP bridges for the same seq.
  const recentlyFanout = new Map<string, number>();
  const FANOUT_TTL_MS = 30_000;

  const unsubscribe = onCaseEvent(async (notice) => {
    const key = `${notice.caseId}:${notice.seq}`;
    const now = Date.now();
    const prev = recentlyFanout.get(key);
    if (prev && now - prev < FANOUT_TTL_MS) return;
    recentlyFanout.set(key, now);
    if (recentlyFanout.size > 2_000) {
      for (const [k, at] of recentlyFanout) {
        if (now - at > FANOUT_TTL_MS) recentlyFanout.delete(k);
      }
    }

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
        deskNs.to(`case:${notice.caseId}`).emit("case_event", payload);
      }
      if (event.audience === "desk" || event.audience === "internal") {
        deskNs.to(`case:${notice.caseId}`).emit("case_event", payload);
      }
      if (isDeskQueueEvent(event.type)) {
        deskNs.to(DESK_QUEUE_ROOM).emit("desk_event", payload);
      }
    } catch {
      // Fan-out must not crash the API.
    }
  });

  let stopListen: (() => Promise<void>) | null = null;
  const listenUrl =
    process.env.DATABASE_LISTEN_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (listenUrl) {
    void startCaseEventListenBridge(listenUrl)
      .then((stop) => {
        stopListen = stop;
        console.log(
          JSON.stringify({
            msg: "case_event_listen_bridge",
            ok: true,
          }),
        );
      })
      .catch((error) => {
        console.warn(
          JSON.stringify({
            msg: "case_event_listen_bridge",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            hint: "Set DATABASE_LISTEN_URL to a session-mode Postgres URL, or CASE_EVENT_FANOUT_URL on the worker.",
          }),
        );
      });
  }

  return {
    io,
    stop: () => {
      unsubscribe();
      if (stopListen) void stopListen();
      void io.close();
    },
  };
}
