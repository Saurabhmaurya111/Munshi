import type { Pool } from "pg";
import type {
  EmbeddedChunk,
  PolicyChunkStore,
  PolicyDocumentInput,
  RetrievedChunk,
  SearchOptions,
} from "./types.js";

const SEARCH_SQL = `
  SELECT
    document_id,
    document_title,
    source,
    content,
    chunk_index,
    document_version,
    category,
    language,
    effective_from::text AS effective_from,
    effective_to::text AS effective_to,
    metadata,
    1 - (embedding <=> $1::vector) AS score
  FROM policy_chunks
  WHERE embedding IS NOT NULL
    AND ($2::date IS NULL OR effective_from IS NULL OR effective_from <= $2::date)
    AND ($2::date IS NULL OR effective_to IS NULL OR effective_to >= $2::date)
    AND ($3::text IS NULL OR category = $3)
    AND ($4::text IS NULL OR language = $4)
    AND 1 - (embedding <=> $1::vector) >= $5
  ORDER BY embedding <=> $1::vector
  LIMIT $6
`;

export function toSqlVector(embedding: number[]): string {
  if (embedding.length === 0) {
    throw new Error("An embedding vector cannot be empty");
  }

  const values = embedding.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("An embedding vector contains a non-finite value");
    }

    return Object.is(value, -0) ? 0 : value;
  });

  return `[${values.join(",")}]`;
}

function assertChunks(chunks: EmbeddedChunk[]): void {
  if (chunks.length === 0) {
    throw new Error("A document must contain at least one chunk");
  }

  const dimensions = chunks[0]?.embedding.length ?? 0;

  chunks.forEach((chunk, position) => {
    if (chunk.chunkIndex !== position) {
      throw new Error("Chunk indices must be sequential from zero");
    }

    if (chunk.content.trim().length === 0) {
      throw new Error(`Chunk ${position} is empty`);
    }

    if (chunk.embedding.length !== dimensions) {
      throw new Error("All chunks in a document must use the same dimensions");
    }

    toSqlVector(chunk.embedding);
  });
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];

  if (typeof value !== "string") {
    throw new Error(`Policy chunk row is missing ${key}`);
  }

  return value;
}

function optionalString(
  row: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function readMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }

  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);

    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    throw new Error("Policy chunk metadata is not an object");
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error("Policy chunk metadata is not an object");
}

function mapRow(row: Record<string, unknown>): RetrievedChunk {
  const rawScore = row.score;

  if (
    (typeof rawScore !== "number" && typeof rawScore !== "string") ||
    rawScore === ""
  ) {
    throw new Error("Policy chunk row is missing a score");
  }

  const score = Number(rawScore);

  if (!Number.isFinite(score)) {
    throw new Error("Policy chunk row is missing a score");
  }

  return {
    documentId: requiredString(row, "document_id"),
    documentTitle: requiredString(row, "document_title"),
    source: requiredString(row, "source"),
    content: requiredString(row, "content"),
    chunkIndex: Number(row.chunk_index),
    documentVersion: requiredString(row, "document_version"),
    category: optionalString(row, "category"),
    language: requiredString(row, "language"),
    effectiveFrom: optionalString(row, "effective_from"),
    effectiveTo: optionalString(row, "effective_to"),
    metadata: readMetadata(row.metadata),
    score,
  };
}

function assertSearchOptions(options: SearchOptions): void {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100");
  }
}

export function createPgKnowledgeStore(pool: Pool): PolicyChunkStore {
  return {
    async replaceDocument(
      document: PolicyDocumentInput,
      chunks: EmbeddedChunk[],
    ) {
      assertChunks(chunks);

      const client = await pool.connect();
      const metadata = JSON.stringify(document.metadata ?? {});

      try {
        await client.query("BEGIN");
        await client.query(
          `DELETE FROM policy_chunks
           WHERE document_id = $1 AND document_version = $2`,
          [document.documentId, document.version],
        );

        for (const chunk of chunks) {
          await client.query(
            `INSERT INTO policy_chunks (
               document_id,
               document_title,
               source,
               content,
               chunk_index,
               document_version,
               effective_from,
               effective_to,
               category,
               language,
               metadata,
               embedding
             ) VALUES (
               $1, $2, $3, $4, $5, $6,
               $7::date, $8::date, $9, $10, $11::jsonb, $12::vector
             )`,
            [
              document.documentId,
              document.documentTitle,
              document.source,
              chunk.content,
              chunk.chunkIndex,
              document.version,
              document.effectiveFrom ?? null,
              document.effectiveTo ?? null,
              document.category ?? null,
              document.language ?? "en",
              metadata,
              toSqlVector(chunk.embedding),
            ],
          );
        }

        await client.query("COMMIT");
        return chunks.length;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async search(embedding: number[], options: SearchOptions) {
      assertSearchOptions(options);

      const result = await pool.query(SEARCH_SQL, [
        toSqlVector(embedding),
        options.asOf ?? null,
        options.category ?? null,
        options.language ?? null,
        options.minScore ?? -1,
        options.limit,
      ]);

      return result.rows.map((row) => mapRow(row as Record<string, unknown>));
    },
  };
}
