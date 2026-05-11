#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "[shunt] missing .env — copy .env.example and set DISCORD_BOT_TOKEN" >&2
  exit 1
fi
if [ ! -f shunt.yaml ]; then
  echo "[shunt] missing shunt.yaml — copy shunt.example.yaml and edit it" >&2
  exit 1
fi

set -a; source .env; set +a

echo "[shunt] starting all services..."
echo "[shunt]   session manager: CC sessions + health monitoring"
echo "[shunt]   dashboard:       web UI on :${DASHBOARD_PORT:-9000}"
echo "[shunt]   discord bridges:  per-project Discord integration"
echo ""

# Session manager orchestrates everything:
# - Launches dashboard
# - Launches per-project discord bridges
# - Launches per-project CC sessions in terminal multiplexer
# - Monitors health, version updates, auto-restarts
exec bun run session-manager/index.ts start
