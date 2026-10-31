import { describe, expect, it } from "vitest";
import {
  getTool,
  isToolAllowedForAgent,
  validateToolArgs,
} from "../src/agent/tools.js";

describe("tool registry", () => {
  it("does not expose a reversal or partner-refund tool", () => {
    expect(getTool("issueUpiReversal")).toBeUndefined();
    expect(getTool("refundUpiPayment")).toBeUndefined();
    expect(getTool("issuePartnerRefund")).toBeUndefined();
  });

  it("scopes tools to their agent", () => {
    expect(isToolAllowedForAgent("getTransactionStatus", "upi_agent")).toBe(true);
    expect(isToolAllowedForAgent("getTransactionStatus", "refund_agent")).toBe(false);
    expect(isToolAllowedForAgent("createComplaint", "complaint_agent")).toBe(true);
  });

  it("rejects unknown tools", () => {
    expect(validateToolArgs("dropTable", {}).ok).toBe(false);
  });

  it("rejects customerId smuggled into tool arguments", () => {
    const result = validateToolArgs("getAccountSupportStatus", {
      customerId: "customer-evil",
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a lookup with no filters", () => {
    expect(validateToolArgs("getTransactions", {}).ok).toBe(false);
    expect(validateToolArgs("getRefundStatus", {}).ok).toBe(false);
  });

  it("accepts valid arguments", () => {
    const result = validateToolArgs("getTransactionStatus", {
      transactionId: "TXN12345",
    });

    expect(result).toEqual({
      ok: true,
      data: { transactionId: "TXN12345" },
    });
  });
});
