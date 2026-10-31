import { chunkPolicyText } from "./chunking.js";
import { KnowledgeValidationError, parsePolicyDocument } from "./schemas.js";
import type {
  ChunkOptions,
  EmbeddedChunk,
  EmbeddingProvider,
  IngestResult,
  PolicyChunkStore,
  PolicyDocumentInput,
} from "./types.js";

const DEFAULT_BATCH_SIZE = 64;
const MAX_BATCH_SIZE = 512;

export type PolicyIngestorOptions = {
  embedder: EmbeddingProvider;
  store: PolicyChunkStore;
  chunkOptions?: ChunkOptions;
  batchSize?: number;
};

export type PolicyIngestor = {
  ingest: (document: PolicyDocumentInput) => Promise<IngestResult>;
};

export function createPolicyIngestor(
  options: PolicyIngestorOptions,
): PolicyIngestor {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(
      `batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`,
    );
  }

  return {
    async ingest(document) {
      const parsed = parsePolicyDocument(document);
      const drafts = chunkPolicyText(parsed.content, options.chunkOptions);

      if (drafts.length === 0) {
        throw new KnowledgeValidationError([
          "content: document produced no chunks",
        ]);
      }

      const embedded: EmbeddedChunk[] = [];

      for (let start = 0; start < drafts.length; start += batchSize) {
        const batch = drafts.slice(start, start + batchSize);
        const vectors = await options.embedder.embed(
          batch.map((chunk) => chunk.content),
        );

        if (vectors.length !== batch.length) {
          throw new Error(
            "Embedding provider returned the wrong number of vectors",
          );
        }

        vectors.forEach((vector, position) => {
          const chunk = batch[position];

          if (!chunk) {
            throw new Error("Embedding batch is missing a chunk");
          }

          if (vector.length !== options.embedder.dimensions) {
            throw new Error(
              `Embedding provider returned ${vector.length} dimensions, expected ${options.embedder.dimensions}`,
            );
          }

          embedded.push({ ...chunk, embedding: vector });
        });
      }

      const stored = await options.store.replaceDocument(parsed, embedded);

      if (stored !== embedded.length) {
        throw new Error("Knowledge store did not persist every chunk");
      }

      return {
        documentId: parsed.documentId,
        documentVersion: parsed.version,
        chunks: embedded.length,
      };
    },
  };
}
