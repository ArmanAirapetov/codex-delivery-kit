#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_INPUT="${1:-}"

if [[ -z "$TARGET_INPUT" || "$TARGET_INPUT" == "-h" || "$TARGET_INPUT" == "--help" ]]; then
  cat <<'USAGE'
Usage: ./scripts/install.sh /path/to/git-project

Installs Codex Delivery Kit into an existing Git repository. Existing affected
files are copied to .codex-delivery-backups/<timestamp>/ before modification.
USAGE
  [[ -n "$TARGET_INPUT" ]] && exit 0 || exit 2
fi

for command in git node python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "[error] Required command is missing: $command" >&2; exit 1; }
done

TARGET="$(cd -- "$TARGET_INPUT" && pwd)"
REPO="$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO" || "$REPO" != "$TARGET" ]]; then
  echo "[error] Target must be the root of an existing Git repository: $TARGET" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$REPO/.codex-delivery-backups/$STAMP"
mkdir -p "$BACKUP"

backup_path() {
  local relative="$1"
  if [[ -e "$REPO/$relative" || -L "$REPO/$relative" ]]; then
    mkdir -p "$BACKUP/$(dirname -- "$relative")"
    cp -a -- "$REPO/$relative" "$BACKUP/$relative"
  fi
}

copy_replace() {
  local relative="$1"
  backup_path "$relative"
  rm -rf -- "$REPO/$relative"
  mkdir -p "$REPO/$(dirname -- "$relative")"
  cp -a -- "$SOURCE_ROOT/$relative" "$REPO/$relative"
}

copy_if_absent() {
  local relative="$1"
  if [[ ! -e "$REPO/$relative" ]]; then
    mkdir -p "$REPO/$(dirname -- "$relative")"
    cp -a -- "$SOURCE_ROOT/$relative" "$REPO/$relative"
  fi
}

# Runtime and schemas are versioned as one unit.
copy_replace ".codex/delivery-kit"
copy_replace "delivery/schemas"

