import { randomBytes } from "node:crypto";
import type { Db, DbClient } from "./db.js";
import { CoreError } from "./types.js";

type Queryable = Db | DbClient;

export type HandoffTicketCategory =
  | "upi"
  | "refund"
  | "recharge"
  | "account"
  | "complaint";

export type HandoffTicket = {
  complaintId: string;
  customerId: string;
  caseId: string;
  category: HandoffTicketCategory;
  status: string;
  summary: string;
  created: boolean;
  escalated: boolean;
};

type ComplaintDbRow = {
  id: string;
  customer_id: string;
  case_id: string | null;
  category: string;
  status: string;
  summary: string;
  details: unknown;
  escalated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function newComplaintId(): string {
  return `cmp_${randomBytes(4).toString("hex")}`;
}

export function inferHandoffCategory(
  text: string,
): HandoffTicketCategory {
  const lower = text.toLowerCase();
  if (/\bupi\b|\bpayment\b|\brrn\b|\bbank\b/.test(lower)) return "upi";
  if (/\brefund\b|\breversal\b|\birctc\b/.test(lower)) return "refund";
  if (/\brecharge\b|\bprepaid\b|\boperator\b/.test(lower)) return "recharge";
  if (/\bkyc\b|\blogin\b|\baccount\b|\botp\b/.test(lower)) return "account";
  return "complaint";
}

const CATEGORIES = new Set<HandoffTicketCategory>([
  "upi",
  "refund",
  "recharge",
  "account",
  "complaint",
]);

function mapTicket(
  row: ComplaintDbRow,
  flags: { created: boolean; escalated: boolean },
): HandoffTicket {
  const category = CATEGORIES.has(row.category as HandoffTicketCategory)
    ? (row.category as HandoffTicketCategory)
    : inferHandoffCategory(`${row.category} ${row.summary}`);

  return {
    complaintId: row.id,
    customerId: row.customer_id,
    caseId: row.case_id ?? "",
    category,
    status: row.status,
    summary: row.summary,
    created: flags.created,
    escalated: flags.escalated,
  };
}

/**
 * Raise or escalate a mock complaint ticket for human handoff.
 * Prefer an open ticket already linked to the case; otherwise create one
 * already marked escalated so Desk has a durable ticket id.
 */
export async function raiseHandoffTicket(
  client: Queryable,
  input: {
    caseId: string;
    customerId: string;
    summary: string;
    reason: string;
    category?: HandoffTicketCategory;
    source?: string;
  },
): Promise<HandoffTicket> {
  const summary = input.summary.trim().slice(0, 500);
  const reason = input.reason.trim().slice(0, 500);
  if (!summary) {
    throw new CoreError("ticket summary is required", "BAD_REQUEST");
  }

  const category = input.category ?? inferHandoffCategory(`${summary} ${reason}`);
  const detailNote = {
    at: new Date().toISOString(),
    note: reason || summary,
    source: input.source ?? "human_handoff",
  };

  const existing = await client.query<ComplaintDbRow>(
    `SELECT *
     FROM mock_complaints
     WHERE customer_id = $1
       AND (
         case_id = $2::uuid
         OR (
           case_id IS NULL
           AND status IN ('open', 'in_progress', 'waiting_customer', 'escalated')
         )
       )
     ORDER BY
       CASE WHEN case_id = $2::uuid THEN 0 ELSE 1 END,
       created_at DESC
     LIMIT 1`,
    [input.customerId, input.caseId],
  );

  const row = existing.rows[0];
  if (row) {
    const alreadyEscalated =
      row.status === "escalated" || row.escalated_at !== null;

    const updated = await client.query<ComplaintDbRow>(
      `UPDATE mock_complaints
       SET case_id = $2::uuid,
           status = 'escalated'::mock_complaint_status,
           escalated_at = COALESCE(escalated_at, now()),
           details = COALESCE(details, '[]'::jsonb) || $3::jsonb,
           updated_at = now()
       WHERE id = $1 AND customer_id = $4
       RETURNING *`,
      [
        row.id,
        input.caseId,
        JSON.stringify([detailNote]),
        input.customerId,
      ],
    );
    const next = updated.rows[0];
    if (!next) {
      throw new CoreError("Failed to escalate complaint ticket", "CONFLICT");
    }
    return mapTicket(next, {
      created: false,
      escalated: !alreadyEscalated,
    });
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const complaintId = newComplaintId();
    try {
      const inserted = await client.query<ComplaintDbRow>(
        `INSERT INTO mock_complaints (
           id, customer_id, case_id, category, status, summary, details, escalated_at
         ) VALUES (
           $1, $2, $3::uuid, $4, 'escalated'::mock_complaint_status, $5,
           $6::jsonb, now()
         )
         RETURNING *`,
        [
          complaintId,
          input.customerId,
          input.caseId,
          category,
          summary,
          JSON.stringify([detailNote]),
        ],
      );
      const created = inserted.rows[0];
      if (!created) {
        throw new CoreError("Failed to create complaint ticket", "CONFLICT");
      }
      return mapTicket(created, { created: true, escalated: true });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
      if (code === "23505") {
        continue;
      }
      throw error;
    }
  }

  throw new CoreError("Failed to allocate complaint ticket id", "CONFLICT");
}

export async function getCaseTicket(
  client: Queryable,
  input: { caseId: string; customerId?: string },
): Promise<HandoffTicket | null> {
  const result = await client.query<ComplaintDbRow>(
    `SELECT *
     FROM mock_complaints
     WHERE case_id = $1::uuid
       AND ($2::text IS NULL OR customer_id = $2)
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.caseId, input.customerId ?? null],
  );
  const row = result.rows[0];
  if (!row) return null;
  return mapTicket(row, {
    created: false,
    escalated: row.status === "escalated" || row.escalated_at !== null,
  });
}
