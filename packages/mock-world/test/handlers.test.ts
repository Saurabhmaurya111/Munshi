import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createMockWorldHandlers } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("mock-world read handlers", () => {
  const pool = new pg.Pool({
    connectionString: databaseUrl!,
    ssl: databaseUrl?.includes("localhost")
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

  it("creates and escalates a complaint ticket", async () => {
    const created = await handlers.createComplaint!({
      customerId: "customer-soham",
      args: {
        category: "upi",
        summary: "Handoff ticket from mock-world test",
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const complaintId = (created.data as { complaintId: string }).complaintId;
    expect(complaintId).toMatch(/^cmp_/);

    const escalated = await handlers.escalateComplaint!({
      customerId: "customer-soham",
      args: {
        complaintId,
        reason: "Needs human review",
      },
    });
    expect(escalated.ok).toBe(true);
    if (!escalated.ok) return;
    expect(escalated.data).toMatchObject({
      complaintId,
      status: "escalated",
    });
  });

  it("returns wallet balance, payments, and wallet-bound refunds", async () => {
    const balance = await handlers.getWalletBalance!({
      customerId: "customer-soham",
      args: {},
    });
    expect(balance.ok).toBe(true);
    if (balance.ok) {
      expect(balance.data).toMatchObject({
        customerId: "customer-soham",
        status: "active",
      });
    }

    const payment = await handlers.getWalletPaymentStatus!({
      customerId: "customer-soham",
      args: { transactionId: "txn_wal_4001" },
    });
    expect(payment.ok).toBe(true);

    const walletRefund = await handlers.getWalletRefundDetails!({
      customerId: "customer-soham",
      args: { refundId: "refund_wal_6001" },
    });
    expect(walletRefund.ok).toBe(true);
    if (walletRefund.ok) {
      expect(walletRefund.data).toMatchObject({
        destination: "wallet",
        status: "completed",
      });
    }

    const ledger = await handlers.getWalletLedger!({
      customerId: "customer-soham",
      args: { limit: 10 },
    });
    expect(ledger.ok).toBe(true);
  });
});
