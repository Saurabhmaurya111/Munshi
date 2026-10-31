import { describe, expect, it } from "vitest";
import { evaluateRefundRisk } from "../src/agent/refund-risk.js";

describe("evaluateRefundRisk", () => {
  it("allows a clean delayed refund with no completed priors", () => {
    const result = evaluateRefundRisk({
      message: "Where is my IRCTC refund?",
      focusRefundId: "refund_5001",
      refunds: [
        {
          refundId: "refund_5001",
          status: "delayed",
          amountPaise: 200000,
          transactionId: "txn_upi_1001",
        },
      ],
    });

    expect(result.decision).toBe("allow");
    expect(result.level).toBe("low");
    expect(result.priorCompletedCount).toBe(0);
    expect(result.summary).toMatch(/Refund risk evaluated as LOW/i);
  });

  it("surfaces prior completed refunds on a routine status check", () => {
    const result = evaluateRefundRisk({
      message: "What is the status of refund_5001?",
      focusRefundId: "refund_5001",
      refunds: [
        {
          refundId: "refund_wal_6001",
          status: "completed",
          amountPaise: 15000,
          transactionId: "txn_wal_4002",
        },
        {
          refundId: "refund_5001",
          status: "delayed",
          amountPaise: 200000,
          transactionId: "txn_upi_1001",
        },
      ],
    });

    expect(result.decision).toBe("allow");
    expect(result.priorCompletedCount).toBe(1);
    expect(result.summary).toContain("refund_wal_6001");
    expect(result.summary).toMatch(/completed/i);
  });

  it("escalates when the customer asks for another refund after a completed one", () => {
    const result = evaluateRefundRisk({
      message: "Please issue another refund for this payment to my bank.",
      focusRefundId: "refund_5001",
      refunds: [
        {
          refundId: "refund_old_1",
          status: "completed",
          amountPaise: 200000,
          transactionId: "txn_upi_1001",
        },
        {
          refundId: "refund_5001",
          status: "delayed",
          amountPaise: 200000,
          transactionId: "txn_upi_1001",
        },
      ],
    });

    expect(result.decision).toBe("escalate");
    expect(result.level).toBe("high");
    expect(result.reasons[0]).toMatch(/completed refund/i);
  });

  it("escalates on high prior completed volume", () => {
    const result = evaluateRefundRisk({
      message: "Check my refund status",
      focusRefundId: "refund_new",
      refunds: [
        { refundId: "r1", status: "completed", amountPaise: 10000 },
        { refundId: "r2", status: "completed", amountPaise: 20000 },
        { refundId: "r3", status: "completed", amountPaise: 30000 },
        { refundId: "refund_new", status: "processing", amountPaise: 40000 },
      ],
    });

    expect(result.decision).toBe("escalate");
    expect(result.level).toBe("high");
    expect(result.priorCompletedCount).toBe(3);
    expect(result.priorCompletedAmountPaise).toBe(60000);
  });
});
