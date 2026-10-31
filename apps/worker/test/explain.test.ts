import { describe, expect, it } from "vitest";
import { formatRupees, interpretObservation } from "../src/agent/explain.js";

const now = Date.parse("2026-10-30T10:00:00Z");

function txn(overrides: Record<string, unknown>) {
  return {
    transactionId: "txn_1",
    amountPaise: 200000,
    status: "failed",
    counterpartyName: "IRCTC",
    occurredAt: new Date(now).toISOString(),
    ...overrides,
  };
}

describe("formatRupees", () => {
  it("formats paise as Indian rupees", () => {
    expect(formatRupees(200000)).toBe("₹2,000");
    expect(formatRupees(12345650)).toBe("₹1,23,456.50");
  });
});

describe("interpretObservation", () => {
  it("explains a single failed payment without promising a reversal", () => {
    const result = interpretObservation(
      "getTransactions",
      { transactions: [txn({ failureCode: "UPI_TIMEOUT" })] },
      "my payment failed",
    );

    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") return;
    expect(result.text).toContain("₹2,000 to IRCTC");
    expect(result.text).toContain("failed (reason code UPI_TIMEOUT)");
    expect(result.text).not.toMatch(/will be (refunded|reversed)/i);
    expect(result.references).toEqual(["txn_1"]);
  });

  it("narrows several matches to the status the customer described", () => {
    const result = interpretObservation(
      "getTransactions",
      {
        transactions: [
          txn({ transactionId: "txn_ok", status: "success" }),
          txn({ transactionId: "txn_pending", status: "pending" }),
        ],
      },
      "my payment is stuck",
    );

    expect(result.kind).toBe("verified");
    if (result.kind === "verified") {
      expect(result.references).toEqual(["txn_pending"]);
      expect(result.text).toContain("still pending");
    }
  });

  it("asks which record when several still match", () => {
    const result = interpretObservation(
      "getTransactions",
      {
        transactions: [
          txn({ transactionId: "txn_a", status: "success" }),
          txn({ transactionId: "txn_b", status: "success" }),
        ],
      },
      "question about a payment",
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.text).toContain("txn_a");
      expect(result.text).toContain("txn_b");
      expect(result.text).toContain("Which one");
    }
  });

  it("recognises a duplicate pair when the customer reports being charged twice", () => {
    const result = interpretObservation(
      "getTransactions",
      {
        transactions: [
          txn({ transactionId: "dup_1", status: "success", amountPaise: 10000 }),
          txn({
            transactionId: "dup_2",
            status: "success",
            amountPaise: 10000,
            occurredAt: new Date(now + 120_000).toISOString(),
          }),
        ],
      },
      "I was charged twice",
    );

    expect(result.kind).toBe("verified");
    if (result.kind === "verified") {
      expect(result.text).toContain("duplicates");
      expect(result.references).toEqual(["dup_1", "dup_2"]);
    }
  });

  it("reports an empty lookup as empty, never as a status", () => {
    expect(interpretObservation("getTransactions", { transactions: [] }, "x").kind).toBe("empty");
    expect(interpretObservation("getRefundStatus", { refunds: [] }, "x").kind).toBe("empty");
  });

  it("explains a delayed refund with its expected date", () => {
    const result = interpretObservation(
      "getRefundStatus",
      {
        refunds: [
          {
            refundId: "refund_1",
            amountPaise: 50000,
            status: "delayed",
            reason: "Bank reversal not confirmed",
            expectedBy: "2026-11-02",
          },
        ],
      },
      "refund not received",
    );

    expect(result.kind).toBe("verified");
    if (result.kind === "verified") {
      expect(result.text).toContain("₹500");
      expect(result.text).toContain("delayed");
      expect(result.text).toContain("2 Nov");
    }
  });

  it("explains a recharge whose plan has not activated", () => {
    const result = interpretObservation(
      "getRechargeStatus",
      {
        recharges: [
          {
            rechargeId: "rech_1",
            amountPaise: 99900,
            operator: "jio",
            mobileMasked: "97****1100",
            status: "benefit_pending",
          },
        ],
      },
      "recharge done but plan not active",
    );

    expect(result.kind).toBe("verified");
    if (result.kind === "verified") {
      expect(result.text).toContain("Jio");
      expect(result.text).toContain("hasn't activated");
    }
  });

  it("gives KYC and OTP guidance from account facts without asking for secrets", () => {
    const result = interpretObservation(
      "getAccountSupportStatus",
      { kycStatus: "pending", supportFlags: { login_issues: true } },
      "OTP not coming and cannot login",
    );

    expect(result.kind).toBe("verified");
    if (result.kind === "verified") {
      expect(result.text).toContain("KYC is still pending");
      expect(result.text).toContain("known login issue");
      expect(result.text).toContain("Never share an OTP");
    }
  });

  it("only claims a complaint was raised when the backend returned its id", () => {
    expect(interpretObservation("createComplaint", { status: "created" }, "x").kind).toBe("empty");

    const created = interpretObservation("createComplaint", { complaintId: "cmp_1" }, "x");
    expect(created.kind).toBe("verified");
  });
});
