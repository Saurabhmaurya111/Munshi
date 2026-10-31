import type { OwnershipState } from "@repo/core";
import type { IntentState } from "@repo/gateway";

/**
 * Case runner, timers, and reconciler.
 * Claims cases with SKIP LOCKED. See backend_infra_handoff.md.
 */
const idleOwnership: OwnershipState = "WAITING_EXTERNAL";
const pendingIntent: IntentState = "unknown";

console.log(
  `munshi worker scaffold ready (ownership=${idleOwnership}, intent=${pendingIntent})`,
);
