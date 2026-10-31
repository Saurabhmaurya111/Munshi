/**
 * Turns authoritative tool data into customer-facing text. Every sentence is
 * built from fields the backend returned; nothing here infers an outcome.
 */
export type Interpretation =
  | { kind: "verified"; text: string; references: string[] }
  | { kind: "ambiguous"; text: string; references: string[] }
  | { kind: "empty" };

type Row = Record<string, unknown>;

const MAX_LISTED = 5;
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

function asRow(value: unknown): Row | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function rows(value: unknown, key: string): Row[] | undefined {
  const list = asRow(value)?.[key];
  if (!Array.isArray(list)) {
    return undefined;
  }

  return list.flatMap((item: unknown) => {
    const row = asRow(item);
    return row ? [row] : [];
  });
}

function text(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function count(row: Row, key: string): number | undefined {
  const value = row[key];
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function time(row: Row, key: string): number | undefined {
  const value = row[key];

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}

function amountOf(row: Row): string | undefined {
  const paise = count(row, "amountPaise");
  return paise !== undefined ? formatRupees(paise) : undefined;
}

function dateOf(row: Row, key: string): string | undefined {
  const at = time(row, key);
  return at !== undefined ? formatDate(at) : undefined;
}

function idOf(row: Row): string | undefined {
  return (
    text(row, "transactionId") ??
    text(row, "refundId") ??
    text(row, "rechargeId") ??
    text(row, "complaintId")
  );
}

function wantsStatus(message: string): string[] {
  const lower = message.toLowerCase();
  const statuses: string[] = [];

  if (/\b(fail(?:ed|ing)?|declined|unsuccessful|nahi hua)\b/.test(lower)) {
    statuses.push("failed");
  }

  if (/\b(pending|stuck|processing|on hold|atka)\b/.test(lower)) {
    statuses.push("pending");
  }

  if (/\b(debited|deducted|kat gaye|cut)\b/.test(lower)) {
    statuses.push("pending", "success");
  }

  return statuses;
}

function mentionsDuplicate(message: string): boolean {
  return /\b(duplicate|twice|double|two times|charged 2|do baar)\b/i.test(message);
}

function narrow(list: Row[], message: string): Row[] {
  const statuses = wantsStatus(message);

  if (statuses.length === 0) {
    return list;
  }

  const matching = list.filter((row) => {
    const status = text(row, "status");
    return status !== undefined && statuses.includes(status);
  });

  return matching.length > 0 ? matching : list;
}

function references(list: Row[], key?: string): string[] {
  return list.flatMap((row) => (key ? text(row, key) : idOf(row)) ?? []);
}

function ambiguous(
  list: Row[],
  noun: string,
  describe: (row: Row) => string,
  key?: string,
): Interpretation {
  const shown = list.slice(0, MAX_LISTED);
  const lines = shown.map((row) => `- ${describe(row)}`);
  const more = list.length > shown.length ? `\n(and ${list.length - shown.length} more)` : "";

  return {
    kind: "ambiguous",
    text: `I found ${list.length} ${noun} that could match:\n${lines.join("\n")}${more}\nWhich one is it? Reply with its reference.`,
    references: references(shown, key),
  };
}

function describeTransaction(row: Row): string {
  const parts = [
    amountOf(row) ?? "a payment",
    text(row, "counterpartyName") ? `to ${text(row, "counterpartyName")}` : undefined,
    dateOf(row, "occurredAt") ? `on ${dateOf(row, "occurredAt")}` : undefined,
    text(row, "status") ? `(${text(row, "status")})` : undefined,
    idOf(row) ? `ref ${idOf(row)}` : undefined,
  ];
  return parts.filter(Boolean).join(" ");
}

function transactionSentence(row: Row): string {
  const subject = ["Your UPI payment", amountOf(row) ? `of ${amountOf(row)}` : undefined]
    .concat(text(row, "counterpartyName") ? [`to ${text(row, "counterpartyName")}`] : [])
    .concat(dateOf(row, "occurredAt") ? [`on ${dateOf(row, "occurredAt")}`] : [])
    .concat(idOf(row) ? [`(${idOf(row)})`] : [])
    .filter(Boolean)
    .join(" ");
  const status = text(row, "status");
  const rrn = text(row, "upiRrn");

  switch (status) {
    case "success":
      return `${subject} was successful according to our payment records.${
        rrn ? ` Its UPI reference (RRN) is ${rrn}; the receiver's bank can use it to trace the credit.` : ""
      }`;
    case "failed": {
      const code = text(row, "failureCode");
      return `${subject} failed${code ? ` (reason code ${code})` : ""}. I can't confirm a reversal yet. If money left your account, I can raise a complaint so it gets investigated.`;
    }
    case "pending":
      return `${subject} is still pending with the bank and has no final result yet. Please avoid paying again until it settles.`;
    case undefined:
      return `${subject} was found, but our records don't show a final status yet.`;
    default:
      return `${subject} shows the status "${status}" in our payment records.`;
  }
}

