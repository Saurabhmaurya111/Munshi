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
  isHumanOwned,
  nextIncomingReply,
  postCustomerMessage,
  requestHumanTransfer,
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
const POLL_TIMEOUT_MS = 45_000;
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
  const [caseId, setCaseId] = useState<string | undefined>();
  const [ownership, setOwnership] = useState<string>("AI_ACTIVE");
  const [lastSeenSeq, setLastSeenSeq] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastSeenSeqRef = useRef(0);

  const humanMode = isHumanOwned(ownership);

  useEffect(() => {
    lastSeenSeqRef.current = lastSeenSeq;
  }, [lastSeenSeq]);

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
  }, [router]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, busy]);

  useEffect(() => {
    if (!caseId || !humanMode || busy) return;

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
  }, [caseId, humanMode, busy]);

  function signOut() {
    clearSession();
    router.replace("/login");
  }

  async function waitForReply(
    conversationId: string,
    afterSeq: number,
  ): Promise<{ text: string; role: Role; seq: number; ownership: string }> {
    type Reply = { text: string; role: Role; seq: number; ownership: string };
    const socket = connectCustomerSocket();
    let settled = false;

    const viaSocket = new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!settled) reject(new Error("socket_timeout"));
      }, POLL_TIMEOUT_MS);

      const stop = subscribeCase(socket, conversationId, afterSeq, (event) => {
        if (event.seq <= afterSeq || typeof event.payload.text !== "string") {
          return;
        }
        const reply = nextIncomingReply([event], afterSeq);
        if (!reply) return;
        settled = true;
        clearTimeout(timer);
        stop();
        resolve({
          text: reply.text,
          role: reply.role,
          seq: reply.seq,
          ownership: "AI_ACTIVE",
        });
      });

      socket.on("connect_error", () => {
        // Fall through to HTTP poll.
      });
    });

    const viaPoll = (async (): Promise<Reply> => {
      const started = Date.now();
      while (Date.now() - started < POLL_TIMEOUT_MS) {
        if (settled) {
          throw new Error("settled");
        }
        const snapshot = await getCase(conversationId);
        const reply = nextIncomingReply(snapshot.events, afterSeq);
        if (reply) {
          settled = true;
          return {
            text: reply.text,
            role: reply.role,
            seq: reply.seq,
            ownership: snapshot.ownership,
          };
        }
        if (isHumanOwned(snapshot.ownership)) {
          settled = true;
          return {
            text: "I’ve connected you with a support specialist. Stay on this chat — they’ll reply here shortly.",
            role: "system",
            seq: snapshot.lastEventSeq,
            ownership: snapshot.ownership,
          };
        }
        await sleep(POLL_MS);
      }
      throw new Error(
        "Munshi is taking longer than usual. Please try again in a moment.",
      );
    })();

    try {
      return await Promise.any([viaSocket, viaPoll]);
    } catch {
      throw new Error(
        "Munshi is taking longer than usual. Please try again in a moment.",
      );
    } finally {
      socket.disconnect();
    }
  }

  async function pushUser(text: string) {
    const cleaned = text.trim();
    if (!cleaned || busy) return;

    setError(null);
    setBusy(true);
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

      if (isHumanOwned(posted.ownership)) {
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

      const reply = await waitForReply(posted.conversationId, posted.seq);
      setLastSeenSeq(reply.seq);
      setMessages((prev) => [
        ...prev,
        { id: `m-${Date.now()}`, role: reply.role, text: reply.text },
      ]);

      // Re-read ownership after the reply — AI escalate flips the case to Desk
      // just after the assistant_message is written.
      const latest = await getCase(posted.conversationId);
      setOwnership(latest.ownership);
      if (latest.lastEventSeq > reply.seq) {
        setLastSeenSeq(latest.lastEventSeq);
      }
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
                className={`${styles.dot} ${humanMode ? styles.dotHuman : ""}`}
                aria-hidden="true"
              />
              {busy
                ? humanMode
                  ? "Sending to specialist…"
                  : "Looking into it…"
                : humanMode
                  ? "Connected to a support specialist"
                  : `Signed in as ${session.displayName}`}
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
          {busy && !humanMode ? (
            <div className={styles.bubbleRow}>
              <div className={styles.bubbleAvatar}>
                <Image
                  src="/brand/mascot-hero.png"
                  alt=""
                  width={48}
                  height={48}
                />
              </div>
              <div className={`${styles.bubble} ${styles.bubbleMunshi}`}>
                <span className={styles.typing} aria-label="Munshi is working">
                  <span />
                  <span />
                  <span />
                </span>
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
              humanMode
                ? "Message your support specialist…"
                : "Describe your issue…"
            }
            rows={1}
            aria-label={humanMode ? "Message support" : "Message Munshi"}
            disabled={busy}
          />
          <button
            type="submit"
            className={styles.send}
            disabled={busy || !draft.trim()}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
