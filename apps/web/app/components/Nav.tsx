import Link from "next/link";
import { Logo } from "./Logo";
import styles from "./Nav.module.css";

export function Nav() {
  return (
    <header className={styles.nav}>
      <Logo size="sm" />
      <nav className={styles.links} aria-label="Primary">
        <Link href="/#how">How it works</Link>
        <Link href="/login" className={styles.cta}>
          Talk to Munshi
        </Link>
      </nav>
    </header>
  );
}
