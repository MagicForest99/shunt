import { describe, expect, test } from "bun:test";
import { RecentBuffer } from "./recent-buffer.ts";

describe("RecentBuffer", () => {
  test("seen returns false before mark", () => {
    const buf = new RecentBuffer();
    expect(buf.seen("user", "hello")).toBe(false);
  });

  test("seen returns true after mark for the same (from, text)", () => {
    const buf = new RecentBuffer();
    buf.mark("user", "hello");
    expect(buf.seen("user", "hello")).toBe(true);
  });

  test("seen distinguishes different from values", () => {
    const buf = new RecentBuffer();
    buf.mark("user", "hello");
    expect(buf.seen("assistant", "hello")).toBe(false);
  });

  test("seen distinguishes different text values", () => {
    const buf = new RecentBuffer();
    buf.mark("user", "hello");
    expect(buf.seen("user", "world")).toBe(false);
  });

  test("entries fall out of window after expiry", async () => {
    const buf = new RecentBuffer(20); // 20ms window
    buf.mark("user", "hello");
    expect(buf.seen("user", "hello")).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(buf.seen("user", "hello")).toBe(false);
  });

  test("repeated mark of the same pair stays seen", () => {
    const buf = new RecentBuffer();
    buf.mark("assistant", "ok");
    buf.mark("assistant", "ok");
    expect(buf.seen("assistant", "ok")).toBe(true);
  });
});
