# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from v1.0.0 onward.

## [v0.1.0] — 2026-05-11 — Initial public release

- Per-project Claude Code sessions bridged to one Discord channel each
- Web dashboard aggregating every project's fakechat stream with live typing indicators
- Multiplexer abstraction supporting zellij, tmux, and screen
- Session resume via `claude --continue` when prior sessions are detected on disk
- Rolling restart across projects when `claude --version` changes
- Cross-source message visibility — Discord, web, and TUI turns all mirror to every viewer
- Pinned Discord status embed with uptime, message count, and health
- Unified service orchestration via `session-manager` CLI (`start | stop | restart | status | logs`)

[v0.1.0]: https://github.com/MagicForest99/shunt/releases/tag/v0.1.0