function duplicatePair(list: Row[]): Row[] | undefined {
  const successes = list
    .filter((row) => text(row, "status") === "success")
    .sort((left, right) => (time(left, "occurredAt") ?? 0) - (time(right, "occurredAt") ?? 0));

  for (let index = 1; index < successes.length; index += 1) {
    const previous = successes[index - 1];
    const current = successes[index];

    if (!previous || !current) continue;

    const sameAmount = count(previous, "amountPaise") === count(current, "amountPaise");
    const sameReceiver = text(previous, "counterpartyName") === text(current, "counterpartyName");
    const gap = (time(current, "occurredAt") ?? 0) - (time(previous, "occurredAt") ?? 0);

    if (sameAmount && sameReceiver && gap <= DUPLICATE_WINDOW_MS) {
      return [previous, current];
    }
  }

  return undefined;
}

function interpretTransactions(list: Row[], message: string): Interpretation {
  if (list.length === 0) {
    return { kind: "empty" };
  }

  if (mentionsDuplicate(message)) {
    const pair = duplicatePair(list);

    if (pair) {
      return {
        kind: "verified",
        text: `I see two successful payments that look like duplicates:\n${pair
          .map((row) => `- ${describeTransaction(row)}`)
          .join("\n")}\nBoth went through according to our records. A reversal isn't automatic; I can raise a complaint so the duplicate is investigated.`,
        references: references(pair),
      };
    }
  }

  const narrowed = narrow(list, message);

  if (narrowed.length === 1 && narrowed[0]) {
    return {
      kind: "verified",
      text: transactionSentence(narrowed[0]),
      references: references(narrowed),
    };
  }

  return ambiguous(narrowed, "payments", describeTransaction);
}

function describeRefund(row: Row): string {
  const parts = [
    amountOf(row) ? `refund of ${amountOf(row)}` : "refund",
    text(row, "transactionId") ? `for payment ${text(row, "transactionId")}` : undefined,
    text(row, "status") ? `(${text(row, "status")})` : undefined,
    text(row, "refundId") ? `ref ${text(row, "refundId")}` : undefined,
  ];
  return parts.filter(Boolean).join(" ");
}

