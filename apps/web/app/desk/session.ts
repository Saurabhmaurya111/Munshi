export type DeskSession = {
  token: string;
  actorId: string;
  role: string;
};

const STORAGE_KEY = "munshi.desk.session";

export function readDeskSession(): DeskSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeskSession>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.actorId !== "string" ||
      typeof parsed.role !== "string"
    ) {
      return null;
    }
    return {
      token: parsed.token,
      actorId: parsed.actorId,
      role: parsed.role,
    };
  } catch {
    return null;
  }
}

export function writeDeskSession(session: DeskSession): void {
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearDeskSession(): void {
  window.sessionStorage.removeItem(STORAGE_KEY);
}
