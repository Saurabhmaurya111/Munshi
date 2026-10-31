/** Case log, leases, epochs, and ownership state. See backend_infra_handoff.md. */

export type OwnershipState =
  | "AI_ACTIVE"
  | "WAITING_EXTERNAL"
  | "PENDING_APPROVAL"
  | "HUMAN_OWNED"
  | "CLOSED";

export type Audience = "customer" | "desk" | "internal";

export type MockCustomer = {
  id: string;
  displayName: string;
  phoneMasked: string;
  accountType: string;
  kycStatus: string;
  supportFlags: Record<string, unknown>;
};

export type CaseRow = {
  id: string;
  status: string;
  ownership: OwnershipState;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  epoch: string;
  wakeAt: Date | null;
  priority: number;
  customerId: string;
  lastEventSeq: string;
  runnable: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CaseEventRow = {
  id: string;
  caseId: string;
  seq: string;
  type: string;
  audience: Audience;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export class CoreError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST" | "CONFLICT",
  ) {
    super(message);
    this.name = "CoreError";
  }
}
