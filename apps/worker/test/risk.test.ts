import { describe, expect, it } from "vitest";
import { detectRiskSignals, redactSecrets } from "../src/agent/risk.js";

describe("detectRiskSignals", () => {
  it.each([
    "Someone hacked my account",
    "There is a transaction I didn't make",
    "I think this is fraud",
    "unauthorised UPI debit on my account",
    "yeh payment maine nahi kiya",
  ])("flags possible fraud: %s", (message) => {
    expect(detectRiskSignals(message).fraudSuspected).toBe(true);
  });

  it("does not flag a routine payment issue", () => {
    expect(detectRiskSignals("My UPI payment failed yesterday")).toEqual({
      fraudSuspected: false,
      sharedSecret: false,
    });
  });

  it.each(["my otp is 482913", "UPI PIN: 1234", "password = hunter22", "card 4111 1111 1111 1111"])(
    "flags a shared secret: %s",
    (message) => {
      expect(detectRiskSignals(message).sharedSecret).toBe(true);
    },
  );

  it.each(["OTP not received", "I changed my password yesterday", "forgot my UPI PIN"])(
    "does not flag a secret that was only mentioned: %s",
    (message) => {
      expect(detectRiskSignals(message).sharedSecret).toBe(false);
    },
  );
});

describe("redactSecrets", () => {
  it("removes OTPs, PINs, and card numbers but keeps the rest", () => {
    const redacted = redactSecrets(
      "OTP is 482913 and pin 1234, card 4111 1111 1111 1111, payment txn_upi_1001",
    );

    expect(redacted).not.toMatch(/482913|1234|4111/);
    expect(redacted).toContain("txn_upi_1001");
    expect(redacted).toContain("[redacted]");
  });

  it("keeps a 10-digit mobile number used for recharge lookups", () => {
    expect(redactSecrets("recharge for 9876543210 failed")).toContain("9876543210");
  });
});
