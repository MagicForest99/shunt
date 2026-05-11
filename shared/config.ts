import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export interface ProjectConfig {
  path: string;
  fakechat_port: number;
  bridge_port: number;
  discord_channel_id: string;
}

export interface SessionManagerConfig {
  version_check_interval: number;
  restart_delay: number;
  health_check_interval: number;
  multiplexer: "zellij" | "tmux" | "screen";
  session_prefix: string;
}

export interface DashboardConfig {
  port: number;
}

export interface ShuntConfig {
  discord: {
    token_env?: string;
    token?: string;
    guild_id: string;
  };
  dashboard: DashboardConfig;
  projects: Record<string, ProjectConfig>;
  session_manager: SessionManagerConfig;
}

const DEFAULTS: SessionManagerConfig = {
  version_check_interval: 300,
  restart_delay: 5,
  health_check_interval: 60,
  multiplexer: "zellij",
  session_prefix: "cc-",
};

export function loadConfig(configPath?: string): ShuntConfig {
  const resolved = resolve(configPath || process.env.SHUNT_CONFIG || "./shunt.yaml");
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        `Config not found: ${resolved}\n` +
          "Copy shunt.example.yaml to shunt.yaml and edit it, or pass --config <path>.",
      );
    }
    throw err;
  }
  const parsed = parse(raw) as ShuntConfig;

  // Apply defaults for session_manager
  parsed.session_manager = { ...DEFAULTS, ...parsed.session_manager };

  return parsed;
}
