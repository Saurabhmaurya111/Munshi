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
  approveDeskItem,
  getDeskCase,
  getDeskMe,
  getDeskQueue,
  handBackCase,
  listWorkflows,
  postDeskMessage,
  promoteWorkflow,
  rejectDeskItem,
  takeoverCase,
  type DeskCaseEvent,
  type DeskQueueItem,
  type WorkflowStatus,
} from "./api";
import styles from "./desk.module.css";

function commandId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function eventText(event: DeskCaseEvent): string | null {
  if (typeof event.payload.text === "string") return event.payload.text;
  if (typeof event.payload.draftReply === "string") return event.payload.draftReply;
  if (typeof event.payload.summary === "string") return event.payload.summary;
  if (typeof event.payload.note === "string") return event.payload.note;
  return null;
}

type PendingApproval = {
  stepId: string;
  tool: string;
  draftReply: string | null;
  workflowName: string | null;
  workflowLevel: number | null;
};

function latestPendingApproval(
  events: DeskCaseEvent[],
): PendingApproval | null {
  const ordered = [...events].sort((a, b) => b.seq - a.seq);
  const closed = new Set<string>();
  for (const event of ordered) {
    const stepId =
      typeof event.payload.stepId === "string" ? event.payload.stepId : null;
    if (!stepId) continue;
    if (
      event.type === "approval_granted" ||
      event.type === "approval_rejected"
    ) {
      closed.add(stepId);
      continue;
    }
    if (event.type === "approval_requested" && !closed.has(stepId)) {
      return {
        stepId,
        tool:
          typeof event.payload.tool === "string"
            ? event.payload.tool
            : "unknown",
        draftReply:
          typeof event.payload.draftReply === "string"
            ? event.payload.draftReply
            : typeof event.payload.text === "string"
              ? event.payload.text
              : null,
        workflowName:
          typeof event.payload.workflowName === "string"
            ? event.payload.workflowName
            : null,
        workflowLevel:
          typeof event.payload.workflowLevel === "number"
            ? event.payload.workflowLevel
            : null,
      };
    }
  }
  return null;
}

function workflowProgressLabel(workflow: WorkflowStatus): string {
  if (workflow.nextLevel === null) return "max autonomy";
  return `${workflow.progress}/${workflow.promotionThreshold} to L${workflow.nextLevel}`;
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
  const [promotingName, setPromotingName] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowStatus[]>([]);
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

  const refreshWorkflows = useEffectEvent(async () => {
    try {
      setWorkflows(await listWorkflows());
    } catch {
      // Keep last known status if briefly unavailable.
    }
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
        await refreshWorkflows();
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

  async function onApprove(stepId: string) {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await approveDeskItem({
        caseId: selectedId,
        stepId,
        commandId: commandId("approve"),
      });
      await refreshCase(selectedId);
      await refreshQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  }

  async function onReject(stepId: string) {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await rejectDeskItem({
        caseId: selectedId,
        stepId,
        commandId: commandId("reject"),
        note: "Rejected from desk",
      });
      await refreshCase(selectedId);
      await refreshQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reject failed");
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

  async function onPromoteWorkflow(name: string) {
    if (promotingName) return;
    const current = workflows.find((item) => item.name === name);
    if (current?.level === 2) return;
    setPromotingName(name);
    setError(null);
    try {
      const next = await promoteWorkflow(name);
      setWorkflows((prev) =>
        prev.map((item) => (item.name === next.name ? next : item)),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not promote workflow.",
      );
    } finally {
      setPromotingName(null);
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
  const pending =
    ownership === "PENDING_APPROVAL" ? latestPendingApproval(events) : null;
  const canApprove =
    session?.role === "approver" || session?.role === "admin";

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
          <div className={styles.workflows}>
            <div className={styles.queueHead}>
              <h2>Workflows</h2>
              <span>{workflows.length}</span>
            </div>
            <p className={styles.workflowHint}>
              Each workflow has its own autonomy level. Promote one at a time.
            </p>
            {workflows.length === 0 ? (
              <p className={styles.muted}>Loading workflows…</p>
            ) : (
              <ul className={styles.workflowList}>
                {workflows.map((item) => (
                  <li key={item.name} className={styles.workflowRow}>
                    <div className={styles.workflowMeta}>
                      <span className={styles.workflowName}>{item.name}</span>
                      <span className={styles.workflowLevel}>
                        L{item.level}
                        <span className={styles.workflowSep} aria-hidden="true">
                          ·
                        </span>
                        {workflowProgressLabel(item)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={styles.promote}
                      onClick={() => void onPromoteWorkflow(item.name)}
                      disabled={
                        promotingName !== null || busy || item.level === 2
                      }
                      title={`Promote ${item.name} one level (skips the 20 clean-run rule)`}
                    >
                      {promotingName === item.name
                        ? "…"
                        : item.level === 2
                          ? "L2"
                          : "Promote"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
                    {item.waitingFor === "approval" &&
                    item.parkedAtWorkflowLevel !== null ? (
                      <span className={styles.parkedLevel}>
                        Parked L{item.parkedAtWorkflowLevel}
                        {item.currentWorkflowLevel !== null &&
                        item.currentWorkflowLevel !== item.parkedAtWorkflowLevel
                          ? ` → now L${item.currentWorkflowLevel}`
                          : ""}
                      </span>
                    ) : null}
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
                  {selected?.promotionHint ? (
                    <p className={styles.promotionHint}>
                      {selected.promotionHint}
                    </p>
                  ) : null}
                </div>
                <div className={styles.caseActions}>
                  {ownership !== "HUMAN_OWNED" &&
                  ownership !== "PENDING_APPROVAL" ? (
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => void onTakeover()}
                    >
                      Take over
                    </button>
                  ) : null}
                  {pending && canApprove ? (
                    <>
                      <button
                        type="button"
                        className={styles.primary}
                        disabled={busy}
                        onClick={() => void onApprove(pending.stepId)}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={busy}
                        onClick={() => void onReject(pending.stepId)}
                      >
                        Reject
                      </button>
                    </>
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

              {pending ? (
                <div className={styles.summary}>
                  <h3>Pending approval</h3>
                  <p>
                    Tool: {pending.tool}
                    {pending.workflowName
                      ? ` · workflow ${pending.workflowName}`
                      : ""}
                    {pending.workflowLevel !== null
                      ? ` · parked L${pending.workflowLevel}`
                      : ""}
                  </p>
                  {pending.draftReply ? (
                    <p>
                      <strong>Draft reply:</strong> {pending.draftReply}
                    </p>
                  ) : null}
                  {!canApprove ? (
                    <p className={styles.muted}>
                      Sign in as Rahul (approver) or Admin to approve or reject.
                    </p>
                  ) : null}
                </div>
              ) : null}

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
