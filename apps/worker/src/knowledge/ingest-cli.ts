import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@repo/core";
import { createEmbeddingProviderFromEnv } from "./embedding.js";
import { createPolicyIngestor } from "./ingest.js";
import { loadPolicyDocuments } from "./policies.js";
import { createPgKnowledgeStore } from "./store.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const policiesDir = process.env.POLICIES_DIR ?? join(repoRoot, "docs", "policies");
  const embedder = createEmbeddingProviderFromEnv();
  const db = createDb(databaseUrl);
  const ingestor = createPolicyIngestor({ embedder, store: createPgKnowledgeStore(db) });

  try {
    const documents = await loadPolicyDocuments(policiesDir, { embedder: embedder.name });

    for (const document of documents) {
      const result = await ingestor.ingest(document);
      console.info(JSON.stringify({ msg: "policy_ingested", embedder: embedder.name, ...result }));
    }
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
