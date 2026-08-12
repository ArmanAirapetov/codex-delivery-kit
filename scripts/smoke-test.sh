#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error("smoke-test requires Node.js 22+"); process.exit(1); }'
if [[ ! -d .codex/delivery-kit/node_modules/ink ]]; then
  echo "[error] Missing TUI runtime dependencies. Run: npm ci --prefix .codex/delivery-kit" >&2
  exit 1
fi

node scripts/validate.mjs
node scripts/core-smoke.mjs
node scripts/mcp-smoke.mjs
node scripts/hook-smoke.mjs
node scripts/install-smoke.mjs
node scripts/analyzer-smoke.mjs
node scripts/review-smoke.mjs
node scripts/tui-smoke.mjs
node scripts/workflow-smoke.mjs

echo "smoke-test: ALL OK"
