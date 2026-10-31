import { afterAll, describe, expect, it } from "vitest";
import {
  appendCustomerMessage,
  appendHumanMessage,
  createCase,
  createDb,
  handBackCase,
  listCaseEvents,
  listDeskQueue,
  requestHumanTransfer,
  takeoverCase,
  type Db,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("desk transfer / takeover / hand-back", () => {
  const db: Db = createDb(databaseUrl ?? "postgres://localhost/munshi");

  afterAll(async () => {
    await db.end();
  });

  it(
    "transfers a case to a human on customer request and accepts desk replies",
    async () => {
      const created = await createCase(db, {
        customerId: "customer-soham",
        priority: 20,
      });

      await appendCustomerMessage(db, {
        caseId: created.id,
        customerId: "customer-soham",
        message: "I need a human please",
        commandId: `cust-${created.id}`,
      });

      const transferred = await requestHumanTransfer(db, {
        caseId: created.id,
        customerId: "customer-soham",
        commandId: `xfer-${created.id}`,
        reason: "customer_requested",
      });

      expect(transferred.created).toBe(true);
      expect(transferred.case.ownership).toBe("HUMAN_OWNED");
      expect(transferred.case.runnable).toBe(false);
      expect(transferred.ticket?.complaintId).toMatch(/^cmp_/);
      expect(transferred.ticket?.status).toBe("escalated");

      const ticketRow = await db.query<{ id: string; status: string }>(
        `SELECT id, status::text AS status FROM mock_complaints
         WHERE case_id = $1::uuid
         ORDER BY created_at DESC
         LIMIT 1`,
        [created.id],
      );
      expect(ticketRow.rows[0]?.id).toBe(transferred.ticket?.complaintId);
      expect(ticketRow.rows[0]?.status).toBe("escalated");

      const queue = await listDeskQueue(db, { limit: 100 });
      const queued = queue.find((item) => item.case.id === created.id);
      expect(queued).toBeTruthy();
      expect(queued?.ticketId).toBe(transferred.ticket?.complaintId);

      const taken = await takeoverCase(db, {
        caseId: created.id,
        agentId: "desk-priya",
        commandId: `take-${created.id}`,
      });
      expect(taken.case.ownership).toBe("HUMAN_OWNED");

      const replied = await appendHumanMessage(db, {
        caseId: created.id,
        agentId: "desk-priya",
        message: "Hi, I’m Priya from support. How can I help?",
        commandId: `msg-${created.id}`,
      });
      expect(replied.created).toBe(true);

      const customerEvents = await listCaseEvents(db, {
        caseId: created.id,
        audience: "customer",
      });
      expect(
        customerEvents.some(
          (event) =>
            event.type === "human_message" &&
            event.payload.text ===
              "Hi, I’m Priya from support. How can I help?",
        ),
      ).toBe(true);

      const handed = await handBackCase(db, {
        caseId: created.id,
        agentId: "desk-priya",
        commandId: `back-${created.id}`,
        note: "Customer issue clarified; Munshi can continue.",
      });
      expect(handed.case.ownership).toBe("AI_ACTIVE");
      expect(handed.case.runnable).toBe(true);
    },
    20_000,
  );
});
