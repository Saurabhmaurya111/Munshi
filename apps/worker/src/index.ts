import { pathToFileURL } from "node:url";
import { createDb } from "@repo/core";
import { loadEnv } from "./env.js";
import { runWorkerLoop } from "./loop.js";

export * from "./agent/index.js";
export * from "./knowledge/index.js";
export { runWorkerLoop } from "./loop.js";
export { loadEnv } from "./env.js";

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

async function main() {
  const env = loadEnv();
  const db = createDb(env.databaseUrl);
  const abort = new AbortController();

  const shutdown = () => abort.abort();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.info(
    JSON.stringify({
      msg: "worker_started",
      workerId: env.workerId,
      leaseMs: env.leaseMs,
      pollMs: env.pollMs,
    }),
  );

  try {
    await runWorkerLoop({
      db,
      workerId: env.workerId,
      leaseMs: env.leaseMs,
      pollMs: env.pollMs,
      signal: abort.signal,
    });
  } finally {
    await db.end();
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
