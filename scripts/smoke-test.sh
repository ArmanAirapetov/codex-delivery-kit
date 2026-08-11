#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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
