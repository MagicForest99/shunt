import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";

const EXAMPLE = resolve(import.meta.dir, "..", "shunt.example.yaml");

describe("loadConfig", () => {
  test("parses the shipped example yaml", () => {
    const cfg = loadConfig(EXAMPLE);
    expect(cfg.discord.token_env).toBe("DISCORD_BOT_TOKEN");
    expect(cfg.dashboard.port).toBe(9000);
    expect(cfg.projects["my-project"]).toBeDefined();
    expect(cfg.projects["my-project"].fakechat_port).toBe(8787);
    expect(cfg.projects["my-project"].bridge_port).toBe(8901);
  });

  test("applies session_manager defaults", () => {
    const cfg = loadConfig(EXAMPLE);
    expect(cfg.session_manager.multiplexer).toBe("zellij");
    expect(cfg.session_manager.session_prefix).toBe("cc-");
    expect(cfg.session_manager.version_check_interval).toBe(300);
    expect(cfg.session_manager.restart_delay).toBe(5);
    expect(cfg.session_manager.health_check_interval).toBe(60);
  });

  test("throws a clear error when config is missing", () => {
    expect(() => loadConfig("/nonexistent/shunt.yaml")).toThrow(/Config not found/);
  });
});
