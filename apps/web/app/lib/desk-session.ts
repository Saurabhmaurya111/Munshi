export type DeskSession = {
  agentId: string;
  displayName: string;
  role: string;
};

const STORAGE_KEY = "munshi.desk.session";

export const DESK_ACCOUNTS: DeskSession[] = [
  { agentId: "desk-priya", displayName: "Priya", role: "agent" },
  { agentId: "desk-rahul", displayName: "Rahul", role: "approver" },
  { agentId: "desk-admin", displayName: "Admin", role: "admin" },
];

export function readDeskSession(): DeskSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeskSession>;
    if (
      typeof parsed.agentId !== "string" ||
      typeof parsed.displayName !== "string"
    ) {
      return null;
    }
    const known = DESK_ACCOUNTS.find((a) => a.agentId === parsed.agentId);
    return {
      agentId: parsed.agentId,
      displayName: parsed.displayName,
      role: parsed.role || known?.role || "agent",
    };
  } catch {
    return null;
  }
}

export function writeDeskSession(session: DeskSession): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearDeskSession(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
