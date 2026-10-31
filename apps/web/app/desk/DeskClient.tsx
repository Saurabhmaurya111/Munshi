"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState, useEffectEvent } from "react";
import { Logo } from "../components/Logo";
import {
  DESK_ACCOUNTS,
  clearDeskSession,
  readDeskSession,
  writeDeskSession,
  type DeskSession,
} from "../lib/desk-session";
import {
  getDeskCase,
  getDeskMe,
  getDeskQueue,
  handBackCase,
  postDeskMessage,
  takeoverCase,
  type DeskCaseEvent,
  type DeskQueueItem,
} from "./api";
import styles from "./desk.module.css";

function commandId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function eventText(event: DeskCaseEvent): string | null {
  if (typeof event.payload.text === "string") return event.payload.text;
  if (typeof event.payload.summary === "string") return event.payload.summary;
  if (typeof event.payload.note === "string") return event.payload.note;
  return null;
}

export function DeskClient() {
  const [session, setSession] = useState<DeskSession | null>(null);
  const [ready, setReady] = useState(false);
  const [queue, setQueue] = useState<DeskQueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<DeskCaseEvent[]>([]);
  const [ownership, setOwnership] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshQueue = useEffectEvent(async () => {
    const items = await getDeskQueue();
    setQueue(items);
  });

  const refreshCase = useEffectEvent(async (caseId: string) => {
    const snapshot = await getDeskCase(caseId);
    setEvents(snapshot.events);
    setOwnership(snapshot.ownership);
  });

  useEffect(() => {
    const current = readDeskSession();
    setSession(current);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    async function tick() {
      try {
        await refreshQueue();
        if (selectedId) {
          await refreshCase(selectedId);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Desk refresh failed");
        }
      }
    }

    void tick();
    const id = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [session, selectedId]);

  async function signIn(account: DeskSession) {
    setError(null);
    setBusy(true);
    try {
      writeDeskSession(account);
      const me = await getDeskMe();
      const next = {
        agentId: me.agentId,
        displayName: me.displayName,
        role: me.role,
      };
      writeDeskSession(next);
      setSession(next);
    } catch (err) {
      clearDeskSession();
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    clearDeskSession();
    setSession(null);
    setQueue([]);
    setSelectedId(null);
    setEvents([]);
  }

  async function openCase(caseId: string) {
    setSelectedId(caseId);
    setError(null);
    try {
      await refreshCase(caseId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load case");
    }
  }

  async function onTakeover() {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await takeoverCase({
        caseId: selectedId,
        commandId: commandId("takeover"),
      });
      await refreshCase(selectedId);
      await refreshQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Takeover failed");
    } finally {
      setBusy(false);
    }
  }

  async function onHandBack() {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await handBackCase({
        caseId: selectedId,
        commandId: commandId("handback"),
        note: "Returning case to Munshi after human assistance.",
      });
      await refreshQueue();
      setSelectedId(null);
      setEvents([]);
      setOwnership("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Hand-back failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSend(event: FormEvent) {
    event.preventDefault();
    if (!selectedId || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (ownership !== "HUMAN_OWNED") {
        await takeoverCase({
          caseId: selectedId,
          commandId: commandId("takeover"),
        });
      }
      await postDeskMessage({
        caseId: selectedId,
        message: draft.trim(),
        commandId: commandId("desk"),
      });
      setDraft("");
      await refreshCase(selectedId);
      await refreshQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send reply");
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <div className={styles.shell}>
        <p className={styles.muted}>Loading Desk…</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <Logo href="/" size="sm" />
          <Link href="/" className={styles.link}>
            Home
          </Link>
        </header>
        <main className={styles.login}>
          <h1>Munshi Desk</h1>
          <p className={styles.muted}>
            Sign in as a support specialist to take over escalated conversations.
          </p>
          {error ? <p className={styles.error}>{error}</p> : null}
          <ul className={styles.accountList}>
            {DESK_ACCOUNTS.map((account) => (
              <li key={account.agentId}>
                <button
                  type="button"
                  className={styles.accountBtn}
                  disabled={busy}
                  onClick={() => void signIn(account)}
                >
                  <strong>{account.displayName}</strong>
                  <span>{account.role}</span>
                </button>
              </li>
            ))}
          </ul>
        </main>
      </div>
    );
  }

  const selected = queue.find((item) => item.conversationId === selectedId);

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div>
          <Logo href="/" size="sm" />
          <p className={styles.muted}>
            {session.displayName} · {session.role}
          </p>
        </div>
        <div className={styles.topActions}>
          <button type="button" className={styles.linkBtn} onClick={signOut}>
            Sign out
          </button>
          <Link href="/chat" className={styles.link}>
            Customer chat
          </Link>
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.queue}>
          <div className={styles.queueHead}>
            <h2>Queue</h2>
            <span>{queue.length}</span>
          </div>
          {queue.length === 0 ? (
            <p className={styles.muted}>No cases waiting on a human.</p>
          ) : (
            <ul className={styles.queueList}>
              {queue.map((item) => (
                <li key={item.conversationId}>
                  <button
                    type="button"
                    className={`${styles.queueItem} ${
                      item.conversationId === selectedId
                        ? styles.queueItemActive
                        : ""
                    }`}
                    onClick={() => void openCase(item.conversationId)}
                  >
                    <span className={styles.queueMeta}>
                      <strong>{item.ticketId || item.customerId}</strong>
                      <em>{item.waitingFor}</em>
                    </span>
                    <span className={styles.queuePreview}>
                      {item.latestCustomerText ||
                        item.escalationSummary ||
                        "Waiting for specialist"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className={styles.casePane}>
          {!selectedId ? (
            <p className={styles.muted}>
              Select a case to review the escalation summary and reply.
            </p>
          ) : (
            <>
              <div className={styles.caseHead}>
                <div>
                  <h2>
                    {selected?.ticketId
                      ? `Ticket ${selected.ticketId}`
                      : (selected?.customerId ?? "Case")}
                  </h2>
                  <p className={styles.muted}>
                    {selected?.customerId} · {ownership || selected?.ownership}{" "}
                    · {selected?.waitingFor ?? "human"}
                    {selected?.ticketStatus
                      ? ` · ${selected.ticketStatus}`
                      : ""}
                  </p>
                </div>
                <div className={styles.caseActions}>
                  {ownership !== "HUMAN_OWNED" ? (
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => void onTakeover()}
                    >
                      Take over
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() => void onHandBack()}
                  >
                    Hand back to Munshi
                  </button>
                </div>
              </div>

              {selected?.escalationSummary ? (
                <div className={styles.summary}>
                  <h3>Escalation summary</h3>
                  <p>{selected.escalationSummary}</p>
                  {selected.recommendation ? (
                    <p>
                      <strong>Recommendation:</strong> {selected.recommendation}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {error ? <p className={styles.error}>{error}</p> : null}

              <div className={styles.thread}>
                {events.map((event) => {
                  const text = eventText(event);
                  if (!text) return null;
                  const isCustomer = event.type === "customer_message";
                  const isHuman = event.type === "human_message";
                  return (
                    <div
                      key={`${event.seq}-${event.type}`}
                      className={`${styles.bubble} ${
                        isCustomer
                          ? styles.bubbleCustomer
                          : isHuman
                            ? styles.bubbleAgent
                            : styles.bubbleSystem
                      }`}
                    >
                      <span className={styles.bubbleType}>
                        {event.type.replaceAll("_", " ")}
                      </span>
                      {text}
                    </div>
                  );
                })}
              </div>

              <form className={styles.composer} onSubmit={onSend}>
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Reply as the support specialist…"
                  rows={3}
                  disabled={busy}
                />
                <button
                  type="submit"
                  className={styles.primary}
                  disabled={busy || !draft.trim()}
                >
                  Send reply
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
