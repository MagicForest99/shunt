import { $ } from "bun";

/**
 * Abstract interface for terminal multiplexers.
 * Implementations handle session lifecycle for a specific tool.
 */
export interface Multiplexer {
  readonly name: string;
  sessionExists(sessionName: string): Promise<boolean>;
  createSession(sessionName: string, command: string): Promise<void>;
  killSession(sessionName: string): Promise<void>;
  attachSession(sessionName: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Zellij
// ---------------------------------------------------------------------------

export class ZellijMultiplexer implements Multiplexer {
  readonly name = "zellij";

  async sessionExists(sessionName: string): Promise<boolean> {
    try {
      const result = await $`zellij list-sessions`.text();
      return result.includes(sessionName);
    } catch {
      return false;
    }
  }

  private env() {
    // Prevent nesting if already inside a zellij session
    return { ...process.env, ZELLIJ: undefined, ZELLIJ_SESSION_NAME: undefined };
  }

  async createSession(sessionName: string, command: string): Promise<void> {
    // Step 1: create a detached empty session
    await $`zellij attach ${sessionName} --create-background`.env(this.env()).quiet();
    await Bun.sleep(500);
    // Step 2: run the command in a new pane inside that session
    await $`zellij -s ${sessionName} action new-pane -- bash -c ${command}`.env(this.env()).quiet();
  }

  async killSession(sessionName: string): Promise<void> {
    try {
      await $`zellij delete-session ${sessionName} --force`.env(this.env()).quiet();
    } catch {
      // Session may already be gone or in EXITED state
      try {
        await $`zellij kill-session ${sessionName}`.env(this.env()).quiet();
      } catch {
        // Ignore — session is already dead
      }
    }
  }

  async attachSession(sessionName: string): Promise<void> {
    await $`zellij attach ${sessionName}`;
  }
}

// ---------------------------------------------------------------------------
// tmux
// ---------------------------------------------------------------------------

export class TmuxMultiplexer implements Multiplexer {
  readonly name = "tmux";

  async sessionExists(sessionName: string): Promise<boolean> {
    try {
      await $`tmux has-session -t ${sessionName}`.quiet();
      return true;
    } catch {
      return false;
    }
  }

  async createSession(sessionName: string, command: string): Promise<void> {
    await $`tmux new-session -d -s ${sessionName} bash -c ${command}`.quiet();
  }

  async killSession(sessionName: string): Promise<void> {
    await $`tmux kill-session -t ${sessionName}`.quiet();
  }

  async attachSession(sessionName: string): Promise<void> {
    await $`tmux attach-session -t ${sessionName}`;
  }
}

// ---------------------------------------------------------------------------
// GNU Screen
// ---------------------------------------------------------------------------

export class ScreenMultiplexer implements Multiplexer {
  readonly name = "screen";

  async sessionExists(sessionName: string): Promise<boolean> {
    try {
      const result = await $`screen -list`.text();
      return result.includes(sessionName);
    } catch {
      // screen -list exits non-zero when sessions exist (quirk)
      try {
        const result = await $`screen -list`.nothrow().text();
        return result.includes(sessionName);
      } catch {
        return false;
      }
    }
  }

  async createSession(sessionName: string, command: string): Promise<void> {
    await $`screen -dmS ${sessionName} bash -c ${command}`.quiet();
  }

  async killSession(sessionName: string): Promise<void> {
    await $`screen -S ${sessionName} -X quit`.quiet();
  }

  async attachSession(sessionName: string): Promise<void> {
    await $`screen -r ${sessionName}`;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const multiplexers: Record<string, () => Multiplexer> = {
  zellij: () => new ZellijMultiplexer(),
  tmux: () => new TmuxMultiplexer(),
  screen: () => new ScreenMultiplexer(),
};

export function createMultiplexer(type: string): Multiplexer {
  const factory = multiplexers[type];
  if (!factory) {
    const available = Object.keys(multiplexers).join(", ");
    throw new Error(`Unknown multiplexer "${type}". Available: ${available}`);
  }
  return factory();
}
