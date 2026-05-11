import { dirname, resolve } from "node:path";
import { loadConfig } from "@shunt/shared/config.ts";
import { $ } from "bun";
import type { Subprocess } from "bun";
import { createMultiplexer } from "./multiplexer.ts";

// Resolve config path from CLI --config flag, env var, or default
const configFlag = process.argv.indexOf("--config");
const configPath = configFlag !== -1 ? process.argv[configFlag + 1] : undefined;
const config = loadConfig(configPath);

const {
  version_check_interval,
  restart_delay,
  health_check_interval,
  multiplexer: multiplexerType,
  session_prefix,
} = config.session_manager;

const mux = createMultiplexer(multiplexerType);
console.log(`[shunt] using ${mux.name} as terminal multiplexer`);

// --- Project state ---

interface ProjectState {
  name: string;
  fakechatPort: number;
  path: string;
  sessionName: string;
  status: "stopped" | "starting" | "running" | "restarting";
  lastHealthCheck?: Date;
  healthy: boolean;
  hasExistingSession: boolean;
}

const projects = new Map<string, ProjectState>();

for (const [name, project] of Object.entries(config.projects)) {
  projects.set(name, {
    name,
    fakechatPort: project.fakechat_port,
    path: project.path,
    sessionName: `${session_prefix}${name}`,
    status: "stopped",
    healthy: false,
    hasExistingSession: false,
  });
}

// --- Service processes (dashboard, bridges) ---

const serviceProcs = new Map<string, Subprocess>();
const shuntRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

// Resolve Discord bot token from config
const discordToken =
  config.discord.token ||
  (config.discord.token_env ? process.env[config.discord.token_env] : undefined);

