export type SessionCustomer = {
  customerId: string;
  displayName: string;
  email: string;
};

const STORAGE_KEY = "munshi.session";

export const ACCOUNTS: SessionCustomer[] = [
  {
    customerId: "customer-soham",
    displayName: "Soham",
    email: "soham@paytm.com",
  },
  {
    customerId: "customer-aditya",
    displayName: "Aditya",
    email: "aditya@paytm.com",
  },
  {
    customerId: "customer-saurabh",
    displayName: "Saurabh",
    email: "saurabh@paytm.com",
  },
];

export function readSession(): SessionCustomer | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionCustomer>;
    if (
      typeof parsed.customerId !== "string" ||
      typeof parsed.displayName !== "string"
    ) {
      return null;
    }
    const known = ACCOUNTS.find((a) => a.customerId === parsed.customerId);
    return {
      customerId: parsed.customerId,
      displayName: parsed.displayName,
      email: parsed.email || known?.email || "",
    };
  } catch {
    return null;
  }
}

export function writeSession(session: SessionCustomer): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
