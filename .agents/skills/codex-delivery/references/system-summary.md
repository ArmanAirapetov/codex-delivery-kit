# System summary

The kit has two execution layers:

1. **Codex-native interactive layer** — AGENTS.md, project custom agents, the delivery skill, lifecycle hooks, and a local MCP state server. Hooks log lifecycle/tool metadata, block dangerous commands, and scope-check standard apply_patch calls. They remain guardrails rather than complete isolation because specialized tool paths may opt out and all interactive writers share one worktree.
2. **External strict harness** — a Node.js controller around `codex exec --json`. It creates one Git worktree per writer, parses Codex JSONL events, validates changed paths, commits accepted workstreams, cherry-picks them in dependency waves, runs validation commands, and launches disposable independent verifier/reviewer worktrees.

Run artifacts live under `.codex/delivery-runs/<run-id>/`. Worker worktrees live outside the repository under a sibling `.codex-delivery-worktrees/` directory.
