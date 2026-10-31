import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPgKnowledgeStore, toSqlVector } from "../src/knowledge/store.js";
import type {
  EmbeddedChunk,
  PolicyDocumentInput,
} from "../src/knowledge/types.js";

const document: PolicyDocumentInput = {
  documentId: "doc-refund-policy",
  documentTitle: "Refund policy",
  source: "docs/policies/refund-policy.md",
  version: "2026-10",
  content: "Refunds are credited in five working days.",
};

function chunk(overrides: Partial<EmbeddedChunk> = {}): EmbeddedChunk {
  return {
    chunkIndex: 0,
    content: "Refunds are credited in five working days.",
    embedding: [1, 0.5],
    ...overrides,
  };
}

function fakeClient(options: { failInsert?: boolean } = {}) {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  let released = false;

  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });

      if (options.failInsert && text.includes("INSERT INTO policy_chunks")) {
        throw new Error("insert failed");
      }

      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };

  return {
    client,
    queries,
    wasReleased: () => released,
  };
}

describe("toSqlVector", () => {
  it("formats a finite vector", () => {
    expect(toSqlVector([1, 0.5, -0])).toBe("[1,0.5,0]");
  });

  it("rejects empty and non-finite vectors", () => {
    expect(() => toSqlVector([])).toThrow("empty");
    expect(() => toSqlVector([1, Number.NaN])).toThrow("non-finite");
  });
});

describe("createPgKnowledgeStore replaceDocument", () => {
  it("replaces a document version in one transaction", async () => {
    const fake = fakeClient();
    const pool = {
      connect: vi.fn(async () => fake.client),
      query: vi.fn(),
    } as unknown as Pool;

    const stored = await createPgKnowledgeStore(pool).replaceDocument(document, [
      chunk(),
    ]);

    expect(stored).toBe(1);
    expect(fake.queries.map((query) => query.text.trim().split(/\s+/)[0])).toEqual([
      "BEGIN",
      "DELETE",
      "INSERT",
      "COMMIT",
    ]);
    expect(fake.queries[1]?.values).toEqual(["doc-refund-policy", "2026-10"]);
    expect(fake.queries[2]?.values).toEqual([
      "doc-refund-policy",
      "Refund policy",
      "docs/policies/refund-policy.md",
      "Refunds are credited in five working days.",
      0,
      "2026-10",
      null,
      null,
      null,
      "en",
      "{}",
      "[1,0.5]",
    ]);
    expect(fake.wasReleased()).toBe(true);
  });

  it("rolls back when an insert fails", async () => {
    const fake = fakeClient({ failInsert: true });
    const pool = {
      connect: vi.fn(async () => fake.client),
      query: vi.fn(),
    } as unknown as Pool;

    await expect(
      createPgKnowledgeStore(pool).replaceDocument(document, [chunk()]),
    ).rejects.toThrow("insert failed");

    expect(
      fake.queries.some((query) => query.text.trim() === "ROLLBACK"),
    ).toBe(true);
    expect(fake.wasReleased()).toBe(true);
  });

  it("rejects invalid chunks before opening a connection", async () => {
    const connect = vi.fn();
    const pool = { connect, query: vi.fn() } as unknown as Pool;
    const store = createPgKnowledgeStore(pool);

    await expect(store.replaceDocument(document, [])).rejects.toThrow(
      "at least one chunk",
    );
    await expect(
      store.replaceDocument(document, [chunk({ chunkIndex: 1 })]),
    ).rejects.toThrow("sequential");
    await expect(
      store.replaceDocument(document, [chunk({ content: "  " })]),
    ).rejects.toThrow("empty");
    await expect(
      store.replaceDocument(document, [
        chunk(),
        chunk({ chunkIndex: 1, embedding: [1, 2, 3] }),
      ]),
    ).rejects.toThrow("same dimensions");
    await expect(
      store.replaceDocument(document, [chunk({ embedding: [] })]),
    ).rejects.toThrow("empty");
    await expect(
      store.replaceDocument(document, [chunk({ embedding: [Number.NaN] })]),
    ).rejects.toThrow("non-finite");

    expect(connect).not.toHaveBeenCalled();
  });
});

describe("createPgKnowledgeStore search", () => {
  const row = {
    document_id: "doc-refund-policy",
    document_title: "Refund policy",
    source: "docs/policies/refund-policy.md",
    content: "Refunds are credited in five working days.",
    chunk_index: 2,
    document_version: "2026-10",
    category: null,
    language: "en",
    effective_from: "2026-10-01",
    effective_to: null,
    metadata: { topic: "refund" },
    score: "0.87",
  };

  it("maps rows and applies defaults", async () => {
    const query = vi.fn(async () => ({ rows: [row] }));
    const pool = { query, connect: vi.fn() } as unknown as Pool;

    const results = await createPgKnowledgeStore(pool).search([1, 0], {
      limit: 5,
    });

    expect(results).toEqual([
      {
        documentId: "doc-refund-policy",
        documentTitle: "Refund policy",
        source: "docs/policies/refund-policy.md",
        content: "Refunds are credited in five working days.",
        chunkIndex: 2,
        documentVersion: "2026-10",
        category: undefined,
        language: "en",
        effectiveFrom: "2026-10-01",
        effectiveTo: undefined,
        metadata: { topic: "refund" },
        score: 0.87,
      },
    ]);
    expect(query.mock.calls[0]?.[1]).toEqual(["[1,0]", null, null, null, -1, 5]);
  });

  it("forwards metadata filters", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query, connect: vi.fn() } as unknown as Pool;

    await createPgKnowledgeStore(pool).search([1, 0], {
      limit: 3,
      asOf: "2026-10-31",
      category: "refund",
      language: "hi",
      minScore: 0.2,
    });

    expect(query.mock.calls[0]?.[1]).toEqual([
      "[1,0]",
      "2026-10-31",
      "refund",
      "hi",
      0.2,
      3,
    ]);
  });

  it("parses metadata stored as text", async () => {
    const query = vi.fn(async () => ({
      rows: [{ ...row, metadata: '{"topic":"refund"}' }],
    }));
    const pool = { query, connect: vi.fn() } as unknown as Pool;

    const results = await createPgKnowledgeStore(pool).search([1, 0], {
      limit: 1,
    });

    expect(results[0]?.metadata).toEqual({ topic: "refund" });
  });

  it("rejects malformed rows and limits", async () => {
    const query = vi.fn(async () => ({
      rows: [{ ...row, metadata: [] }],
    }));
    const pool = { query, connect: vi.fn() } as unknown as Pool;
    const store = createPgKnowledgeStore(pool);

    await expect(store.search([1, 0], { limit: 0 })).rejects.toThrow(RangeError);
    expect(query).not.toHaveBeenCalled();
    await expect(store.search([1, 0], { limit: 1 })).rejects.toThrow(
      "not an object",
    );
  });

  it("rejects a row without a score", async () => {
    const query = vi.fn(async () => ({
      rows: [{ ...row, score: null }],
    }));
    const pool = { query, connect: vi.fn() } as unknown as Pool;

    await expect(
      createPgKnowledgeStore(pool).search([1, 0], { limit: 1 }),
    ).rejects.toThrow("score");
  });
});
