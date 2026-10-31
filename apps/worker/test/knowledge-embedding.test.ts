import { describe, expect, it, vi } from "vitest";
import {
  createDeterministicEmbeddingProvider,
  createOpenAiEmbeddingProvider,
} from "../src/knowledge/embedding.js";

describe("createDeterministicEmbeddingProvider", () => {
  it("returns stable normalized vectors", async () => {
    const provider = createDeterministicEmbeddingProvider(64);

    const [first] = await provider.embed(["refund policy"]);
    const [second] = await provider.embed(["refund policy"]);

    expect(first).toEqual(second);
    expect(first).toHaveLength(64);

    const magnitude = Math.sqrt(
      (first ?? []).reduce((sum, value) => sum + value * value, 0),
    );
    expect(magnitude).toBeCloseTo(1);
  });

  it("changes the vector for different text", async () => {
    const provider = createDeterministicEmbeddingProvider(64);

    const [first] = await provider.embed(["refund policy"]);
    const [second] = await provider.embed(["recharge policy"]);

    expect(first).not.toEqual(second);
  });

  it("returns no vectors for an empty batch", async () => {
    expect(await createDeterministicEmbeddingProvider(8).embed([])).toEqual([]);
  });

  it("rejects invalid dimensions", () => {
    expect(() => createDeterministicEmbeddingProvider(0)).toThrow(RangeError);
  });
});

describe("createOpenAiEmbeddingProvider", () => {
  it("sends the expected request and reorders indexed vectors", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });

      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 0, 1] },
            { index: 0, embedding: [1, 0, 0] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const provider = createOpenAiEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 3,
      fetchImpl,
    });

    const vectors = await provider.embed(["first", "second"]);

    expect(vectors).toEqual([
      [1, 0, 0],
      [0, 0, 1],
    ]);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      model: "text-embedding-3-small",
      input: ["first", "second"],
      dimensions: 3,
      encoding_format: "float",
    });
  });

  it("fails on a non-success response without echoing the body", async () => {
    const provider = createOpenAiEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 3,
      fetchImpl: async () =>
        new Response("secret provider detail", { status: 401 }),
    });

    await expect(provider.embed(["hello"])).rejects.toThrow(
      "OpenAI embedding request failed with status 401",
    );
  });

  it("rejects a vector with the wrong dimensions", async () => {
    const provider = createOpenAiEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 3,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }),
          { status: 200 },
        ),
    });

    await expect(provider.embed(["hello"])).rejects.toThrow(
      "does not have 3 dimensions",
    );
  });

  it("rejects a response with the wrong number of vectors", async () => {
    const provider = createOpenAiEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 3,
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });

    await expect(provider.embed(["hello"])).rejects.toThrow(
      "wrong number of vectors",
    );
  });

  it("requires an API key", () => {
    expect(() => createOpenAiEmbeddingProvider({ apiKey: "  " })).toThrow(
      "API key",
    );
  });

  it("does not call the provider for an empty batch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const provider = createOpenAiEmbeddingProvider({
      apiKey: "test-key",
      fetchImpl,
    });

    expect(await provider.embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
