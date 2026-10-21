#!/usr/bin/env bash
# Update the MCP server on the VPS to the newest code on GitHub (main). Run as the app user (serp), from anywhere:
#   bash ~/SERP-Connect/deploy/vps/deploy.sh
# Steps: download new code -> install what the MCP server needs -> build -> restart -> check it answers.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PORT="${PORT:-8787}"

echo "==> 1/5 Downloading the newest code"
git fetch origin main
git merge --ff-only origin/main

echo "==> 2/5 Installing packages (MCP server only)"
pnpm install --frozen-lockfile --filter "@serp/mcp-server..."

echo "==> 3/5 Building"
pnpm --filter "@serp/mcp-server..." run build

echo "==> 4/5 Restarting"
pm2 startOrReload deploy/vps/ecosystem.config.cjs --update-env
pm2 save

echo "==> 5/5 Checking it answers"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "OK: MCP server is running ($(curl -fsS "http://127.0.0.1:${PORT}/healthz"))"
    exit 0
  fi
  sleep 1
done
echo "PROBLEM: the MCP server did not answer. Look at the log:  pm2 logs serp-mcp --lines 50" >&2
exit 1
