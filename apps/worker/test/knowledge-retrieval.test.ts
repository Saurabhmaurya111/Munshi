import { describe, expect, it } from "vitest";
import {
  createPolicyRetriever,
  toCitation,
} from "../src/knowledge/retrieval.js";
import { KnowledgeValidationError } from "../src/knowledge/schemas.js";
import type {
  EmbeddingProvider,
  PolicyChunkStore,
  RetrievedChunk,
  SearchOptions,
} from "../src/knowledge/types.js";

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    documentId: "doc-refund-policy",
    documentTitle: "Refund policy",
    source: "docs/policies/refund-policy.md",
    content: "Refunds are credited in five working days.",
    chunkIndex: 2,
    documentVersion: "2026-10",
    category: "refund",
    language: "en",
    metadata: {},
    score: 0.91,
    ...overrides,
  };
}

function fakeEmbedder(
  dimensions = 2,
  override?: (texts: string[]) => Promise<number[][]>,
): { embedder: EmbeddingProvider; inputs: string[][] } {
  const inputs: string[][] = [];

  return {
    inputs,
    embedder: {
      dimensions,
      async embed(texts) {
        inputs.push(texts);

        if (override) {
          return override(texts);
        }

        return texts.map(() => [1, 0]);
      },
    },
  };
}

function fakeStore(
  results: RetrievedChunk[] = [chunk()],
): {
  store: PolicyChunkStore;
  calls: Array<{ embedding: number[]; options: SearchOptions }>;
} {
  const calls: Array<{ embedding: number[]; options: SearchOptions }> = [];

  return {
    calls,
    store: {
      async replaceDocument() {
        return 0;
      },
      async search(embedding, options) {
        calls.push({ embedding, options });
        return results;
      },
    },
  };
}

describe("createPolicyRetriever", () => {
  it("returns passages and source citations", async () => {
    const { embedder } = fakeEmbedder();
    const { store } = fakeStore();

    const result = await createPolicyRetriever({ embedder, store }).retrieve({
      query: "refund timeline",
    });

    expect(result.query).toBe("refund timeline");
    expect(result.results).toHaveLength(1);
    expect(result.citations).toEqual([
      {
        documentId: "doc-refund-policy",
        documentTitle: "Refund policy",
        source: "docs/policies/refund-policy.md",
        documentVersion: "2026-10",
        chunkIndex: 2,
      },
    ]);
  });

  it("trims the query before embedding", async () => {
    const { embedder, inputs } = fakeEmbedder();
    const { store } = fakeStore();

    await createPolicyRetriever({ embedder, store }).retrieve({
      query: "  refund timeline  ",
    });

    expect(inputs).toEqual([["refund timeline"]]);
  });

  it("applies metadata filters and the default limit", async () => {
    const { embedder } = fakeEmbedder();
    const { store, calls } = fakeStore();

    await createPolicyRetriever({ embedder, store }).retrieve({
      query: "refund timeline",
      asOf: "2026-10-31",
      category: "refund",
      language: "en",
      minScore: 0.5,
    });

    expect(calls[0]?.options).toEqual({
      limit: 5,
      asOf: "2026-10-31",
      category: "refund",
      language: "en",
      minScore: 0.5,
    });
  });

  it("clamps the requested limit", async () => {
    const { embedder } = fakeEmbedder();
    const { store, calls } = fakeStore();

    const retriever = createPolicyRetriever({
      embedder,
      store,
      defaultLimit: 2,
      maxLimit: 3,
    });

    await retriever.retrieve({ query: "refund", limit: 10 });

    expect(calls[0]?.options.limit).toBe(3);
  });

  it("rejects an empty query", async () => {
    const { embedder } = fakeEmbedder();
    const { store, calls } = fakeStore();

    await expect(
      createPolicyRetriever({ embedder, store }).retrieve({ query: "   " }),
    ).rejects.toBeInstanceOf(KnowledgeValidationError);
    expect(calls).toHaveLength(0);
  });

  it("rejects an out-of-range limit", async () => {
    const { embedder } = fakeEmbedder();
    const { store } = fakeStore();

    await expect(
      createPolicyRetriever({ embedder, store }).retrieve({
        query: "refund",
        limit: 21,
      }),
    ).rejects.toBeInstanceOf(KnowledgeValidationError);
  });

  it("rejects a query embedding with the wrong dimensions", async () => {
    const { embedder } = fakeEmbedder(2, async () => [[1, 0, 0]]);
    const { store } = fakeStore();

    await expect(
      createPolicyRetriever({ embedder, store }).retrieve({ query: "refund" }),
    ).rejects.toThrow("expected 2");
  });

  it("rejects a missing query embedding", async () => {
    const { embedder } = fakeEmbedder(2, async () => []);
    const { store } = fakeStore();

    await expect(
      createPolicyRetriever({ embedder, store }).retrieve({ query: "refund" }),
    ).rejects.toThrow("no vector");
  });

  it("rejects unsafe retriever limits", () => {
    const { embedder } = fakeEmbedder();
    const { store } = fakeStore();

    expect(() =>
      createPolicyRetriever({ embedder, store, defaultLimit: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createPolicyRetriever({
        embedder,
        store,
        defaultLimit: 5,
        maxLimit: 2,
      }),
    ).toThrow(RangeError);
  });
});

describe("toCitation", () => {
  it("keeps the source reference without the passage", () => {
    expect(toCitation(chunk())).toEqual({
      documentId: "doc-refund-policy",
      documentTitle: "Refund policy",
      source: "docs/policies/refund-policy.md",
      documentVersion: "2026-10",
      chunkIndex: 2,
    });
  });
});
