/**
 * Base URL for the Munshi API.
 *
 * - Server (RSC / Route Handlers): prefer Vercel service binding `API_URL`
 *   (injected at runtime; do not set it yourself on Vercel).
 * - Explicit `NEXT_PUBLIC_API_URL` for local split-port or external API.
 * - Browser with no explicit URL: same-origin empty string so `/v1/*` and
 *   `/socket.io/*` hit top-level Vercel rewrites to the `api` service.
 */
export function apiBase(): string {
  if (typeof window === "undefined") {
    const bound = process.env.API_URL?.replace(/\/$/, "");
    if (bound) return bound;
  }

  const explicit = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
  if (explicit) return explicit;

  if (typeof window !== "undefined") {
    return "";
  }

  return "http://127.0.0.1:3001";
}
