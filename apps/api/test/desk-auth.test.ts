import { describe, expect, it } from "vitest";
import {
  authenticateDeskLogin,
  mintDeskToken,
  verifyDeskToken,
} from "../src/desk-auth.js";

describe("desk-auth", () => {
  const creds = { id: "approver", password: "munshi-desk" };

  it("accepts matching credentials", () => {
    expect(authenticateDeskLogin("approver", "munshi-desk", creds)).toEqual({
      actorId: "approver",
      role: "approver",
    });
  });

  it("rejects bad password", () => {
    expect(authenticateDeskLogin("approver", "nope", creds)).toBeNull();
  });

  it("round-trips a session token", () => {
    const actor = { actorId: "approver", role: "approver" as const };
    const token = mintDeskToken(actor, creds.password);
    expect(verifyDeskToken(token, creds.password)).toEqual(actor);
  });

  it("rejects a tampered token", () => {
    const token = mintDeskToken(
      { actorId: "approver", role: "approver" },
      creds.password,
    );
    expect(verifyDeskToken(`${token}x`, creds.password)).toBeNull();
  });
});
