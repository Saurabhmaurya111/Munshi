import { parseRetrieveInput } from "./schemas.js";
import type {
  Citation,
  EmbeddingProvider,
  PolicyChunkStore,
  RetrieveInput,
  RetrievedChunk,
} from "./types.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export type PolicyRetrieverOptions = {
  embedder: EmbeddingProvider;
  store: PolicyChunkStore;
  defaultLimit?: number;
  maxLimit?: number;
};

export type RetrievalResult = {
  query: string;
  results: RetrievedChunk[];
  citations: Citation[];
};

export type PolicyRetriever = {
  retrieve: (input: RetrieveInput) => Promise<RetrievalResult>;
};

export function toCitation(chunk: RetrievedChunk): Citation {
  return {
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    source: chunk.source,
    documentVersion: chunk.documentVersion,
    chunkIndex: chunk.chunkIndex,
  };
}

export function createPolicyRetriever(
  options: PolicyRetrieverOptions,
): PolicyRetriever {
  const defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = options.maxLimit ?? MAX_LIMIT;

  if (!Number.isInteger(defaultLimit) || defaultLimit < 1) {
    throw new RangeError("defaultLimit must be a positive integer");
  }

  if (!Number.isInteger(maxLimit) || maxLimit < defaultLimit) {
    throw new RangeError("maxLimit must be at least defaultLimit");
  }

  return {
    async retrieve(input) {
      const parsed = parseRetrieveInput(input);
      const limit = Math.min(parsed.limit ?? defaultLimit, maxLimit);
      const vectors = await options.embedder.embed([parsed.query]);
      const embedding = vectors[0];

      if (!embedding) {
        throw new Error("Embedding provider returned no vector for the query");
      }

      if (embedding.length !== options.embedder.dimensions) {
        throw new Error(
          `Embedding provider returned ${embedding.length} dimensions, expected ${options.embedder.dimensions}`,
        );
      }

      const results = await options.store.search(embedding, {
        limit,
        asOf: parsed.asOf,
        category: parsed.category,
        language: parsed.language,
        minScore: parsed.minScore,
      });

      return {
        query: parsed.query,
        results,
        citations: results.map(toCitation),
      };
    },
  };
}
