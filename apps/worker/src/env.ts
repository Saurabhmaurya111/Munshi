export type WorkerEnv = {
  databaseUrl: string;
  workerId: string;
  leaseMs: number;
  pollMs: number;
};

export function loadEnv(): WorkerEnv {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const workerId =
    process.env.WORKER_ID?.trim() ||
    `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  const leaseMs = Number(process.env.LEASE_MS ?? "30000");
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error("LEASE_MS must be a positive number");
  }

  const pollMs = Number(process.env.WORKER_POLL_MS ?? "500");
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error("WORKER_POLL_MS must be a positive number");
  }

  return { databaseUrl, workerId, leaseMs, pollMs };
}
