import styles from "./Capabilities.module.css";

const items = [
  {
    title: "Think",
    copy: "Reads the case, history, and intent before acting.",
    icon: (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path
          d="M17 27c1.5 3 4 5 7 5s5.5-2 7-5c-1-4-3.5-7-7-10-3.5 3-6 6-7 10z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        <circle cx="21.5" cy="24.5" r="1.3" fill="currentColor" />
        <circle cx="26.5" cy="24.5" r="1.3" fill="currentColor" />
      </svg>
    ),
  },
  {
    title: "Plan",
    copy: "Composes a workflow from the tools it already has.",
    icon: (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <rect
          x="15"
          y="13"
          width="18"
          height="22"
          rx="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
        />
        <path d="M19 21h10M19 26h10M19 31h6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M20 16.5h8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: "Do",
    copy: "Runs steps across systems and owns the case to close.",
    icon: (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <circle cx="24" cy="24" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path
          d="M24 12.5v3.2M24 32.3v3.2M12.5 24h3.2M32.3 24h3.2M15.8 15.8l2.3 2.3M29.9 29.9l2.3 2.3M15.8 32.2l2.3-2.3M29.9 18.1l2.3-2.3"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    title: "Stay Safe",
    copy: "Code enforces rules. Models propose. Money stays gated.",
    icon: (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path
          d="M24 12.5l11 4.5v8.2c0 7.2-4.6 12.3-11 14.3-6.4-2-11-7.1-11-14.3v-8.2l11-4.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        <path
          d="M19.5 24.2l3.1 3.1 6.4-6.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "Learn",
    copy: "Good workflows stick. Overrides teach the next run.",
    icon: (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path
          d="M24 33c-5-2-9-7-9-13 6 0 11 3 13 8 2-1 4-4 5-7 1 7-3 13-9 12z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        <path d="M24 20v6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    ),
  },
] as const;

export function Capabilities() {
  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item.title} className={styles.item}>
          <span className={styles.icon}>{item.icon}</span>
          <h3>{item.title}</h3>
          <p>{item.copy}</p>
        </li>
      ))}
    </ul>
  );
}