function refundSentence(row: Row): string {
  const subject = [
    "Your refund",
    amountOf(row) ? `of ${amountOf(row)}` : undefined,
    text(row, "refundId") ? `(${text(row, "refundId")})` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const expected = dateOf(row, "expectedBy");
  const expectedText = expected ? ` The expected date is ${expected}.` : "";
  const reason = text(row, "reason");

  switch (text(row, "status")) {
    case "initiated":
      return `${subject} has been initiated but hasn't completed yet.${expectedText}`;
    case "processing":
      return `${subject} is being processed and hasn't been credited yet.${expectedText}`;
    case "completed":
      return `${subject} is marked completed by the refund system. If it isn't in your account, tell me and I'll raise an investigation.`;
    case "failed":
      return `${subject} failed${reason ? ` (${reason})` : ""}. It needs investigation; I can raise a complaint for it.`;
    case "delayed":
      return `${subject} is delayed${reason ? `: ${reason}` : ""}.${expectedText} If it isn't credited by then, I can raise a complaint.`;
    case undefined:
      return `${subject} was found, but the refund system doesn't show a status yet.`;
    default:
      return `${subject} shows the status "${text(row, "status")}" in the refund system.`;
  }
}

function interpretRefunds(list: Row[]): Interpretation {
  if (list.length === 0) {
    return { kind: "empty" };
  }

  if (list.length === 1 && list[0]) {
    return {
      kind: "verified",
      text: refundSentence(list[0]),
      references: references(list, "refundId"),
    };
  }

  return ambiguous(list, "refunds", describeRefund, "refundId");
}

function describeRecharge(row: Row): string {
  const parts = [
    amountOf(row) ? `${amountOf(row)} recharge` : "recharge",
    text(row, "mobileMasked") ? `for ${text(row, "mobileMasked")}` : undefined,
    dateOf(row, "occurredAt") ? `on ${dateOf(row, "occurredAt")}` : undefined,
    text(row, "status") ? `(${text(row, "status")})` : undefined,
    idOf(row) ? `ref ${idOf(row)}` : undefined,
  ];
  return parts.filter(Boolean).join(" ");
}

function rechargeSentence(row: Row, message: string): string {
  const operator = text(row, "operator");
  const subject = [
    "Your",
    amountOf(row),
    operator ? `${operator[0]?.toUpperCase()}${operator.slice(1)}` : undefined,
    "recharge",
    text(row, "mobileMasked") ? `for ${text(row, "mobileMasked")}` : undefined,
    dateOf(row, "occurredAt") ? `on ${dateOf(row, "occurredAt")}` : undefined,
    idOf(row) ? `(${idOf(row)})` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const note = text(row, "benefitNote");
  const wrongNumber = /\bwrong\s+(?:mobile\s+)?number\b|\bgalat\s+number\b/i.test(message)
    ? " A completed recharge can't be moved to another number or guaranteed a reversal; the operator decides, and I can raise a complaint for review."
    : "";

  switch (text(row, "status")) {
    case "success":
      return `${subject} was successful according to the operator.${wrongNumber}`;
    case "pending":
      return `${subject} is still pending with the operator. Please don't recharge again until it settles.${wrongNumber}`;
    case "failed":
      return `${subject} failed${note ? `: ${note}` : ""}. I can't confirm a refund for it yet; I can check refunds or raise a complaint if money was deducted.${wrongNumber}`;
    case "benefit_pending":
      return `${subject} was paid, but the operator hasn't activated the plan yet${note ? ` (${note})` : ""}. If it doesn't activate, I can raise a complaint.${wrongNumber}`;
    case undefined:
      return `${subject} was found, but the operator hasn't returned a status yet.`;
    default:
      return `${subject} shows the status "${text(row, "status")}".${wrongNumber}`;
  }
}

function interpretRecharges(list: Row[], message: string): Interpretation {
  if (list.length === 0) {
    return { kind: "empty" };
  }

  const narrowed = narrow(list, message);

  if (narrowed.length === 1 && narrowed[0]) {
    return {
      kind: "verified",
      text: rechargeSentence(narrowed[0], message),
      references: references(narrowed),
    };
  }

  return ambiguous(narrowed, "recharges", describeRecharge);
}

function accountGuidance(message: string): string[] {
  const lower = message.toLowerCase();
  const lines: string[] = [];

  if (/\botp\b|code (?:never|not)/.test(lower)) {
    lines.push(
      "For OTP problems, check that your registered number has signal and isn't blocking SMS, then request a new OTP from the app. Never share an OTP with anyone, including support.",
    );
  }

  if (/\blog\s?in\b|sign in|locked out|password/.test(lower)) {
    lines.push(
      "To get back in, use the app's own login recovery option. Support can't sign in for you or change your password.",
    );
  }

  if (/\bblock(?:ed)?\b|restricted|frozen|suspended/.test(lower)) {
    lines.push(
      "A blocked or restricted account can only be reviewed through the app's verified security process; support can't remove a restriction directly.",
    );
  }

  return lines;
}

function interpretAccount(row: Row, message: string): Interpretation {
  const lines: string[] = [];
  const kyc = text(row, "kycStatus");
  const flags = asRow(row.supportFlags) ?? {};

  if (kyc === "verified") {
    lines.push("Your KYC is verified.");
  } else if (kyc === "pending") {
    lines.push(
      "Your KYC is still pending. You can finish it from the KYC section of the app; support can't approve it for you.",
    );
  } else if (kyc === "rejected") {
    lines.push(
      "Your KYC was not approved. Please resubmit it from the KYC section of the app with valid documents.",
    );
  } else if (kyc) {
    lines.push(`Your KYC status is "${kyc}".`);
  }

  if (flags.login_issues === true) {
    lines.push("Our records show a known login issue on your account.");
  }

  lines.push(...accountGuidance(message));

  if (lines.length === 0) {
    lines.push("Your account details were checked and no issue is recorded on it.");
  }

  return { kind: "verified", text: lines.join(" "), references: [] };
}

function interpretComplaint(row: Row): Interpretation {
  const id = text(row, "complaintId");
  const status = text(row, "status")?.replaceAll("_", " ");
  const summary = text(row, "summary");
  const updated = dateOf(row, "updatedAt");

  if (!id) {
    return { kind: "empty" };
  }

  return {
    kind: "verified",
    text: `Complaint ${id}${summary ? ` ("${summary}")` : ""} is ${status ?? "recorded"}${
      updated ? `, last updated ${updated}` : ""
    }.`,
    references: [id],
  };
}

const COMPLAINT_WRITE_TEXT: Record<string, (id: string) => string> = {
  createComplaint: (id) => `I've raised complaint ${id}. Use this reference to follow up.`,
  addComplaintDetails: (id) => `I've added your details to complaint ${id}.`,
  escalateComplaint: (id) => `Complaint ${id} has been escalated to the support team.`,
};

function interpretComplaintWrite(tool: string, row: Row): Interpretation {
  const id = text(row, "complaintId");
  const describe = COMPLAINT_WRITE_TEXT[tool];

  if (!id || !describe) {
    return { kind: "empty" };
  }

  return { kind: "verified", text: describe(id), references: [id] };
}

export function interpretObservation(
  tool: string,
  data: unknown,
  message: string,
): Interpretation {
  const row = asRow(data);

  switch (tool) {
    case "getTransactions":
      return interpretTransactions(rows(data, "transactions") ?? [], message);
    case "getTransactionStatus":
    case "getBankReference":
      return row
        ? { kind: "verified", text: transactionSentence(row), references: references([row]) }
        : { kind: "empty" };
    case "getRefundStatus":
      return interpretRefunds(rows(data, "refunds") ?? (row && text(row, "status") ? [row] : []));
    case "getRefundDetails":
      return row ? interpretRefunds([row]) : { kind: "empty" };
    case "getRechargeStatus":
      return interpretRecharges(
        rows(data, "recharges") ?? (row && text(row, "status") ? [row] : []),
        message,
      );
    case "getRechargeDetails":
      return row ? interpretRecharges([row], message) : { kind: "empty" };
    case "getAccountSupportStatus":
      return row ? interpretAccount(row, message) : { kind: "empty" };
    case "getComplaintStatus":
      return row ? interpretComplaint(row) : { kind: "empty" };
    case "createComplaint":
    case "addComplaintDetails":
    case "escalateComplaint":
      return row ? interpretComplaintWrite(tool, row) : { kind: "empty" };
    default:
      return { kind: "empty" };
  }
}
