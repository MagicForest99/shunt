# Security

## Reporting a vulnerability

If you believe you've found a security issue in shunt, please **do not** file a public issue.
Instead, open a private [security advisory](https://github.com/MagicForest99/shunt/security/advisories/new)
on GitHub, or email `unimonkey@gmail.com` with details and reproduction steps.
You should expect an initial response within a week.

## Trust model

shunt is a harness around Claude Code. It assumes you trust the project you point it at
and the Discord channels you wire to it. In particular:

- **Discord channel membership is the only auth gate.** Anyone with permission to type in
  a bridged channel can send messages to Claude Code. There is no per-user allowlist by
  default. If you expose a bridged channel to people you don't trust, they can drive CC
  with your credentials and on your machine.
- **`--dangerously-skip-permissions` is on by default.** Claude Code can read and write files,
  run shell commands, and call any tool the project's settings/skills/hooks allow, without
  interactive approval. Only point shunt at projects whose tool config you've reviewed.
- **Outbound messages are not scrubbed.** If Claude prints an environment variable, file
  content, or secret in a reply, it goes to Discord verbatim. Treat bridged channels as if
  they have full read access to the host.
- **Bot tokens** belong in `.env` (gitignored). Rotate immediately if you suspect a leak —
  go to Discord's Developer Portal → your application → Bot → Reset Token.

## Hardening suggestions

- Use Discord role-gated channels so only trusted members can send.
- Bind `dashboard.port` and the bridge ports to `127.0.0.1` if you don't want them on the LAN
  (see `ARCHITECTURE.md` § Port discipline).
- Run shunt under a dedicated, least-privilege OS user.
- Consider adding a per-user allowlist to `discord-bridge/index.ts` if you can't restrict
  channel access tightly enough.
