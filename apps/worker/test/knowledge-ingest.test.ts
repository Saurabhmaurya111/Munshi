import { describe, expect, it } from "vitest";
import { createPolicyIngestor } from "../src/knowledge/ingest.js";
import { KnowledgeValidationError } from "../src/knowledge/schemas.js";
import type {
  EmbeddedChunk,
  EmbeddingProvider,
  PolicyChunkStore,
  PolicyDocumentInput,
} from "../src/knowledge/types.js";

const document: PolicyDocumentInput = {
  documentId: "doc-refund-policy",
  documentTitle: "Refund policy",
  source: "docs/policies/refund-policy.md",
  version: "2026-10",
  content:
    "Refunds are reviewed within one working day.\n\nRefunds are credited in five working days.",
  category: "refund",
  effectiveFrom: "2026-10-01",
};

function fakeEmbedder(
  dimensions = 4,
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

        return texts.map((_, position) =>
          new Array<number>(dimensions).fill(0).map((__, index) =>
            index === position % dimensions ? 1 : 0,
          ),
        );
      },
    },
  };
}

function fakeStore(
  options: { stored?: number } = {},
): {
  store: PolicyChunkStore;
  calls: Array<{ document: PolicyDocumentInput; chunks: EmbeddedChunk[] }>;
} {
  const calls: Array<{ document: PolicyDocumentInput; chunks: EmbeddedChunk[] }> =
    [];

  return {
    calls,
    store: {
      async replaceDocument(doc, chunks) {
        calls.push({ document: doc, chunks });
        return options.stored ?? chunks.length;
      },
      async search() {
        return [];
      },
    },
  };
}

describe("createPolicyIngestor", () => {
  it("chunks, embeds, and stores a document", async () => {
    const { embedder } = fakeEmbedder();
    const { store, calls } = fakeStore();

    const result = await createPolicyIngestor({ embedder, store }).ingest(
      document,
    );

    expect(result).toEqual({
      documentId: "doc-refund-policy",
      documentVersion: "2026-10",
      chunks: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.document.language).toBeUndefined();
    expect(calls[0]?.chunks[0]?.embedding).toHaveLength(4);
  });

  it("batches embeddings for a large document", async () => {
    const { embedder, inputs } = fakeEmbedder();
    const { store } = fakeStore();
    const longDocument = {
      ...document,
      content: Array.from(
        { length: 10 },
        (_, index) =>
          `Paragraph ${index} explains the refund timeline in detail for customers.`,
      ).join("\n\n"),
    };

    const result = await createPolicyIngestor({
      embedder,
      store,
      chunkOptions: { maxChars: 120, overlapChars: 20 },
      batchSize: 2,
    }).ingest(longDocument);

    expect(result.chunks).toBeGreaterThan(2);
    expect(inputs.length).toBe(Math.ceil(result.chunks / 2));
    expect(inputs.every((batch) => batch.length <= 2)).toBe(true);
  });

  it("normalizes document fields before storing", async () => {
    const { embedder } = fakeEmbedder();
    const { store, calls } = fakeStore();

    await createPolicyIngestor({ embedder, store }).ingest({
      ...document,
      documentTitle: "  Refund policy  ",
    });

    expect(calls[0]?.document.documentTitle).toBe("Refund policy");
  });

  it("rejects an empty document", async () => {
    const { embedder } = fakeEmbedder();
    const { store, calls } = fakeStore();

    await expect(
      createPolicyIngestor({ embedder, store }).ingest({
        ...document,
        content: "   ",
      }),
    ).rejects.toBeInstanceOf(KnowledgeValidationError);
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid effective window", async () => {
    const { embedder } = fakeEmbedder();
    const { store } = fakeStore();

    await expect(
      createPolicyIngestor({ embedder, store }).ingest({
        ...document,
        effectiveFrom: "2026-10-10",
        effectiveTo: "2026-10-01",
      }),
    ).rejects.toBeInstanceOf(KnowledgeValidationError);
  });

  it("rejects an impossible date", async () => {
    const { embedder } = fakeEmbedder();
    const { store } = fakeStore();

    await expect(
      createPolicyIngestor({ embedder, store }).ingest({
        ...document,
        effectiveFrom: "2026-02-30",
      }),
    ).rejects.toBeInstanceOf(KnowledgeValidationError);
  });

  it("rejects the wrong number of embeddings", async () => {
    const { embedder } = fakeEmbedder(4, async () => []);
    const { store, calls } = fakeStore();

    await expect(
      createPolicyIngestor({ embedder, store }).ingest(document),
    ).rejects.toThrow("wrong number of vectors");
    expect(calls).toHaveLength(0);
  });

  it("rejects embeddings with the wrong dimensions", async () => {
    const { embedder } = fakeEmbedder(4, async (texts) =>
      texts.map(() => [1, 0]),
    );
    const { store } = fakeStore();

    await expect(
      createPolicyIngestor({ embedder, store }).ingest(document),
    ).rejects.toThrow("expected 4");
  });

  it("rejects a store that drops chunks", async () => {
    const { embedder } = fakeEmbedder();
    const { store } = fakeStore({ stored: 0 });

    await expect(
      createPolicyIngestor({ embedder, store }).ingest(document),
    ).rejects.toThrow("did not persist every chunk");
  });

  it("rejects an unsafe batch size", () => {
    const { embedder } = fakeEmbedder();
    const { store } = fakeStore();

    expect(() => createPolicyIngestor({ embedder, store, batchSize: 0 })).toThrow(
      RangeError,
    );
  });
});
