# Contributing

Issues and PRs welcome. shunt is small on purpose — the goal is "read the whole thing in an
afternoon, then fork it." Please help keep it that way.

## Development setup

```bash
git clone https://github.com/MagicForest99/shunt
cd shunt
bun install

cp .env.example .env             # add your Discord bot token
cp shunt.example.yaml shunt.yaml # add at least one project + channel
```

You'll need a Discord bot, at least one channel to bridge, and Claude Code installed locally
with the `fakechat` plugin. See `README.md` for the full first-run walkthrough.

## Before you submit a PR

```bash
bun run check       # typecheck + lint + tests
```

`bun run check` is also what CI runs. If it passes locally, your PR should pass too.

Individual scripts:

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome check
bun run format      # biome format --write (rewrites files)
bun run test        # bun test
```

## Style

- Two-space indent, double quotes, semicolons required (Biome enforces this).
- Prefer small, pure helpers over deep call chains.
- Keep public-facing docs (`README.md`, `ARCHITECTURE.md`) up to date with behavior changes.

## Scope guidance

Things that fit shunt's scope:

- Bug fixes in the bridge, dashboard, or session-manager.
- Multiplexer support improvements (better resume detection, more backends).
- Small UX polish on the dashboard.

Things that don't:

- Building a competing agent loop. Claude Code is the agent; shunt is just the wire.
- Tightly coupling to one chat platform. The fakechat WebSocket protocol is the seam — keep
  it usable by other bridges (Slack, Matrix, etc.).
- Heavy dependencies. The codebase is ~1.7k lines of TS; please don't double that with a
  single PR.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include your shunt commit,
`claude --version`, multiplexer choice, and the relevant snippet from `session-manager` logs.
