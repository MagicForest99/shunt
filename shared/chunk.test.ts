import { describe, expect, test } from "bun:test";
import { chunkMessage } from "./chunk.ts";

describe("chunkMessage", () => {
  test("returns input as single chunk when under limit", () => {
    expect(chunkMessage("hello", 10)).toEqual(["hello"]);
  });

  test("returns input as single chunk when exactly at limit", () => {
    expect(chunkMessage("abcdefghij", 10)).toEqual(["abcdefghij"]);
  });

  test("splits on newline when present within limit", () => {
    const text = "line one\nline two\nline three";
    const chunks = chunkMessage(text, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("line one");
    expect(chunks.join("")).toContain("line three");
  });

  test("falls back to hard cut when no newline within limit", () => {
    const text = "a".repeat(25);
    const chunks = chunkMessage(text, 10);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(10);
    expect(chunks[1].length).toBe(10);
    expect(chunks[2].length).toBe(5);
  });

  test("never produces a chunk longer than maxLen", () => {
    const text = "x".repeat(5000);
    for (const chunk of chunkMessage(text, 1900)) {
      expect(chunk.length).toBeLessThanOrEqual(1900);
    }
  });

  test("preserves full content across all chunks (newline-free input)", () => {
    const text = "x".repeat(5000);
    const chunks = chunkMessage(text, 1900);
    expect(chunks.join("")).toBe(text);
  });

  test("handles empty string", () => {
    expect(chunkMessage("", 10)).toEqual([""]);
  });
});
