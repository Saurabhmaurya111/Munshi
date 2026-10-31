import { pathToFileURL } from "node:url";
import { createDb } from "@repo/core";
import { loadEnv } from "./env.js";
import { runWorkerLoop } from "./loop.js";
import { createEmbeddingProviderFromEnv } from "./knowledge/embedding.js";
import { createWorkerDependencies, describeClassifier } from "./runtime.js";

export * from "./agent/index.js";
export * from "./knowledge/index.js";
export { runWorkerLoop } from "./loop.js";
export { loadEnv } from "./env.js";
export { processClaimedCase } from "./turn.js";
export { createWorkerDependencies } from "./runtime.js";

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
  const dependencies = createWorkerDependencies(db);
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
      classifier: describeClassifier(),
      embedder: createEmbeddingProviderFromEnv().name,
    }),
  );

  try {
    await runWorkerLoop({
      db,
      workerId: env.workerId,
      leaseMs: env.leaseMs,
      pollMs: env.pollMs,
      dependencies,
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
