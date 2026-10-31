import { EventEmitter } from "node:events";
import pg from "pg";
import type { DbClient } from "./db.js";

export type CaseEventNotice = {
  caseId: string;
  seq: number;
};

const bus = new EventEmitter();
bus.setMaxListeners(50);

/** In-process fan-out for a single API process (B7). */
export function onCaseEvent(listener: (notice: CaseEventNotice) => void): () => void {
  bus.on("case_event", listener);
  return () => {
    bus.off("case_event", listener);
  };
}

/** Re-emit a notice onto the in-process bus (HTTP/LISTEN bridges). */
export function emitCaseEventNotice(notice: CaseEventNotice): void {
  if (!notice.caseId || !Number.isFinite(notice.seq)) return;
  bus.emit("case_event", notice);
}

async function fanoutHttp(notice: CaseEventNotice): Promise<void> {
  const url = process.env.CASE_EVENT_FANOUT_URL?.trim();
  if (!url) return;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const secret = process.env.CASE_EVENT_FANOUT_SECRET?.trim();
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
  }

  try {
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(notice),
    });
  } catch {
    // Fan-out must not fail the durable write.
  }
}

export async function notifyCaseEvent(
  client: DbClient,
  notice: CaseEventNotice,
): Promise<void> {
  emitCaseEventNotice(notice);
  try {
    await client.query(`SELECT pg_notify('case_events', $1)`, [
      JSON.stringify(notice),
    ]);
  } catch {
    // Pooler / permission issues must not fail the durable write.
  }
  // Worker → API bridge when LISTEN is unavailable (transaction poolers).
  void fanoutHttp(notice);
}

/**
 * Dedicated session-mode connection that re-emits Postgres NOTIFY onto the bus.
 * Transaction-mode poolers (Supabase :6543) cannot LISTEN — use
 * DATABASE_LISTEN_URL (session/direct) or CASE_EVENT_FANOUT_URL instead.
 */
export async function startCaseEventListenBridge(
  databaseUrl: string,
): Promise<() => Promise<void>> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost")
      ? undefined
      : { rejectUnauthorized: false },
  });

  await client.connect();
  await client.query("LISTEN case_events");

  const onNotification = (message: pg.Notification) => {
    if (message.channel !== "case_events" || !message.payload) return;
    try {
      const parsed = JSON.parse(message.payload) as CaseEventNotice;
      emitCaseEventNotice(parsed);
    } catch {
      // Ignore malformed payloads.
    }
  };

  client.on("notification", onNotification);

  return async () => {
    client.off("notification", onNotification);
    try {
      await client.query("UNLISTEN case_events");
    } catch {
      // closing anyway
    }
    await client.end().catch(() => undefined);
  };
}
