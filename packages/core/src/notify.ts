import { EventEmitter } from "node:events";
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

export async function notifyCaseEvent(
  client: DbClient,
  notice: CaseEventNotice,
): Promise<void> {
  bus.emit("case_event", notice);
  try {
    await client.query(`SELECT pg_notify('case_events', $1)`, [
      JSON.stringify(notice),
    ]);
  } catch {
    // Pooler / permission issues must not fail the durable write.
  }
}
