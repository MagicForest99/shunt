# Architecture

shunt is a small harness around Claude Code. It doesn't run the agent — it keeps CC sessions alive, moves messages between Discord and CC, and gives you a web view across every project.

```
    ┌──────────────────────────────────────────────────────────────────────────────┐
    │                                   Discord                                    │
    │         #project-a                #project-b                #project-c       │
    └────────────┬────────────────────────┬─────────────────────────┬──────────────┘
                 │                        │                         │
        ┌────────▼─────────┐     ┌────────▼─────────┐      ┌────────▼─────────┐
        │ discord-bridge   │     │ discord-bridge   │      │ discord-bridge   │
        │  :8901 (a)       │     │  :8902 (b)       │      │  :8903 (c)       │
        └────────┬─────────┘     └────────┬─────────┘      └────────┬─────────┘
                 │  WebSocket             │  WebSocket              │  WebSocket
        ┌────────▼─────────┐     ┌────────▼─────────┐      ┌────────▼─────────┐
        │  fakechat (CC)   │     │  fakechat (CC)   │      │  fakechat (CC)   │
        │    :8787 (a)     │     │    :8788 (b)     │      │    :8789 (c)     │
        └────────┬─────────┘     └────────┬─────────┘      └────────┬─────────┘
                 │  stdio                 │  stdio                  │  stdio
        ┌────────▼─────────┐     ┌────────▼─────────┐      ┌────────▼─────────┐
        │   Claude Code    │     │   Claude Code    │      │   Claude Code    │
        │   (zellij:cc-a)  │     │   (zellij:cc-b)  │      │   (zellij:cc-c)  │
        └──────────────────┘     └──────────────────┘      └──────────────────┘

                    ▲                       ▲                        ▲
                    │                       │                        │
    ┌───────────────┴───────────────────────┴────────────────────────┴──────────────┐
    │                            dashboard  :9000                                   │
    │   Connects to every project's fakechat WS; web UI aggregates all streams.     │
    │   Posts web user messages back through the bridge.                            │
    └───────────────────────────────────────────────────────────────────────────────┘

    ┌───────────────────────────────────────────────────────────────────────────────┐
    │                             session-manager                                   │
    │   Reads shunt.yaml. Spawns dashboard + bridges. Creates multiplexer sessions  │
    │   running CC. Polls `claude --version`. Rolling restarts on version change.   │
    │   CLI: start | stop | restart | status | logs                                 │
    └───────────────────────────────────────────────────────────────────────────────┘
```

## Components

### `session-manager/`

The lifecycle controller. Everything starts here.

**Responsibilities:**
- Reads `shunt.yaml` (or path from `--config` / `$SHUNT_CONFIG`).
- Picks a multiplexer backend from `multiplexer.ts` (zellij, tmux, or screen).
- Spawns the dashboard once, then one `discord-bridge` per project.
- Creates a multiplexer session per project running Claude Code with the fakechat plugin loaded.
- Detects existing CC sessions on disk (`~/.claude/projects/...`) and resumes with `--continue` when found.
- Polls `claude --version` on `version_check_interval` and triggers a rolling restart when it changes.
- Runs an HTTP health check against each project's fakechat port on `health_check_interval` and restarts unhealthy projects.
- Exposes `start | stop | restart | status | logs` as a CLI.

**Service supervision:** `spawnService()` auto-restarts bridge/dashboard processes on unexpected exit (3-second backoff). `stopService()` removes from the restart map first so intentional shutdowns stick.

### `discord-bridge/`

One process per project. Lives between Discord's gateway and CC's fakechat plugin.

**Inbound (Discord → CC):**
1. Discord.js client listens on a specific channel.
2. On a non-bot, non-self message: start typing indicator, forward to fakechat via WebSocket as `{id, text: "[Discord] user: content"}`, and POST to the dashboard's `/api/ingest` so web users see it too.

**Outbound (CC → Discord):**
1. WebSocket listens for `type: "msg"` frames from fakechat.
2. Filters out echo (messages we originated or that are prefixed `[Discord]`).
3. Chunks text at 1900 chars on newline boundaries, sends each chunk. Threads the first chunk as a reply if `replyTo` is a Discord snowflake.
4. Tracks `sentIds` to prevent echo loops.

