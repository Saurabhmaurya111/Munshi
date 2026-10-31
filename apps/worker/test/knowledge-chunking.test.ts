import { describe, expect, it } from "vitest";
import {
  chunkPolicyText,
  normalizePolicyText,
} from "../src/knowledge/chunking.js";

describe("normalizePolicyText", () => {
  it("normalizes line endings, trailing spaces, and blank runs", () => {
    expect(normalizePolicyText("  Line one   \r\n\r\n\r\n\r\nLine two\t \n")).toBe(
      "Line one\n\nLine two",
    );
  });

  it("returns an empty string for blank input", () => {
    expect(normalizePolicyText(" \n\t\n ")).toBe("");
  });
});

describe("chunkPolicyText", () => {
  it("returns no chunks for blank input", () => {
    expect(chunkPolicyText("   \n\n ")).toEqual([]);
  });

  it("keeps a short document in one chunk", () => {
    const chunks = chunkPolicyText("Refunds take five working days.");

    expect(chunks).toEqual([
      {
        chunkIndex: 0,
        content: "Refunds take five working days.",
      },
    ]);
  });

  it("keeps paragraph boundaries inside a chunk", () => {
    const chunks = chunkPolicyText("First paragraph.\n\nSecond paragraph.");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("splits long text into bounded sequential chunks", () => {
    const text = [
      "One two three four.",
      "Five six seven eight.",
      "Nine ten eleven twelve.",
      "Thirteen fourteen fifteen.",
    ].join(" ");

    const chunks = chunkPolicyText(text, { maxChars: 45, overlapChars: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      chunks.map((_, index) => index),
    );
    chunks.forEach((chunk) => {
      expect(chunk.content.length).toBeLessThanOrEqual(45);
      expect(chunk.content.length).toBeGreaterThan(0);
    });
  });

  it("overlaps the tail of the previous chunk", () => {
    const text = [
      "One two three.",
      "Four five six.",
      "Seven eight nine.",
      "Ten eleven twelve.",
    ].join(" ");

    const chunks = chunkPolicyText(text, { maxChars: 36, overlapChars: 18 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]?.content.startsWith("Four five six.")).toBe(true);
  });

  it("hard-splits a sentence longer than the limit", () => {
    const text = "word ".repeat(40).trim();
    const chunks = chunkPolicyText(text, { maxChars: 100, overlapChars: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => {
      expect(chunk.content.length).toBeLessThanOrEqual(100);
    });
    expect(chunks.map((chunk) => chunk.content).join(" ")).toBe(text);
  });

  it("is deterministic", () => {
    const text = "A sentence. Another sentence. A third sentence.";

    expect(chunkPolicyText(text, { maxChars: 30, overlapChars: 10 })).toEqual(
      chunkPolicyText(text, { maxChars: 30, overlapChars: 10 }),
    );
  });

  it("rejects unsafe options", () => {
    expect(() => chunkPolicyText("text", { maxChars: 10 })).toThrow(RangeError);
    expect(() =>
      chunkPolicyText("text", { maxChars: 100, overlapChars: 100 }),
    ).toThrow(RangeError);
    expect(() =>
      chunkPolicyText("text", { maxChars: 100, overlapChars: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      chunkPolicyText("text", { maxChars: 100.5, overlapChars: 0 }),
    ).toThrow(RangeError);
  });
});
