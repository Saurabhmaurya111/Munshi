import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createMockWorldHandlers } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("mock-world read handlers", () => {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl!.includes("localhost")
      ? undefined
      : { rejectUnauthorized: false },
  });
  const handlers = createMockWorldHandlers(pool);

  afterAll(async () => {
    await pool.end();
  });

  it("returns the seeded failed IRCTC UPI txn for customer-soham", async () => {
    const result = await handlers.getTransactionStatus!({
      customerId: "customer-soham",
      args: { transactionId: "txn_upi_1001" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        transactionId: "txn_upi_1001",
        status: "failed",
        failureCode: "UPI_TIMEOUT",
      });
    }
  });

  it("scopes lookups by customerId", async () => {
    const result = await handlers.getTransactionStatus!({
      customerId: "customer-aditya",
      args: { transactionId: "txn_upi_1001" },
    });
    expect(result).toMatchObject({ ok: false, errorCode: "NOT_FOUND" });
  });

  it("returns refund and recharge seed rows", async () => {
    const refund = await handlers.getRefundDetails!({
      customerId: "customer-soham",
      args: { refundId: "refund_5001" },
    });
    expect(refund.ok).toBe(true);

    const recharge = await handlers.getRechargeStatus!({
      customerId: "customer-soham",
      args: { amount: 299 },
    });
    expect(recharge.ok).toBe(true);
  });
});
