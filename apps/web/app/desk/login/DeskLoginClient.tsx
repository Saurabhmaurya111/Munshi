"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { Logo } from "../../components/Logo";
import { loginDesk } from "../api";
import { readDeskSession, writeDeskSession } from "../session";
import styles from "./login.module.css";

export function DeskLoginClient() {
  const router = useRouter();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (readDeskSession()) {
      router.replace("/desk");
    }
  }, [router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await loginDesk({
        id: id.trim(),
        password,
      });
      writeDeskSession(session);
      router.replace("/desk");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={(event) => void onSubmit(event)}>
        <Logo href="/" size="md" />
        <p className={styles.eyebrow}>Approver desk</p>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.copy}>
          Use the desk id and password from your environment to review parked
          writes.
        </p>

        <label className={styles.label}>
          Id
          <input
            className={styles.input}
            name="id"
            autoComplete="username"
            value={id}
            onChange={(event) => setId(event.target.value)}
            required
          />
        </label>

        <label className={styles.label}>
          Password
          <input
            className={styles.input}
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>

        {error ? <p className={styles.error}>{error}</p> : null}

        <button type="submit" className={styles.submit} disabled={busy}>
          {busy ? "Signing in…" : "Enter desk"}
        </button>

        <p className={styles.hint}>
          Default local creds: <code>approver</code> / <code>munshi-desk</code>
        </p>

        <Link href="/" className={styles.home}>
          Home
        </Link>
      </form>
    </div>
  );
}
