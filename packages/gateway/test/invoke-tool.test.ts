import { afterAll, describe, expect, it } from "vitest";
import { createCase, createDb, type Db } from "@repo/core";
import { createInvokeTool } from "../src/index.js";
import type { ToolHandler } from "@repo/mock-world";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("createInvokeTool", () => {
  const db: Db = createDb(databaseUrl!);

  afterAll(async () => {
    await db.end();
  });

  it("returns seeded UPI status and is idempotent on the same stepId", async () => {
    const created = await createCase(db, { customerId: "customer-soham" });
    let handlerCalls = 0;

    const getTransactionStatus: ToolHandler = async ({ customerId, args }) => {
      handlerCalls += 1;
      // Delegate to real mock by using default handlers for first call path —
      // here we only count; use real gateway without override for data check.
      void customerId;
      void args;
      return {
        ok: true,
        data: { transactionId: "txn_upi_1001", status: "failed" },
      };
    };

    const invoke = createInvokeTool({
      db,
      handlers: { getTransactionStatus },
    });

    const input = {
      caseId: created.id,
      stepId: "task-1:0:getTransactionStatus",
      tool: "getTransactionStatus",
      args: { transactionId: "txn_upi_1001" },
      customerId: "customer-soham",
    };

    const first = await invoke.invoke(input);
    const second = await invoke.invoke(input);

    expect(first).toEqual({
      state: "confirmed",
      data: { transactionId: "txn_upi_1001", status: "failed" },
    });
    expect(second).toEqual(first);
    expect(handlerCalls).toBe(1);
  });

  it("does not return another customer's transaction", async () => {
    const created = await createCase(db, { customerId: "customer-aditya" });
    const invoke = createInvokeTool({ db });

    const result = await invoke.invoke({
      caseId: created.id,
      stepId: "task-scope:0:getTransactionStatus",
      tool: "getTransactionStatus",
      args: { transactionId: "txn_upi_1001" },
      customerId: "customer-aditya",
    });

    expect(result).toMatchObject({
      state: "failed",
      errorCode: "NOT_FOUND",
    });
  });

  it("persists unknown on timeout", async () => {
    const created = await createCase(db, { customerId: "customer-soham" });
    const hang: ToolHandler = ({ signal }) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });

    const invoke = createInvokeTool({
      db,
      timeoutMs: 20,
      handlers: { getTransactionStatus: hang },
    });

    const result = await invoke.invoke({
      caseId: created.id,
      stepId: "task-timeout:0:getTransactionStatus",
      tool: "getTransactionStatus",
      args: { transactionId: "txn_upi_1001" },
      customerId: "customer-soham",
    });

    expect(result).toMatchObject({ state: "unknown", reason: "timeout" });

    const intent = await db.query<{ state: string }>(
      `SELECT state FROM action_intents
       WHERE idempotency_key = $1`,
      [`${created.id}:task-timeout:0:getTransactionStatus`],
    );
    expect(intent.rows[0]?.state).toBe("unknown");
  });

  it("blocks write tools until B5", async () => {
    const created = await createCase(db, { customerId: "customer-soham" });
    const invoke = createInvokeTool({ db });

    const result = await invoke.invoke({
      caseId: created.id,
      stepId: "task-write:0:createComplaint",
      tool: "createComplaint",
      args: { category: "upi", summary: "test" },
      customerId: "customer-soham",
    });

    expect(result).toMatchObject({
      state: "failed",
      errorCode: "WRITE_NOT_ALLOWED",
    });
  });
});