function spawnService(name: string, cmd: string[], env: Record<string, string> = {}): Subprocess {
  console.log(`[shunt] starting service: ${name}`);
  const proc = Bun.spawn(cmd, {
    cwd: shuntRoot,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  serviceProcs.set(name, proc);
  // Auto-restart if it dies unexpectedly
  proc.exited.then((code) => {
    if (serviceProcs.has(name)) {
      console.warn(`[shunt] service ${name} exited (code ${code}), restarting in 3s...`);
      setTimeout(() => {
        if (serviceProcs.has(name)) {
          serviceProcs.delete(name);
          const restarted = spawnService(name, cmd, env);
          serviceProcs.set(name, restarted);
        }
      }, 3000);
    }
  });
  return proc;
}

function stopService(name: string) {
  const proc = serviceProcs.get(name);
  if (proc) {
    serviceProcs.delete(name); // delete first to prevent auto-restart
    proc.kill("SIGTERM");
    console.log(`[shunt] stopped service: ${name}`);
  }
}

function stopAllServices() {
  for (const name of [...serviceProcs.keys()]) {
    stopService(name);
  }
}

function startDashboard() {
  spawnService("dashboard", ["bun", "run", "dashboard/index.ts"]);
}

function startBridge(
  projectName: string,
  channelId: string,
  fakechatPort: number,
  bridgePort: number,
  projectPath: string,
) {
  if (!discordToken) {
    console.warn(`[shunt] no Discord token — skipping bridge for ${projectName}`);
    return;
  }
  spawnService(`bridge-${projectName}`, ["bun", "run", "discord-bridge/index.ts"], {
    DISCORD_BOT_TOKEN: discordToken,
    BRIDGE_CHANNEL_ID: channelId,
    FAKECHAT_PORT: String(fakechatPort),
    BRIDGE_HEALTH_PORT: String(bridgePort),
    PROJECT_NAME: projectName,
    PROJECT_PATH: projectPath,
    DASHBOARD_URL: `http://localhost:${config.dashboard?.port ?? 9000}`,
  });
}

// --- Core operations ---

async function getClaudeVersion(): Promise<string> {
  const result = await $`claude --version`.text();
  return result.trim();
}

async function checkExistingSession(project: ProjectState): Promise<boolean> {
  // Check if CC has a session for this project dir by looking for session files
  const { existsSync } = await import("node:fs");
  const projectDirEncoded = project.path.replace(/\//g, "-");
  const sessionDir = `${process.env.HOME}/.claude/projects/${projectDirEncoded}`;
  if (!existsSync(sessionDir)) return false;
  // Look for .jsonl session files (active sessions)
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(sessionDir);
  return files.some((f: string) => f.endsWith(".jsonl"));
}

async function startProject(name: string) {
  const project = projects.get(name);
  if (!project) throw new Error(`Unknown project: ${name}`);

  project.status = "starting";

  // Check if there's an existing CC session to resume
  project.hasExistingSession = await checkExistingSession(project);
  const resumeFlag = project.hasExistingSession ? " --continue" : "";
  console.log(
    `[shunt] starting ${name} on :${project.fakechatPort}${resumeFlag ? " (resuming)" : " (new session)"}`,
  );

  const ccCommand = `cd ${project.path} && FAKECHAT_PORT=${project.fakechatPort} claude --dangerously-skip-permissions --channels plugin:fakechat@claude-plugins-official --name ${name}${resumeFlag}`;

  // Kill existing session if present
  if (await mux.sessionExists(project.sessionName)) {
    await mux.killSession(project.sessionName);
    await Bun.sleep(1000);
  }

  // Create new session with Claude Code
  await mux.createSession(project.sessionName, ccCommand);

  project.status = "running";
  console.log(`[shunt] ${name} started`);
}

async function stopProject(name: string) {
  const project = projects.get(name);
  if (!project) return;

  console.log(`[shunt] stopping ${name}`);
  project.status = "stopped";
  project.healthy = false;

  if (await mux.sessionExists(project.sessionName)) {
    await mux.killSession(project.sessionName);
  }
}

async function restartProject(name: string) {
  const project = projects.get(name);
  if (!project) return;

  project.status = "restarting";
  await stopProject(name);
  await Bun.sleep(restart_delay * 1000);
  await startProject(name);
}

// --- Health checking ---

async function checkHealth(name: string): Promise<boolean> {
  const project = projects.get(name);
  if (!project) return false;

  try {
    const res = await fetch(`http://localhost:${project.fakechatPort}/`, {
      signal: AbortSignal.timeout(5000),
    });
    project.healthy = res.ok;
  } catch {
    project.healthy = false;
  }

  project.lastHealthCheck = new Date();
  return project.healthy;
}

// --- Version monitoring ---

let currentVersion: string;
try {
  currentVersion = await getClaudeVersion();
  console.log(`[shunt] Claude Code version: ${currentVersion}`);
} catch {
  console.warn("[shunt] could not detect Claude Code version");
  currentVersion = "unknown";
}

async function checkForUpdates() {
  try {
    const newVersion = await getClaudeVersion();
    if (newVersion !== currentVersion) {
      console.log(`[shunt] version change: ${currentVersion} → ${newVersion}`);
      currentVersion = newVersion;
      await rollingRestart();
    }
  } catch (err) {
    console.error("[shunt] version check failed:", err);
  }
}

async function rollingRestart() {
  console.log(`[shunt] rolling restart of ${projects.size} projects`);

  for (const [name, project] of projects) {
    if (project.status === "running") {
      console.log(`[shunt] restarting ${name}...`);
      await restartProject(name);
      await Bun.sleep(restart_delay * 1000);
    }
  }

  console.log("[shunt] rolling restart complete");
}

// --- Graceful shutdown ---

function shutdown() {
  console.log("\n[shunt] shutting down...");
  stopAllServices();
  const stops = Array.from(projects.keys()).map((name) => stopProject(name));
  Promise.all(stops).then(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- CLI ---

const command = process.argv.find((arg, i) => i >= 2 && !arg.startsWith("--"));

switch (command) {
  case "start": {
    const target = process.argv.find(
      (arg, i) => i > process.argv.indexOf("start") && !arg.startsWith("--"),
    );

    if (target) {
      // Start a single project + its bridge
      await startProject(target);
      const proj = projects.get(target)!;
      const projConfig = config.projects[target];
      if (projConfig) {
        startBridge(
          target,
          projConfig.discord_channel_id,
          proj.fakechatPort,
          projConfig.bridge_port,
          projConfig.path,
        );
      }
    } else {
      // Start everything: dashboard, then each project + bridge
      startDashboard();
      await Bun.sleep(1000); // let dashboard bind its port

      for (const [name, projConfig] of Object.entries(config.projects)) {
        await startProject(name);
        startBridge(
          name,
          projConfig.discord_channel_id,
          projConfig.fakechat_port,
          projConfig.bridge_port,
          projConfig.path,
        );
        await Bun.sleep(2000);
      }
      console.log("[shunt] all services started, monitoring...");
    }

    // Start monitoring intervals
    setInterval(checkForUpdates, version_check_interval * 1000);
    setInterval(async () => {
      for (const [name, project] of projects) {
        if (project.status === "running") {
          const healthy = await checkHealth(name);
          if (!healthy) {
            console.warn(`[shunt] ${name} unhealthy, restarting...`);
            await restartProject(name);
          }
        }
      }
    }, health_check_interval * 1000);
    break;
  }

  case "stop": {
    const target = process.argv.find(
      (arg, i) => i > process.argv.indexOf("stop") && !arg.startsWith("--"),
    );
    if (target) {
      await stopProject(target);
      stopService(`bridge-${target}`);
    } else {
      stopAllServices();
      for (const name of projects.keys()) {
        await stopProject(name);
      }
    }
    process.exit(0);
  }

  case "restart": {
    const target = process.argv.find(
      (arg, i) => i > process.argv.indexOf("restart") && !arg.startsWith("--"),
    );
    if (target) {
      await restartProject(target);
    } else {
      await rollingRestart();
    }
    break;
  }

  case "status": {
    // Run health checks inline for fresh data
    for (const name of projects.keys()) {
      await checkHealth(name);
    }

    // Check bridge health too
    const bridgeHealth: Record<string, { ok: boolean; data?: Record<string, unknown> }> = {};
    for (const [name, projConfig] of Object.entries(config.projects)) {
      try {
        const res = await fetch(`http://localhost:${projConfig.bridge_port}`, {
          signal: AbortSignal.timeout(3000),
        });
        bridgeHealth[name] = { ok: true, data: await res.json() };
      } catch {
        bridgeHealth[name] = { ok: false };
      }
    }

    // Check dashboard health
    let dashboardOk = false;
    try {
      const res = await fetch(`http://localhost:${config.dashboard?.port ?? 9000}/api/status`, {
        signal: AbortSignal.timeout(3000),
      });
      dashboardOk = res.ok;
    } catch {}

    console.log("\nProject Status:");
    console.log("─".repeat(75));
    for (const [, project] of projects) {
      const health = project.healthy ? "✓" : "✗";
      const bridge = bridgeHealth[project.name];
      const bridgeStatus = bridge?.ok ? "✓" : "✗";
      const lastCheck = project.lastHealthCheck
        ? ` (${Math.round((Date.now() - project.lastHealthCheck.getTime()) / 1000)}s ago)`
        : "";
      console.log(
        `  ${project.name.padEnd(20)} ${project.status.padEnd(12)} cc:${health} bridge:${bridgeStatus}${lastCheck}  :${project.fakechatPort}`,
      );
    }
    console.log("\nServices:");
    console.log(`  dashboard    ${dashboardOk ? "✓" : "✗"}  :${config.dashboard?.port ?? 9000}`);
    console.log(`\nClaude Code: ${currentVersion}`);
    process.exit(0);
  }

  case "logs": {
    const target = process.argv.find(
      (arg, i) => i > process.argv.indexOf("logs") && !arg.startsWith("--"),
    );
    if (!target) {
      console.error("Usage: shunt logs <project>");
      process.exit(1);
    }
    const project = projects.get(target);
    if (!project) {
      console.error(`Unknown project: ${target}`);
      process.exit(1);
    }
    await mux.attachSession(project.sessionName);
    break;
  }

  default:
    console.log("Usage: shunt <start|stop|restart|status|logs> [project]");
    console.log("\nOptions:");
    console.log("  --config <path>  Path to shunt.yaml config file");
    process.exit(command ? 1 : 0);
}
