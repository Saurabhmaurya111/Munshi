"use client";

import Image from "next/image";
import Link from "next/link";
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
  customerId,
  getCase,
  latestAssistantText,
  postCustomerMessage,
} from "./api";
import styles from "./chat.module.css";

type Role = "munshi" | "user" | "system";

type Message = {
  id: string;
  role: Role;
  text: string;
};

const STARTER: Message = {
  id: "welcome",
  role: "munshi",
  text: "Hi — I’m Munshi. Tell me what went wrong with a payment, recharge, or refund. I’ll open a real case, look up mock-world records, and reply from the worker.",
};

const HINTS = [
  "My UPI payment txn_upi_1001 failed yesterday",
  "IRCTC refund refund_5001 still pending",
  "Recharge of ₹299 failed last week",
];

const POLL_MS = 700;
const POLL_TIMEOUT_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ChatClient() {
  const [messages, setMessages] = useState<Message[]>([STARTER]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [caseId, setCaseId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useEffectEvent(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  });

  useEffect(() => {
    scrollToBottom();
  }, [messages, busy]);

  async function waitForAssistant(
    conversationId: string,
    afterSeq: number,
  ): Promise<string> {
    const started = Date.now();
    while (Date.now() - started < POLL_TIMEOUT_MS) {
      const snapshot = await getCase(conversationId);
      const text = latestAssistantText(snapshot.events, afterSeq);
      if (text) {
        return text;
      }
      await sleep(POLL_MS);
    }
    throw new Error(
      "Timed out waiting for Munshi. Is `npm run dev:worker` running?",
    );
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
        commandId: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      setCaseId(posted.conversationId);

      const reply = await waitForAssistant(
        posted.conversationId,
        posted.seq,
      );

      setMessages((prev) => [
        ...prev,
        { id: `m-${Date.now()}`, role: "munshi", text: reply },
      ]);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong talking to Munshi.";
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
              <span className={styles.dot} aria-hidden="true" />
              {busy ? "Working the case…" : `On the case · ${customerId()}`}
            </p>
          </div>
        </div>
        <Link href="/" className={styles.back}>
          Back home
        </Link>
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
              {message.role === "munshi" ? (
                <div className={styles.bubbleAvatar}>
                  <Image
                    src="/brand/mascot-hero.png"
                    alt=""
                    width={48}
                    height={48}
                  />
                </div>
              ) : null}
              <div
                className={`${styles.bubble} ${
                  message.role === "munshi"
                    ? styles.bubbleMunshi
                    : message.role === "system"
                      ? styles.bubbleSystem
                      : styles.bubbleUser
                }`}
              >
                {message.text}
              </div>
            </div>
          ))}
          {busy ? (
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
        {messages.length < 3 && !busy ? (
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
          <p className={styles.errorNote}>
            Start API + worker: `npm run dev:api` and `npm run dev:worker`
          </p>
        ) : null}
        <form className={styles.composer} onSubmit={onSubmit}>
          <textarea
            ref={inputRef}
            className={styles.input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Describe the issue…"
            rows={1}
            aria-label="Message Munshi"
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