# Project custom agents. Preserve unrelated agent files.
mkdir -p "$REPO/.codex/agents"
for source in "$SOURCE_ROOT"/.codex/agents/*.toml; do
  relative=".codex/agents/$(basename -- "$source")"
  backup_path "$relative"
  cp -a -- "$source" "$REPO/$relative"
done

# Repo-scoped skill.
copy_replace ".agents/skills/codex-delivery"

# Operator scripts.
mkdir -p "$REPO/scripts"
for name in codex-delivery analyze-runs.mjs install.sh validate.mjs core-smoke.mjs mcp-smoke.mjs hook-smoke.mjs install-smoke.mjs analyzer-smoke.mjs workflow-smoke.mjs smoke-test.sh; do
  relative="scripts/$name"
  backup_path "$relative"
  cp -a -- "$SOURCE_ROOT/$relative" "$REPO/$relative"
done
chmod +x "$REPO/scripts/codex-delivery" "$REPO/scripts/install.sh" "$REPO/scripts/smoke-test.sh"

# Keep an existing project-specific runtime config; install defaults only when absent.
copy_if_absent "codex-delivery.config.json"
if [[ -e "$REPO/codex-delivery.config.json" && -e "$SOURCE_ROOT/codex-delivery.config.json" ]]; then
  cp -a -- "$SOURCE_ROOT/codex-delivery.config.json" "$REPO/codex-delivery.config.example.json"
fi

# Documentation lives in a namespaced directory to avoid replacing project docs.
DOC_TARGET="docs/codex-delivery"
backup_path "$DOC_TARGET"
rm -rf -- "$REPO/$DOC_TARGET"
mkdir -p "$REPO/$DOC_TARGET"
cp -a -- "$SOURCE_ROOT/docs/." "$REPO/$DOC_TARGET/"
cp -a -- "$SOURCE_ROOT/README.md" "$REPO/$DOC_TARGET/README.md"
sed -i 's#docs/SYSTEM.md#SYSTEM.md#g' "$REPO/$DOC_TARGET/README.md"

# Merge AGENTS.md using an idempotent marked section.
AGENTS_BEGIN='<!-- CODEX DELIVERY KIT BEGIN -->'
AGENTS_END='<!-- CODEX DELIVERY KIT END -->'
backup_path "AGENTS.md"
python3 - "$REPO/AGENTS.md" "$SOURCE_ROOT/AGENTS.md" "$AGENTS_BEGIN" "$AGENTS_END" <<'PY'
from pathlib import Path
import sys

target, source, begin, end = map(str, sys.argv[1:])
target_path = Path(target)
existing = target_path.read_text(encoding="utf-8") if target_path.exists() else ""
body = Path(source).read_text(encoding="utf-8").strip()
section = f"{begin}\n{body}\n{end}"
if begin in existing and end in existing:
    before, rest = existing.split(begin, 1)
    _, after = rest.split(end, 1)
    merged = before.rstrip() + "\n\n" + section + after
else:
    merged = existing.rstrip() + ("\n\n" if existing.strip() else "") + section + "\n"
target_path.write_text(merged, encoding="utf-8")
PY

# Merge project hooks without deleting hooks owned by the repository.
backup_path ".codex/hooks.json"
mkdir -p "$REPO/.codex"
python3 - "$REPO/.codex/hooks.json" "$SOURCE_ROOT/.codex/hooks.json" <<'PY'
from pathlib import Path
import json, sys

target_path, source_path = map(Path, sys.argv[1:])
source = json.loads(source_path.read_text(encoding="utf-8"))
if target_path.exists():
    target = json.loads(target_path.read_text(encoding="utf-8"))
else:
    target = {"description": "Project lifecycle hooks.", "hooks": {}}
target.setdefault("hooks", {})
for event, groups in source.get("hooks", {}).items():
    dest = target["hooks"].setdefault(event, [])
    existing = {json.dumps(group, sort_keys=True, separators=(",", ":")) for group in dest}
    for group in groups:
        key = json.dumps(group, sort_keys=True, separators=(",", ":"))
        if key not in existing:
            dest.append(group)
            existing.add(key)
target_path.write_text(json.dumps(target, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY

# Merge only missing Codex config tables. Existing project choices win.
backup_path ".codex/config.toml"
CONFIG="$REPO/.codex/config.toml"
touch "$CONFIG"
if ! grep -Eq '^\[agents\][[:space:]]*$' "$CONFIG"; then
  cat >> "$CONFIG" <<'EOF_CONFIG'

[agents]
max_concurrent_threads_per_session = 6
EOF_CONFIG
fi
if ! grep -Eq '^\[features\][[:space:]]*$' "$CONFIG"; then
  cat >> "$CONFIG" <<'EOF_CONFIG'

[features]
hooks = true
EOF_CONFIG
fi
if ! grep -Eq '^\[mcp_servers\.delivery_workflow\][[:space:]]*$' "$CONFIG"; then
  cat >> "$CONFIG" <<'EOF_CONFIG'

[mcp_servers.delivery_workflow]
command = "node"
args = [".codex/delivery-kit/mcp-server.mjs"]
startup_timeout_sec = 15
tool_timeout_sec = 120
EOF_CONFIG
fi

# Runtime data and external worktree directories must never be committed.
backup_path ".gitignore"
touch "$REPO/.gitignore"
GITIGNORE_BEGIN='# CODEX DELIVERY KIT BEGIN'
GITIGNORE_END='# CODEX DELIVERY KIT END'
python3 - "$REPO/.gitignore" "$GITIGNORE_BEGIN" "$GITIGNORE_END" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1]); begin = sys.argv[2]; end = sys.argv[3]
text = path.read_text(encoding="utf-8") if path.exists() else ""
block = "\n".join([
    begin,
    ".codex/delivery-runs/",
    ".codex/hook-events/",
    ".codex-delivery-backups/",
    ".codex-delivery-worktrees/",
    end,
])
if begin in text and end in text:
    before, rest = text.split(begin, 1)
    _, after = rest.split(end, 1)
    text = before.rstrip() + "\n" + block + after
else:
    text = text.rstrip() + ("\n\n" if text.strip() else "") + block + "\n"
path.write_text(text, encoding="utf-8")
PY

node "$SOURCE_ROOT/scripts/validate.mjs" >/dev/null

echo "[ok] Codex Delivery Kit installed into: $REPO"
echo "[ok] Backup created at: $BACKUP"
echo "[next] Review and trust project hooks with /hooks in Codex."
echo "[next] Commit the installed configuration before using strict worktrees."
echo "[next] Run: ./scripts/codex-delivery run \"<objective>\""
