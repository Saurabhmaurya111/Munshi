import Image from "next/image";
import Link from "next/link";
import { Capabilities } from "./components/Capabilities";
import { Logo } from "./components/Logo";
import { Nav } from "./components/Nav";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <section className={styles.hero} aria-label="Hero">
        <Nav />
        <div className={styles.heroCopy}>
          <Logo href={null} size="lg" />
          <p className={styles.tagline}>Understands. Plans. Gets it done.</p>
          <p className={styles.support}>
            An autonomous teammate for support cases — not another chatbot that
            answers once and disappears.
          </p>
          <div className={styles.ctaRow}>
            <Link href="/chat" className={styles.primaryCta}>
              Talk to Munshi
            </Link>
            <Link href="/#how" className={styles.ghostCta}>
              See how it works
            </Link>
          </div>
        </div>
        <div className={styles.heroVisual} aria-hidden="true">
          <Image
            className={styles.mascot}
            src="/brand/mascot-hero.png"
            alt=""
            width={720}
            height={900}
            priority
          />
        </div>
      </section>

      <section className={styles.mission} aria-labelledby="mission-title">
        <div className={styles.missionInner}>
          <p className={styles.eyebrow}>Brand mission</p>
          <h2 id="mission-title" className={styles.missionTitle}>
            Not just a bot. An autonomous teammate.
          </h2>
          <p className={styles.missionCopy}>
            Munshi figures out the workflow, does the work, records everything,
            and asks for help only when it should.
          </p>
        </div>
      </section>

      <section className={styles.how} id="how" aria-labelledby="how-title">
        <div className={styles.howInner}>
          <p className={styles.eyebrow}>How Munshi works</p>
          <h2 id="how-title" className={styles.howTitle}>
            Five moves. One owner for the case.
          </h2>
          <Capabilities />
        </div>
      </section>

      <section className={styles.invite} aria-labelledby="invite-title">
        <div className={styles.inviteInner}>
          <div>
            <h2 id="invite-title" className={styles.inviteTitle}>
              Bring Munshi into a case.
            </h2>
            <p className={styles.inviteCopy}>
              Start a chat. Watch it understand, plan, and move — with a clear
              trail for humans when needed.
            </p>
          </div>
          <Link href="/chat" className={styles.inviteCta}>
            Open chat
          </Link>
        </div>
        <div className={styles.wave} aria-hidden="true">
          <div className={styles.waveTrack}>
            <svg viewBox="0 0 1440 72" preserveAspectRatio="none">
              <path
                d="M0 36c120 24 240-24 360 0s240 36 360 0 240-36 360 0 240 36 360 0v36H0z"
                fill="var(--primary)"
              />
            </svg>
            <svg viewBox="0 0 1440 72" preserveAspectRatio="none">
              <path
                d="M0 36c120 24 240-24 360 0s240 36 360 0 240-36 360 0 240 36 360 0v36H0z"
                fill="var(--primary)"
              />
            </svg>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <Logo href="/" tone="white" size="sm" />
          <p className={styles.footerNote}>
            Built for Paytm Devsemble · Autonomous AI Teammates
          </p>
        </div>
      </footer>
    </div>
  );
}
