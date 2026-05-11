import {
  type FSWatcher,
  closeSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  watch,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TailEntry {
  from: "user" | "assistant";
  text: string;
  ts: number;
  uuid: string;
  sessionId?: string;
}

export interface TailOptions {
  skipExisting?: boolean; // start from end of current file (default: true)
  pollIntervalMs?: number; // fallback poll (default: 1000)
}

/**
 * Tail the Claude Code session jsonl for a project directory.
 *
 * CC writes each project's conversation to
 * `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl`, appending
 * one JSON entry per turn. On restart it may open a new .jsonl in the
 * same directory, so this watches for new files too and seamlessly
 * switches to the newest.
 *
 * Only emits entries that contain visible text — tool-use-only turns
 * and tool_result-only user entries are skipped.
 *
 * Returns a stop function.
 */
export function tailProjectSession(
  projectPath: string,
  onEntry: (entry: TailEntry) => void,
  options: TailOptions = {},
): () => void {
  const skipExisting = options.skipExisting ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;

  const encoded = projectPath.replace(/\//g, "-");
  const dir = join(homedir(), ".claude", "projects", encoded);

  let activeFile: string | null = null;
  let position = 0;
  let leftover = "";
  let stopped = false;
  let dirWatcher: FSWatcher | null = null;

  function findNewest(): string | null {
    try {
      const candidates = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const full = join(dir, f);
          try {
            return { full, mtime: statSync(full).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((x): x is { full: string; mtime: number } => x !== null)
        .sort((a, b) => b.mtime - a.mtime);
      return candidates[0]?.full ?? null;
    } catch {
      return null;
    }
  }

  function switchTo(file: string | null, startAtEnd: boolean) {
    activeFile = file;
    leftover = "";
    if (!file) {
      position = 0;
      return;
    }
    try {
      const st = statSync(file);
      position = startAtEnd ? st.size : 0;
    } catch {
      position = 0;
    }
  }

  function parseEntry(line: string): TailEntry | null {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }

    const kind = j.type;
    if (kind !== "user" && kind !== "assistant") return null;

    const message = j.message as { content?: string | Array<Record<string, unknown>> } | undefined;
    if (!message) return null;

    let text = "";
    const content = message.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === "text" && typeof item.text === "string") {
          if (text) text += "\n";
          text += item.text;
        }
      }
    }
    if (!text.trim()) return null;

    const timestamp = typeof j.timestamp === "string" ? Date.parse(j.timestamp) : Date.now();

    return {
      from: kind,
      text,
      ts: Number.isFinite(timestamp) ? timestamp : Date.now(),
      uuid: typeof j.uuid === "string" ? j.uuid : "",
      sessionId: typeof j.sessionId === "string" ? j.sessionId : undefined,
    };
  }

  function readAppended() {
    if (stopped || !activeFile) return;
    let size: number;
    try {
      size = statSync(activeFile).size;
    } catch {
      // File disappeared; look for a replacement next poll
      activeFile = null;
      return;
    }

    if (size < position) {
      // Truncated or rotated — restart from beginning
      position = 0;
      leftover = "";
    }
    if (size === position) return;

    const length = size - position;
    const buf = Buffer.alloc(length);
    let fd: number | null = null;
    try {
      fd = openSync(activeFile, "r");
      readSync(fd, buf, 0, length, position);
    } catch {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
      return;
    }
    closeSync(fd);
    position = size;

    leftover += buf.toString("utf-8");
    const lines = leftover.split("\n");
    leftover = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = parseEntry(line);
      if (entry) {
        try {
          onEntry(entry);
        } catch {}
      }
    }
  }

  function checkForNewFile() {
    if (stopped) return;
    const newest = findNewest();
    if (!newest) return;
    if (newest !== activeFile) {
      // A newer jsonl appeared — start reading it from the beginning
      // (if we were already tailing, we want the new content).
      switchTo(newest, false);
    }
    readAppended();
  }

  // Initial setup
  const initial = findNewest();
  switchTo(initial, skipExisting);

  // Try to watch the dir for new/changed files
  try {
    dirWatcher = watch(dir, { persistent: false }, () => {
      checkForNewFile();
    });
  } catch {
    // Dir may not exist yet; the poll loop handles that too.
  }

  const poll = setInterval(checkForNewFile, pollIntervalMs);

  return () => {
    stopped = true;
    dirWatcher?.close();
    clearInterval(poll);
  };
}
