import Link from "next/link";
import styles from "./Logo.module.css";

type LogoProps = {
  href?: string | null;
  tone?: "navy" | "white";
  size?: "sm" | "md" | "lg";
};

export function Logo({ href = "/", tone = "navy", size = "md" }: LogoProps) {
  const content = (
    <span className={`${styles.logo} ${styles[tone]} ${styles[size]}`} aria-label="Munshi">
      Munsh
      <span className={styles.i} aria-hidden="true">
        ı
        <svg className={styles.leaf} viewBox="0 0 20 20">
          <path
            d="M4 12c4-1 9-5 12-11 1 7-2 14-9 16-1-1-2-3-3-5z"
            fill="currentColor"
          />
        </svg>
      </span>
    </span>
  );

  if (href == null) return content;
  return (
    <Link href={href} className={styles.link} aria-label="Munshi">
      {content}
    </Link>
  );
}
