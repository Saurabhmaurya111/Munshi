/** Case log, leases, epochs, and ownership state. See backend_infra_handoff.md. */

export type OwnershipState =
  | "AI_ACTIVE"
  | "WAITING_EXTERNAL"
  | "PENDING_APPROVAL"
  | "HUMAN_OWNED"
  | "CLOSED";

export type Audience = "customer" | "desk" | "internal";
