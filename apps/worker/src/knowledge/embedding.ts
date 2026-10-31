import type { EmbeddingProvider } from "./types.js";

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export type OpenAiEmbeddingOptions = {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

function assertDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new RangeError("dimensions must be a positive integer");
  }
}

function assertVector(vector: unknown, dimensions: number, position: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new Error(
      `Embedding ${position} does not have ${dimensions} dimensions`,
    );
  }

  return vector.map((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Embedding ${position} has an invalid value at ${index}`);
    }

    return value;
  });
}

export function createOpenAiEmbeddingProvider(
  options: OpenAiEmbeddingOptions,
): EmbeddingProvider {
  const apiKey = options.apiKey.trim();

  if (!apiKey) {
    throw new Error("An OpenAI API key is required for embeddings");
  }

  const model = options.model ?? DEFAULT_OPENAI_MODEL;
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  assertDimensions(dimensions);

  return {
    dimensions,
    async embed(texts) {
      if (texts.length === 0) {
        return [];
      }

      if (texts.some((text) => text.trim().length === 0)) {
        throw new Error("Cannot embed empty text");
      }

      const response = await fetchImpl(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: texts,
          dimensions,
          encoding_format: "float",
        }),
      });

      if (!response.ok) {
        throw new Error(
          `OpenAI embedding request failed with status ${response.status}`,
        );
      }

      const payload: unknown = await response.json();

      if (
        typeof payload !== "object" ||
        payload === null ||
        !Array.isArray((payload as { data?: unknown }).data)
      ) {
        throw new Error("OpenAI embedding response is missing data");
      }

      const data = (payload as { data: unknown[] }).data;

      if (data.length !== texts.length) {
        throw new Error("OpenAI embedding response has the wrong number of vectors");
      }

      const vectors: number[][] = new Array(texts.length);

      data.forEach((item, position) => {
        if (
          typeof item !== "object" ||
          item === null ||
          !("embedding" in item)
        ) {
          throw new Error(`Embedding ${position} is missing a vector`);
        }

        const index =
          "index" in item && typeof item.index === "number" ? item.index : position;

        if (index < 0 || index >= texts.length || vectors[index]) {
          throw new Error(`Embedding ${position} has an invalid index`);
        }

        vectors[index] = assertVector(
          (item as { embedding: unknown }).embedding,
          dimensions,
          position,
        );
      });

      return vectors;
    },
  };
}

export type NamedEmbeddingProvider = EmbeddingProvider & { name: string };

/**
 * OpenAI when OPENAI_API_KEY is set, otherwise the offline hashing embedder.
 * Ingestion and retrieval must use the same provider; re-ingest after switching.
 */
export function createEmbeddingProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): NamedEmbeddingProvider {
  const apiKey = env.OPENAI_API_KEY?.trim();

  if (apiKey) {
    const model = env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
    return {
      name: `openai:${model}`,
      ...createOpenAiEmbeddingProvider({ apiKey, model, baseUrl: env.OPENAI_BASE_URL?.trim() || undefined }),
    };
  }

  return { name: "deterministic-hash-v1", ...createDeterministicEmbeddingProvider() };
}

function hashToken(token: string): number {
  let hash = 2166136261;

  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export function createDeterministicEmbeddingProvider(
  dimensions = DEFAULT_DIMENSIONS,
): EmbeddingProvider {
  assertDimensions(dimensions);

  return {
    dimensions,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(dimensions).fill(0);
        const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

        tokens.forEach((token) => {
          const hash = hashToken(token);
          const position = hash % dimensions;
          const sign = (hash & 0x80000000) === 0 ? 1 : -1;
          vector[position] = (vector[position] ?? 0) + sign;
        });

        const magnitude = Math.sqrt(
          vector.reduce((sum, value) => sum + value * value, 0),
        );

        if (magnitude === 0) {
          return vector;
        }

        return vector.map((value) => value / magnitude);
      });
    },
  };
}
