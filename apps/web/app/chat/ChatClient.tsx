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
import styles from "./chat.module.css";

type Role = "munshi" | "user";

type Message = {
  id: string;
  role: Role;
  text: string;
};

const STARTER: Message = {
  id: "welcome",
  role: "munshi",
  text: "Hi — I’m Munshi. Tell me what went wrong with a payment, recharge, or refund, and I’ll take it from understanding to a plan.",
};

const HINTS = [
  "My UPI payment failed but money left my account",
  "IRCTC refund still pending",
  "Recharge done, balance not updated",
];

function replyFor(input: string): string {
  const q = input.toLowerCase();
  if (q.includes("upi")) {
    return "Got it — a UPI debit without a successful merchant credit. I’ll classify this as a payment investigation, pull the transaction trail, and open a dispute follow-up if the bank SLA allows. I won’t claim a refund I can’t issue.\n\nShare the UPI reference (UTR) when you have it.";
  }
  if (q.includes("irctc") || q.includes("refund")) {
    return "I’ll treat this as a partner refund status case. Plan: confirm booking + refund id, read IRCTC status, explain what’s blocking payout, and set a chase timer — without promising a railway-side refund.\n\nDrop the PNR or refund id if you have one.";
  }
  if (q.includes("recharge")) {
    return "Sounds like a recharge fulfillment gap. I’ll verify the operator request, check mock-world fulfillment, and either confirm success, retry safely, or escalate with a full trace.\n\nWhat number was recharged, and about when?";
  }
  return "Understood. I’ll triage intent and urgency from what you shared, look for a matching workflow, and compose a plan from available tools if we don’t have one yet.\n\nAny transaction id, amount, or timing you can add will tighten the first pass.";
}

export function ChatClient() {
  const [messages, setMessages] = useState<Message[]>([STARTER]);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useEffectEvent(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  });

  useEffect(() => {
    scrollToBottom();
  }, [messages, typing]);

  function pushUser(text: string) {
    const cleaned = text.trim();
    if (!cleaned || typing) return;

    const userMessage: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      text: cleaned,
    };
    setMessages((prev) => [...prev, userMessage]);
    setDraft("");
    setTyping(true);

    window.setTimeout(() => {
      const munshiMessage: Message = {
        id: `m-${Date.now()}`,
        role: "munshi",
        text: replyFor(cleaned),
      };
      setMessages((prev) => [...prev, munshiMessage]);
      setTyping(false);
      inputRef.current?.focus();
    }, 900 + Math.min(1200, cleaned.length * 12));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    pushUser(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      pushUser(draft);
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
              On the case
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
                    : styles.bubbleUser
                }`}
              >
                {message.text}
              </div>
            </div>
          ))}
          {typing ? (
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
                <span className={styles.typing} aria-label="Munshi is typing">
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
        {messages.length < 3 ? (
          <div className={styles.hints}>
            {HINTS.map((hint) => (
              <button
                key={hint}
                type="button"
                className={styles.hint}
                onClick={() => pushUser(hint)}
                disabled={typing}
              >
                {hint}
              </button>
            ))}
          </div>
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
          />
          <button
            type="submit"
            className={styles.send}
            disabled={typing || !draft.trim()}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
