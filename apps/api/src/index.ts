import type { Audience } from "@repo/core";

/**
 * HTTP and WebSocket gateway.
 * Auth, commands, realtime fan-out. See backend_infra_handoff.md.
 */
const audiences: Audience[] = ["customer", "desk", "internal"];

console.log(`munshi api scaffold ready (${audiences.join(", ")})`);
