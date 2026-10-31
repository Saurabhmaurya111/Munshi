import type { KnowledgeLookup } from "../agent/types.js";
import type { PolicyRetriever } from "./retrieval.js";

export type KnowledgeLookupOptions = {
  limit?: number;
  minScore?: number;
  now?: () => Date;
};

function headingOf(content: string): string | undefined {
  return content.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim();
}

/** Adapts the pgvector retriever to the agent's policy lookup, filtered to the task's domain. */
export function createKnowledgeLookup(
  retriever: PolicyRetriever,
  options: KnowledgeLookupOptions = {},
): KnowledgeLookup {
  const limit = options.limit ?? 3;
  const minScore = options.minScore ?? 0.05;
  const now = options.now ?? (() => new Date());

  return async ({ query, category }) => {
    const { results } = await retriever.retrieve({
      query,
      category,
      limit,
      minScore,
      asOf: now().toISOString().slice(0, 10),
    });

    return results.map((chunk) => ({
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      documentVersion: chunk.documentVersion,
      chunkIndex: chunk.chunkIndex,
      heading: headingOf(chunk.content),
      content: chunk.content,
      score: chunk.score,
    }));
  };
}
