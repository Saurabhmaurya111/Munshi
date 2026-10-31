import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeskActor, DeskRole } from "./auth.js";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export type DeskCredentials = {
  id: string;
  password: string;
};

export function loadDeskCredentials(
  env: NodeJS.ProcessEnv = process.env,
): DeskCredentials {
  const id = env.DESK_ID?.trim() || "approver";
  const password = env.DESK_PASSWORD?.trim() || "munshi-desk";
  return { id, password };
}

function signingSecret(password: string): string {
  return `munshi-desk-session:${password}`;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintDeskToken(
  actor: DeskActor,
  password: string,
  now = Date.now(),
): string {
  const body = b64url(
    JSON.stringify({
      actorId: actor.actorId,
      role: actor.role,
      exp: now + TOKEN_TTL_MS,
    }),
  );
  const sig = sign(body, signingSecret(password));
  return `${body}.${sig}`;
}

export function verifyDeskToken(
  token: string,
  password: string,
  now = Date.now(),
): DeskActor | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = sign(body, signingSecret(password));
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      actorId?: unknown;
      role?: unknown;
      exp?: unknown;
    };
    if (
      typeof parsed.actorId !== "string" ||
      typeof parsed.role !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (parsed.exp < now) return null;
    if (
      parsed.role !== "agent" &&
      parsed.role !== "approver" &&
      parsed.role !== "admin"
    ) {
      return null;
    }
    return { actorId: parsed.actorId, role: parsed.role as DeskRole };
  } catch {
    return null;
  }
}

export function authenticateDeskLogin(
  id: string,
  password: string,
  expected: DeskCredentials,
): DeskActor | null {
  const idOk =
    id.length === expected.id.length &&
    timingSafeEqual(Buffer.from(id), Buffer.from(expected.id));
  const passOk =
    password.length === expected.password.length &&
    timingSafeEqual(Buffer.from(password), Buffer.from(expected.password));
  if (!idOk || !passOk) return null;
  return { actorId: expected.id, role: "approver" };
}
