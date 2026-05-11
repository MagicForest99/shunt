/**
 * Content-based dedup over a sliding window.
 *
 * Used by discord-bridge and dashboard to avoid re-broadcasting jsonl
 * entries that already arrived via the fakechat WebSocket (the fast path).
 *
 * When fakechat emits a msg frame, call mark(from, text). When the jsonl
 * tailer emits the same turn a moment later, seen(from, text) returns true
 * and the consumer skips it. Any jsonl entry whose text doesn't match is
 * a TUI-originated turn and should be broadcast.
 */
export class RecentBuffer {
  private readonly entries: { key: string; ts: number }[] = [];
  constructor(private readonly windowMs = 30_000) {}

  mark(from: string, text: string): void {
    this.prune();
    this.entries.push({ key: `${from}:${text}`, ts: Date.now() });
  }

  seen(from: string, text: string): boolean {
    this.prune();
    const key = `${from}:${text}`;
    return this.entries.some((e) => e.key === key);
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.entries.length && this.entries[0].ts < cutoff) {
      this.entries.shift();
    }
  }
}
