/**
 * Refund risk from prior refund history (authoritative mock / tool rows only).
 * Used so Desk and offline evals can see *what* was taken before and *how*
 * that history was scored — never invents a new refund outcome.
 */

export type RefundHistoryRow = {
  refundId?: string;
  id?: string;
  status?: string;
  amountPaise?: number;
  transactionId?: string;
  reason?: string;
};

export type RefundRiskLevel = "low" | "medium" | "high";

export type RefundRiskDecision = "allow" | "escalate";

export type RefundRiskEvaluation = {
  level: RefundRiskLevel;
  decision: RefundRiskDecision;
  reasons: string[];
  /** Short explanation of how prior refunds were scored (customer + desk). */
  summary: string;
  priorCount: number;
  priorCompletedCount: number;
  priorOpenCount: number;
  priorFailedCount: number;
  priorCompletedAmountPaise: number;
  focusStatus?: string;
};

const REPEAT_CLAIM =
  /\b(?:another|one more|new)\s+refund\b|\b(?:issue|give|send|process|do)\s+(?:me\s+)?(?:a\s+)?refund\b|\brefund\s+(?:again|once more|to my bank)\b/i;

const OPEN_STATUSES = new Set([
  "initiated",
  "processing",
  "delayed",
  "pending",
]);

function rowId(row: RefundHistoryRow): string | undefined {
  const value = row.refundId ?? row.id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatRupees(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function describePriors(rows: RefundHistoryRow[]): string {
  if (rows.length === 0) {
    return "No prior refunds were found in the recent window.";
  }

  const parts = rows.slice(0, 5).map((row) => {
    const id = rowId(row) ?? "unknown";
    const status = row.status ?? "unknown";
    const amount =
      typeof row.amountPaise === "number"
        ? formatRupees(row.amountPaise)
        : null;
    return amount ? `${id} (${status}, ${amount})` : `${id} (${status})`;
  });

  const more =
    rows.length > 5 ? ` and ${rows.length - 5} more` : "";
  return `Prior refunds on file: ${parts.join("; ")}${more}.`;
}

/**
 * Score prior refunds for this customer before treating the current ask as routine.
 */
export function evaluateRefundRisk(input: {
  message: string;
  refunds: RefundHistoryRow[];
  focusRefundId?: string;
}): RefundRiskEvaluation {
  const byId = new Map<string, RefundHistoryRow>();

  for (const row of input.refunds) {
    const id = rowId(row) ?? `anon-${byId.size}`;
    byId.set(id, { ...row, refundId: rowId(row) ?? id });
  }

  const all = [...byId.values()];
  const focusId = input.focusRefundId?.trim();
  const focus = focusId
    ? all.find((row) => rowId(row) === focusId)
    : undefined;
  const priors = focusId
    ? all.filter((row) => rowId(row) !== focusId)
    : all;

  let priorCompletedCount = 0;
  let priorOpenCount = 0;
  let priorFailedCount = 0;
  let priorCompletedAmountPaise = 0;

  for (const row of priors) {
    const status = (row.status ?? "").toLowerCase();
    if (status === "completed") {
      priorCompletedCount += 1;
      if (typeof row.amountPaise === "number") {
        priorCompletedAmountPaise += row.amountPaise;
      }
    } else if (status === "failed") {
      priorFailedCount += 1;
    } else if (OPEN_STATUSES.has(status)) {
      priorOpenCount += 1;
    }
  }

  const reasons: string[] = [];
  let level: RefundRiskLevel = "low";
  let decision: RefundRiskDecision = "allow";

  const wantsNewRefund = REPEAT_CLAIM.test(input.message);
  const focusTxn =
    typeof focus?.transactionId === "string" ? focus.transactionId : undefined;
  const completedSameTxn = priors.some(
    (row) =>
      (row.status ?? "").toLowerCase() === "completed" &&
      focusTxn &&
      row.transactionId === focusTxn,
  );
  const anyCompleted = priorCompletedCount > 0;

  if (wantsNewRefund && (completedSameTxn || anyCompleted)) {
    level = "high";
    decision = "escalate";
    reasons.push(
      completedSameTxn
        ? "Customer asked for another refund on a payment that already has a completed refund."
        : "Customer asked to issue a new refund while prior completed refunds already exist.",
    );
  }

  if (priorCompletedCount >= 3) {
    level = "high";
    decision = "escalate";
    reasons.push(
      `High prior completed-refund volume (${priorCompletedCount}) in the recent window.`,
    );
  } else if (priorCompletedCount === 2 && level === "low") {
    level = "medium";
    reasons.push("Two prior completed refunds in the recent window — elevated monitoring.");
  }

  if (priorFailedCount >= 2 && decision === "allow") {
    level = level === "low" ? "medium" : level;
    reasons.push(
      `Multiple failed refunds (${priorFailedCount}) — desk should review before promising an outcome.`,
    );
  }

  if (priorOpenCount >= 2 && wantsNewRefund && decision === "allow") {
    level = "medium";
    decision = "escalate";
    reasons.push(
      "Multiple open refunds already in flight while customer requested another refund.",
    );
  }

  if (reasons.length === 0) {
    reasons.push(
      priors.length === 0
        ? "No prior refund history in the lookup window."
        : "Prior refund history is within normal limits for a status check.",
    );
  }

  const historyLine = describePriors(priors.length > 0 ? priors : all);
  const scoreLine =
    decision === "escalate"
      ? `Refund risk evaluated as ${level.toUpperCase()} — holding for desk review. ${reasons[0]}`
      : `Refund risk evaluated as ${level.toUpperCase()}. ${reasons[0]}`;

  const summary = `${historyLine} ${scoreLine}`.trim();

  return {
    level,
    decision,
    reasons,
    summary,
    priorCount: priors.length,
    priorCompletedCount,
    priorOpenCount,
    priorFailedCount,
    priorCompletedAmountPaise,
    focusStatus:
      typeof focus?.status === "string" ? focus.status : undefined,
  };
}
