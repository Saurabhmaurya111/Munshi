"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Logo } from "../components/Logo";
import { apiBase } from "../lib/api-base";
import {
  ACCOUNTS,
  writeSession,
  type SessionCustomer,
} from "../lib/session";
import styles from "./login.module.css";

export function LoginClient() {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(account: SessionCustomer) {
    setBusyId(account.customerId);
    setError(null);
    try {
      const response = await fetch(`${apiBase()}/v1/me`, {
        headers: { "x-customer-id": account.customerId },
      });
      if (!response.ok) {
        throw new Error(
          "We couldn’t sign you in right now. Please try again in a moment.",
        );
      }
      const body = (await response.json()) as { displayName?: string };
      writeSession({
        customerId: account.customerId,
        displayName: body.displayName || account.displayName,
        email: account.email,
      });
      router.replace("/chat");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
      );
      setBusyId(null);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <Logo href="/" size="md" />
        <p className={styles.eyebrow}>Welcome back</p>
        <h1 className={styles.title}>Continue to Munshi</h1>
        <p className={styles.copy}>
          Choose an account to open support chat. Munshi will pick up your
          payments, recharges, and refunds from there.
        </p>
        <ul className={styles.list}>
          {ACCOUNTS.map((account) => (
            <li key={account.customerId}>
              <button
                type="button"
                className={styles.option}
                disabled={busyId !== null}
                onClick={() => void signIn(account)}
              >
                <span className={styles.avatar} aria-hidden="true">
                  {account.displayName.slice(0, 1)}
                </span>
                <span className={styles.meta}>
                  <span className={styles.name}>{account.displayName}</span>
                  <span className={styles.id}>
                    {busyId === account.customerId
                      ? "Signing in…"
                      : account.email}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {error ? <p className={styles.error}>{error}</p> : null}
        <Link href="/" className={styles.back}>
          Back to home
        </Link>
      </div>
    </div>
  );
}