**Status embed:** Pins a single embed in the channel with live status (uptime, message count, Discord/fakechat health, dashboard URL). Refreshed every 60s.

**Health endpoint (`BRIDGE_HEALTH_PORT`):**
- `GET /` — JSON status.
- `POST /api/to-discord` — used by the dashboard to forward web-user messages into Discord.

### `dashboard/`

Web UI aggregating every project. Single-page app served by Bun.

**Per project:**
- Opens a WebSocket to that project's fakechat (`ws://localhost:<fakechat_port>/ws`).
- Keeps a rolling buffer (`MSG_CAP = 500`) of messages with their source (`discord | web | fakechat`).
- Broadcasts typing state, connection state, and new/edited messages to dashboard clients.

**Endpoints:**
- `GET /` — HTML UI.
- `WS /ws` — live updates to connected browsers.
- `POST /api/ingest` — bridges and bridges-of-bridges push messages here for cross-source visibility.
- `GET /api/status` — health.

### `shared/config.ts`

Single source of truth for config shape. `loadConfig(path?)` reads YAML, merges `session_manager` defaults, returns typed.

## The fakechat plugin

shunt does **not** speak MCP directly. Instead, it speaks to [fakechat](https://github.com/anthropics/claude-code/) — a first-party CC plugin that exposes Claude's channel system as a WebSocket. Launching CC with `--channels plugin:fakechat@claude-plugins-official` binds it on `FAKECHAT_PORT`.

The wire protocol is JSON frames:
- Client → server: `{id, text}` — inbound user message.
- Server → client: `{type: "msg", from: "user" | "assistant", text, replyTo?}` — chat events.

This is why we can auto-wake CC by sending a message: fakechat injects it as a channel notification, and CC responds. It's also why cross-source works — the web dashboard and the Discord bridge are both fakechat clients.

## Startup sequence

```
┌─────────────────┐
│ shunt-boot.sh   │
└────────┬────────┘
         ▼
┌─────────────────┐
│ session-manager │ ──▶ spawn dashboard (waits 1s for port bind)
└────────┬────────┘
         │
         │  for each project:
         ▼
  ┌─────────────────────┐
  │ startProject(name)  │ ──▶ check for existing CC session
  │                     │ ──▶ kill stale multiplexer session
  │                     │ ──▶ create new session, launch `claude --channels ... [--continue]`
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │ startBridge(name)   │ ──▶ spawn discord-bridge subprocess
  └──────────┬──────────┘
             │  sleep 2s, next project
             ▼
        (repeat)
```

After startup, session-manager keeps running — `version_check_interval` and `health_check_interval` intervals supervise everything.

## Rolling restart on CC update

1. Poll `claude --version`.
2. On change, iterate projects sequentially:
   - `stopProject` → multiplexer session is killed.
   - Wait `restart_delay` seconds.
   - `startProject` → new multiplexer session, `--continue` picks up the saved session.
3. Bridges stay up the whole time (they auto-reconnect when fakechat comes back).

## Multiplexer abstraction

`session-manager/multiplexer.ts` exposes a common interface:

```ts
interface Multiplexer {
  name: "zellij" | "tmux" | "screen";
  sessionExists(name: string): Promise<boolean>;
  createSession(name: string, command: string): Promise<void>;
  killSession(name: string): Promise<void>;
  attachSession(name: string): Promise<void>;
}
```

Pick the backend in `shunt.yaml` via `session_manager.multiplexer`.

## Port discipline

- `dashboard.port` — single dashboard instance (default `:9000`).
- `projects.<name>.fakechat_port` — unique per project; CC binds here.
- `projects.<name>.bridge_port` — unique per project; `discord-bridge` health/API.

Bind ports to `127.0.0.1` if you don't want them on the LAN. The dashboard currently listens on all interfaces — change it in `dashboard/index.ts` if you need to restrict.

## Not currently handled

- Multi-user authorization. Discord channel membership is the only gate. If you expose a channel to strangers, they can drive CC.
- Structured permission prompts. `--dangerously-skip-permissions` trusts the project's settings/skills/hook config.
- Rate limiting. A noisy channel will flood CC. Consider a rate limit on the bridge if this becomes a problem.
- Secrets scanning on outbound messages. If CC prints an env var or file content, it goes to Discord verbatim.
