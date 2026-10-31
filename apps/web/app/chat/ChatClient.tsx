"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useRef,
  useState,
  useEffectEvent,
} from "react";
import { Logo } from "../components/Logo";
import {
  clearSession,
  readSession,
  type SessionCustomer,
} from "../lib/session";
import {
  getCase,
  getWorkflow,
  isHumanOwned,
  isPendingApprovalEvent,
  isTurnResolutionEvent,
  latestPendingApprovalText,
  latestWorkflowName,
  nextIncomingReply,
  postCustomerMessage,
  requestHumanTransfer,
  type WorkflowStatus,
} from "./api";
import { connectCustomerSocket, subscribeCase } from "./socket";
import styles from "./chat.module.css";

type Role = "munshi" | "user" | "system" | "human";

type Message = {
  id: string;
  role: Role;
  text: string;
};

const STARTER: Message = {
  id: "welcome",
  role: "munshi",
  text: "Hi — I’m Munshi. Tell me what went wrong with a payment, recharge, or refund, and I’ll take it from here.",
};

const HINTS = [
  "My UPI payment failed yesterday",
  "My IRCTC refund is still pending",
  "Recharge of ₹299 failed last week",
];

const POLL_MS = 700;
/** Initial worker reply (or parked-approval notice). */
const TURN_TIMEOUT_MS = 45_000;
/** Once parked for desk approval, keep the socket open. */
const APPROVAL_TIMEOUT_MS = 30 * 60_000;
const HUMAN_POLL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ChatClient() {
  const router = useRouter();
  const [session, setSession] = useState<SessionCustomer | null>(null);
  const [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<Message[]>([STARTER]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [caseId, setCaseId] = useState<string | undefined>();
  const [ownership, setOwnership] = useState<string>("AI_ACTIVE");
  const [lastSeenSeq, setLastSeenSeq] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowStatus | null>(null);
  const [activeWorkflowName, setActiveWorkflowName] = useState("default");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastSeenSeqRef = useRef(0);
  const activeWorkflowNameRef = useRef("default");

  const humanMode = isHumanOwned(ownership);
  const specialistMode = ownership === "HUMAN_OWNED";

  useEffect(() => {
    lastSeenSeqRef.current = lastSeenSeq;
  }, [lastSeenSeq]);

  useEffect(() => {
    activeWorkflowNameRef.current = activeWorkflowName;
  }, [activeWorkflowName]);

  const refreshWorkflow = useEffectEvent(async (name?: string) => {
    const target = name?.trim() || activeWorkflowNameRef.current || "default";
    try {
      const next = await getWorkflow(target);
      setActiveWorkflowName(next.name);
      setWorkflow(next);
    } catch {
      // Keep last known status if the API is briefly unavailable.
    }
  });

  const syncWorkflowFromEvents = useEffectEvent(
    async (events: Parameters<typeof latestWorkflowName>[0]) => {
      const name = latestWorkflowName(events, activeWorkflowNameRef.current);
      if (name !== activeWorkflowNameRef.current) {
        setActiveWorkflowName(name);
      }
      await refreshWorkflow(name);
    },
  );

  const scrollToBottom = useEffectEvent(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  });

  useEffect(() => {
    const current = readSession();
    if (!current) {
      router.replace("/login");
      return;
    }
    setSession(current);
    setReady(true);
    void refreshWorkflow();
    // Workflow level is shared state — keep it fresh even when this chat is idle.
    const timer = setInterval(() => void refreshWorkflow(), 15_000);
    return () => clearInterval(timer);
  }, [router]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, busy]);

  useEffect(() => {
    if (!busy) {
      void refreshWorkflow();
    }
  }, [busy]);

  useEffect(() => {
    if (!caseId || !specialistMode || busy) return;

    let cancelled = false;

    async function pollHumanReplies() {
      while (!cancelled) {
        try {
          const snapshot = await getCase(caseId!);
          if (cancelled) return;
          setOwnership(snapshot.ownership);

          const reply = nextIncomingReply(
            snapshot.events,
            lastSeenSeqRef.current,
          );
          if (reply) {
            lastSeenSeqRef.current = reply.seq;
            setLastSeenSeq(reply.seq);
            setMessages((prev) => [
              ...prev,
              {
                id: `h-${reply.seq}`,
                role: reply.role,
                text: reply.text,
              },
            ]);
          }
        } catch {
          // Keep polling; transient API blips should not stop desk replies.
        }
        await sleep(HUMAN_POLL_MS);
      }
    }

    void pollHumanReplies();
    return () => {
      cancelled = true;
    };
  }, [caseId, specialistMode, busy]);

  function signOut() {
    clearSession();
    router.replace("/login");
  }

  async function waitForTurn(
    conversationId: string,
    afterSeq: number,
    onParked: (text: string) => void,
  ): Promise<{ text: string; seq: number; role: "munshi" | "human" | "system" }> {
    const socket = connectCustomerSocket();
    let settled = false;
    let parked = false;
    let parkedSeq = afterSeq;
    let holdingForDesk = false;
    let deadline = Date.now() + TURN_TIMEOUT_MS;
    let rejectSocket: ((error: Error) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const armTimer = () => {
      if (timer) clearTimeout(timer);
      const remaining = Math.max(0, deadline - Date.now());
      timer = setTimeout(() => {
        if (!settled) rejectSocket?.(new Error("socket_timeout"));
      }, remaining);
    };

    const markParked = (text: string, seq: number) => {
      holdingForDesk = true;
      if (!parked) {
        parked = true;
        parkedSeq = seq;
        deadline = Date.now() + APPROVAL_TIMEOUT_MS;
        armTimer();
        onParked(text);
      }
    };

    const finish = (
      text: string,
      seq: number,
      role: "munshi" | "human" | "system" = "munshi",
    ) => {
      settled = true;
      if (timer) clearTimeout(timer);
      return { text, seq, role };
    };

    const resolveFromEvent = (
      event: {
        seq: number;
        type: string;
        payload: Record<string, unknown>;
      },
    ): { text: string; seq: number; role: "munshi" | "human" | "system" } | null => {
      if (event.seq <= afterSeq) return null;

      if (isPendingApprovalEvent(event as never)) {
        markParked(String(event.payload.text), event.seq);
        return null;
      }

      if (holdingForDesk) {
        // Stay on the line until desk acts — ignore the parked assistant copy.
        if (event.seq <= parkedSeq) return null;
        if (event.type === "human_message" && typeof event.payload.text === "string") {
          return { text: String(event.payload.text), seq: event.seq, role: "human" };
        }
        if (
          event.type === "status" &&
          event.payload.pendingApproval === false &&
          typeof event.payload.text === "string"
        ) {
          return { text: String(event.payload.text), seq: event.seq, role: "system" };
        }
        if (
          event.type === "assistant_message" &&
          event.payload.pendingApproval !== true &&
          typeof event.payload.text === "string"
        ) {
          return { text: String(event.payload.text), seq: event.seq, role: "munshi" };
        }
        return null;
      }

      if (isTurnResolutionEvent(event as never)) {
        const role =
          event.type === "human_message"
            ? "human"
            : event.type === "status"
              ? "system"
              : "munshi";
        return { text: String(event.payload.text), seq: event.seq, role };
      }

      return null;
    };

    const viaSocket = new Promise<{
      text: string;
      seq: number;
      role: "munshi" | "human" | "system";
    }>((resolve, reject) => {
      rejectSocket = reject;
      armTimer();

      const stop = subscribeCase(socket, conversationId, afterSeq, (event) => {
        if (settled) return;
        const resolved = resolveFromEvent(event);
        if (!resolved) return;
        stop();
        resolve(finish(resolved.text, resolved.seq, resolved.role));
      });

      socket.on("connect_error", () => {
        // HTTP poll remains as backup.
      });
    });

    const viaPoll = (async () => {
      while (Date.now() < deadline) {
        if (settled) throw new Error("settled");
        const snapshot = await getCase(conversationId);

        if (snapshot.ownership === "PENDING_APPROVAL") {
          holdingForDesk = true;
        }

        const flagged = latestPendingApprovalText(snapshot.events, afterSeq);
        if (flagged) {
          markParked(flagged.text, flagged.seq);
        } else if (snapshot.ownership === "PENDING_APPROVAL") {
          const soft = snapshot.events
            .filter(
              (event) =>
                event.seq > afterSeq &&
                event.type === "assistant_message" &&
                typeof event.payload.text === "string",
            )
            .at(-1);
          if (soft) markParked(String(soft.payload.text), soft.seq);
        }

        const ordered = [...snapshot.events].sort((a, b) => a.seq - b.seq);
        for (const event of ordered) {
          if (isPendingApprovalEvent(event) && event.seq > afterSeq) {
            markParked(String(event.payload.text), event.seq);
            continue;
          }
          const resolved = resolveFromEvent(event);
          if (resolved) return finish(resolved.text, resolved.seq, resolved.role);
        }

        if (snapshot.ownership === "HUMAN_OWNED" && !holdingForDesk) {
          return finish(
            "I’ve connected you with a support specialist. Stay on this chat — they’ll reply here shortly.",
            snapshot.lastEventSeq,
            "system",
          );
        }
        await sleep(POLL_MS);
      }
      throw new Error(
        holdingForDesk
          ? "Still waiting on desk approval. Keep this tab open, or check back after an approver acts."
          : "Munshi is taking longer than usual. Please try again in a moment.",
      );
    })();

    try {
      return await Promise.any([viaSocket, viaPoll]);
    } catch {
      throw new Error(
        holdingForDesk
          ? "Still waiting on desk approval. Keep this tab open, or check back after an approver acts."
          : "Munshi is taking longer than usual. Please try again in a moment.",
      );
    } finally {
      if (timer) clearTimeout(timer);
      socket.disconnect();
    }
  }

  async function pushUser(text: string) {
    const cleaned = text.trim();
    if (!cleaned || busy) return;

    setError(null);
    setBusy(true);
    setAwaitingApproval(false);
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", text: cleaned },
    ]);
    setDraft("");

    try {
      const posted = await postCustomerMessage({
        message: cleaned,
        caseId,
        commandId: commandId("web"),
      });
      setCaseId(posted.conversationId);
      if (posted.ownership) {
        setOwnership(posted.ownership);
      }

      if (posted.ownership === "HUMAN_OWNED") {
        setLastSeenSeq(posted.seq);
        setMessages((prev) => [
          ...prev,
          {
            id: `s-${Date.now()}`,
            role: "system",
            text: "Message sent to your support specialist.",
          },
        ]);
        return;
      }

      const reply = await waitForTurn(
        posted.conversationId,
        posted.seq,
        (parkedText) => {
          setAwaitingApproval(true);
          setMessages((prev) => {
            const already = prev.some(
              (message) =>
                message.role === "munshi" && message.text === parkedText,
            );
            if (already) return prev;
            return [
              ...prev,
              { id: `m-park-${Date.now()}`, role: "munshi", text: parkedText },
            ];
          });
          void getCase(posted.conversationId).then((snapshot) =>
            syncWorkflowFromEvents(snapshot.events),
          );
        },
      );

      setLastSeenSeq(reply.seq);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.text === reply.text) return prev;
        return [
          ...prev,
          {
            id: `m-${Date.now()}`,
            role: reply.role === "human" ? "human" : reply.role === "system" ? "system" : "munshi",
            text: reply.text,
          },
        ];
      });

      // Re-read ownership after the reply — AI escalate flips the case to Desk
      // just after the assistant_message is written.
      const latest = await getCase(posted.conversationId);
      setOwnership(latest.ownership);
      if (latest.lastEventSeq > reply.seq) {
        setLastSeenSeq(latest.lastEventSeq);
      }
      await syncWorkflowFromEvents(latest.events);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Something went wrong talking to Munshi.";
      setError(message);
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          role: "system",
          text: message,
        },
      ]);
    } finally {
      setBusy(false);
      setAwaitingApproval(false);
      inputRef.current?.focus();
    }
  }

  async function transferToHuman() {
    if (!caseId || busy || humanMode) return;
    setError(null);
    setBusy(true);
    try {
      const result = await requestHumanTransfer({
        caseId,
        commandId: commandId("xfer"),
        reason: "customer_requested",
      });
      setOwnership(result.ownership);
      setLastSeenSeq(result.lastEventSeq);
      const snapshot = await getCase(caseId);
      const notice = [...snapshot.events]
        .reverse()
        .find((event) => event.type === "human_transfer");
      const fallback = result.ticketId
        ? `I’ve connected you with a support specialist. Your ticket ID is ${result.ticketId}.`
        : "I’ve connected you with a support specialist. They’ll reply here shortly.";
      setMessages((prev) => [
        ...prev,
        {
          id: `t-${Date.now()}`,
          role: "system",
          text:
            typeof notice?.payload.text === "string"
              ? notice.payload.text
              : fallback,
        },
      ]);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not transfer to a human agent.";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void pushUser(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void pushUser(draft);
    }
  }

  if (!ready || !session) {
    return (
      <div className={styles.shell}>
        <p className={styles.loading}>Loading…</p>
      </div>
    );
  }

  const statusDotClass = awaitingApproval
    ? styles.dotAmber
    : specialistMode
      ? styles.dotHuman
      : "";

  const statusLabel = awaitingApproval
    ? "Waiting for desk approval…"
    : busy
      ? specialistMode
        ? "Sending to specialist…"
        : "Looking into it…"
      : specialistMode
        ? "Connected to a support specialist"
        : `Signed in as ${session.displayName}`;

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.identity}>
          <div className={styles.avatar}>
            <Image
              src="/brand/mascot-hero.png"
              alt=""
              width={64}
              height={64}
            />
          </div>
          <div className={styles.meta}>
            <Logo href="/" size="sm" />
            <p className={styles.status}>
              <span
                className={`${styles.dot} ${statusDotClass}`}
                aria-hidden="true"
              />
              {statusLabel}
            </p>
          </div>
        </div>
        <div className={styles.topActions}>
          {caseId && !humanMode ? (
            <button
              type="button"
              className={styles.transfer}
              onClick={() => void transferToHuman()}
              disabled={busy}
            >
              Talk to a human
            </button>
          ) : null}
          {workflow ? (
            <div
              className={styles.workflowChip}
              title="Workflow autonomy is controlled from Desk"
            >
              <span className={styles.workflowLabel}>Workflow</span>
              <span className={styles.workflowName}>{workflow.name}</span>
              <span className={styles.workflowSep} aria-hidden="true">
                ·
              </span>
              <span>
                Level {workflow.level}
                {workflow.nextLevel !== null
                  ? ` · ${workflow.progress}/${workflow.promotionThreshold} to L${workflow.nextLevel}`
                  : " · max autonomy"}
              </span>
            </div>
          ) : null}
          <Link href="/desk" className={styles.back}>
            Desk
          </Link>
          <button type="button" className={styles.switch} onClick={signOut}>
            Switch account
          </button>
          <Link href="/" className={styles.back}>
            Home
          </Link>
        </div>
      </header>

      <div className={styles.thread} role="log" aria-live="polite">
        <div className={styles.threadInner}>
          {messages.map((message) => (
            <div
              key={message.id}
              className={`${styles.bubbleRow} ${
                message.role === "user" ? styles.bubbleRowUser : ""
              }`}
            >
              {message.role === "munshi" || message.role === "human" ? (
                <div className={styles.bubbleAvatar}>
                  {message.role === "munshi" ? (
                    <Image
                      src="/brand/mascot-hero.png"
                      alt=""
                      width={48}
                      height={48}
                    />
                  ) : (
                    <span className={styles.humanMark} aria-hidden="true">
                      H
                    </span>
                  )}
                </div>
              ) : null}
              <div
                className={`${styles.bubble} ${
                  message.role === "munshi"
                    ? styles.bubbleMunshi
                    : message.role === "human"
                      ? styles.bubbleHuman
                      : message.role === "system"
                        ? styles.bubbleSystem
                        : styles.bubbleUser
                }`}
              >
                {message.role === "human" ? (
                  <span className={styles.agentLabel}>Support</span>
                ) : null}
                {message.text}
              </div>
            </div>
          ))}
          {busy ? (
            <div className={styles.bubbleRow}>
              <div className={styles.bubbleAvatar}>
                {awaitingApproval || specialistMode ? (
                  <span className={styles.humanMark} aria-hidden="true">
                    {awaitingApproval ? "…" : "H"}
                  </span>
                ) : (
                  <Image
                    src="/brand/mascot-hero.png"
                    alt=""
                    width={48}
                    height={48}
                  />
                )}
              </div>
              <div
                className={`${styles.bubble} ${
                  awaitingApproval || specialistMode
                    ? styles.bubbleSystem
                    : styles.bubbleMunshi
                }`}
              >
                {awaitingApproval ? (
                  <span className={styles.waitingNote}>
                    <span
                      className={styles.typing}
                      aria-label="Waiting for desk approval"
                    >
                      <span />
                      <span />
                      <span />
                    </span>
                    Waiting for desk approval…
                  </span>
                ) : (
                  <span className={styles.typing} aria-label="Munshi is working">
                    <span />
                    <span />
                    <span />
                  </span>
                )}
              </div>
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className={styles.composerWrap}>
        {messages.length < 3 && !busy && !humanMode ? (
          <div className={styles.hints}>
            {HINTS.map((hint) => (
              <button
                key={hint}
                type="button"
                className={styles.hint}
                onClick={() => void pushUser(hint)}
                disabled={busy}
              >
                {hint}
              </button>
            ))}
          </div>
        ) : null}
        {error && !busy ? (
          <p className={styles.errorNote}>{error}</p>
        ) : null}
        <form className={styles.composer} onSubmit={onSubmit}>
          <textarea
            ref={inputRef}
            className={styles.input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              awaitingApproval
                ? "Waiting for desk approval…"
                : specialistMode
                  ? "Message your support specialist…"
                  : "Describe your issue…"
            }
            rows={1}
            aria-label={specialistMode ? "Message support" : "Message Munshi"}
            disabled={busy || awaitingApproval}
          />
          <button
            type="submit"
            className={styles.send}
            disabled={busy || awaitingApproval || !draft.trim()}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
