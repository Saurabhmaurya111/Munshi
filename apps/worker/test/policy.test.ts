import { describe, expect, it } from "vitest";
import { evaluateReplyPolicy, evaluateToolPolicy } from "../src/agent/policy.js";

describe("evaluateToolPolicy", () => {
  it("allows reads at every workflow level", () => {
    expect(evaluateToolPolicy("read", { workflowLevel: 0 }).decision).toBe("allow");
    expect(evaluateToolPolicy("read", { workflowLevel: 2 }).decision).toBe("allow");
  });

  it("holds writes below level 2", () => {
    expect(evaluateToolPolicy("write", { workflowLevel: 0 }).decision).toBe(
      "hold_for_approval",
    );
    expect(evaluateToolPolicy("write", { workflowLevel: 1 }).decision).toBe(
      "hold_for_approval",
    );
  });

  it("allows low-risk writes at level 2", () => {
    expect(evaluateToolPolicy("write", { workflowLevel: 2 }).decision).toBe("allow");
  });

  it("never allows money-adjacent actions automatically", () => {
    expect(
      evaluateToolPolicy("money", { workflowLevel: 2, amount: 100 }).decision,
    ).toBe("hold_for_approval");

    expect(
      evaluateToolPolicy("money", {
        workflowLevel: 2,
        amount: 50_000,
        amountApprovalThreshold: 5000,
      }).decision,
    ).toBe("hold_for_approval");
  });
});

describe("evaluateReplyPolicy", () => {
  it("holds the customer reply at level 0", () => {
    expect(evaluateReplyPolicy(0).decision).toBe("hold_for_approval");
  });

  it("allows the customer reply from level 1", () => {
    expect(evaluateReplyPolicy(1).decision).toBe("allow");
    expect(evaluateReplyPolicy(2).decision).toBe("allow");
  });
});
