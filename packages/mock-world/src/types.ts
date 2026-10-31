export type MockSystem =
  | "bank"
  | "upi"
  | "wallet"
  | "irctc"
  | "crm"
  | "tickets"
  | "recharge";

export type Queryable = {
  query: <T extends object = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
};

export type HandlerResult =
  | { ok: true; data: unknown }
  | { ok: false; errorCode: string; message: string };

export type ToolHandler = (input: {
  customerId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  idempotencyKey?: string;
}) => Promise<HandlerResult>;

export type ToolOutcomeLookup = {
  state: "confirmed" | "failed" | "unknown";
  data?: unknown;
  errorCode?: string;
  message?: string;
};
