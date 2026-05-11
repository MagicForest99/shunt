# shunt

**Remote-control your Claude Code sessions from Discord.**

One Discord channel → one project → one Claude Code session running in your terminal. The channel *is* the session. Step away from your desk, steer it from your phone, come back, and the same session is still running where you left it.

```
┌──────────────┐      ┌───────────────┐      ┌─────────────────┐      ┌───────────────┐
│   Discord    │ ───▶ │ discord-bridge│ ───▶ │  fakechat (CC)  │ ───▶ │ Claude Code   │
│ #my-project  │ ◀─── │  (per project)│ ◀─── │  WebSocket      │ ◀─── │ in zellij/tmux│
└──────────────┘      └───────────────┘      └─────────────────┘      └───────────────┘
```

## Why shunt

- **It's a harness, not a replacement.** Claude Code does all the work. shunt just routes messages and keeps sessions alive. Every CC feature — plugins, skills, hooks, subagents, memory, compaction — works automatically. When CC ships a new release, shunt auto-detects and does a rolling restart.
- **The session is real.** CC runs in a terminal multiplexer (zellij, tmux, or screen). You can attach locally and see the same state Discord sees. No context split between a "Discord agent" and your actual dev environment.
- **Multiple projects, one bot.** Map each project to its own Discord channel. The bridge routes per channel ID, so you can talk to your homelab repo in one channel and a TypeScript app in another, same bot.
- **Web dashboard included.** Aggregates every project's chat stream in a single browser view with typing indicators and cross-source visibility.
- **Under 2k lines of TypeScript.** Easy to read, easy to fork.

## How it differs from the neighbors

|                              | **shunt**                                           | [Hermes Agent][hermes]               | [claude-code-discord-bridge][ccdb]    |
| ---                          | ---                                                 | ---                                  | ---                                   |
| Agent loop                   | Claude Code                                         | Its own (Python)                     | Claude Code                           |
| Platforms                    | Discord + web dashboard                             | Telegram/Discord/Slack/WA/Signal/... | Discord                               |
| Session model                | 1 channel → 1 project → 1 long-running CC session   | Gateway, agent picks context         | 1 Discord thread → 1 CC session       |
| Same session available locally? | Yes — `zellij attach` to the running tmux/zellij | N/A (separate process)               | No — bridge spawns its own            |
| Rolling restart on CC update | Yes                                                 | N/A                                  | No                                    |
| LoC                          | ~1.7k TS                                            | Much larger                          | Comparable                            |

[hermes]: https://hermes-agent.nousresearch.com/
[ccdb]: https://github.com/ebibibi/claude-code-discord-bridge

shunt is narrower than Hermes on purpose. Hermes wants to be the agent; shunt wants to be the wire that your existing CC session hangs off. If you already trust CC and want to keep driving it locally *and* remotely, shunt stays out of the way.

## Setup

### Prerequisites

- [Bun](https://bun.sh)
- [zellij](https://zellij.dev), [tmux](https://github.com/tmux/tmux), or `screen`
- [Claude Code](https://claude.ai/code) CLI, logged in
- A Discord bot with the **Message Content** intent enabled
- The [fakechat plugin](https://github.com/anthropics/claude-code) for Claude Code (`plugin:fakechat@claude-plugins-official`) — shunt uses its WebSocket as the channel wire

### Install

```bash
git clone https://github.com/MagicForest99/shunt
cd shunt
bun install

# Configure the bot token
cp .env.example .env
# → set DISCORD_BOT_TOKEN=...

# Configure projects and channels
cp shunt.example.yaml shunt.yaml
# → edit with your project paths and Discord channel IDs
```

### Run

```bash
./shunt-boot.sh
```

That boots the session manager, which in turn launches:
- the web dashboard on `:9000`,
- a `discord-bridge` process per project,
- a CC session per project inside your terminal multiplexer.

## Configuration

Everything lives in `shunt.yaml`:

```yaml
discord:
  token_env: DISCORD_BOT_TOKEN
  guild_id: "YOUR_GUILD_ID"

dashboard:
  port: 9000

projects:
  my-project:
    path: /absolute/path/to/project
    fakechat_port: 8787       # CC fakechat WebSocket port
    bridge_port: 8901         # discord-bridge HTTP port
    discord_channel_id: "..."

session_manager:
  version_check_interval: 300  # poll `claude --version` every N seconds
  restart_delay: 5             # seconds between rolling restarts
  health_check_interval: 60
  multiplexer: zellij          # zellij | tmux | screen
  session_prefix: "cc-"
```

Each project needs a unique `fakechat_port` and `bridge_port`. See [`shunt.example.yaml`](./shunt.example.yaml).

## CLI

```bash
bun run session-manager/index.ts start            # start everything
bun run session-manager/index.ts start my-project # start one project + its bridge
bun run session-manager/index.ts status           # show health of every service
bun run session-manager/index.ts restart          # rolling restart across projects
bun run session-manager/index.ts logs my-project  # attach to that project's CC session
bun run session-manager/index.ts stop             # stop everything
```

The `--config <path>` flag (or `SHUNT_CONFIG` env var) picks a non-default config file.

## Architecture

Three small components plus the CC-side fakechat plugin. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design doc.

| Component        | Role                                                          | Lines |
| ---              | ---                                                           | ---   |
| `session-manager`| Lifecycle: start/stop/restart, health checks, CC-version watch | ~550  |
| `discord-bridge` | One per project. Discord ↔ fakechat WebSocket                 | ~400  |
| `dashboard`      | Web UI aggregating every project's chat stream                | ~680  |
| `shared`         | Config loader                                                  | ~55   |

## Security notes

- Claude Code runs with `--dangerously-skip-permissions` by default so it can reply to Discord without interactive prompts. Only point shunt at bots you trust and channels you control. Consider using Discord's role-gated channels to restrict who can send commands.
- `.env` and `shunt.yaml` are gitignored. Double-check before committing.
- Messages sent to CC are prefixed with `[Discord] <username>:` so the model can see the source — this does *not* authenticate the sender. If you need real authorization, layer it on top (per-user allowlists, channel-role checks).

## Contributing

Issues and PRs welcome. This is a small enough codebase that you can read the whole thing in an afternoon.

## License

[MIT](./LICENSE)
