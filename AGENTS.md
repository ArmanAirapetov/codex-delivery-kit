# Codex Delivery Kit project instructions

## Operating modes

Use the smallest process that safely fits the task:

- **quick** — one narrow change, direct implementation and focused checks;
- **build** — ordinary iterative engineering inside one Codex thread;
- **delivery** — large, risky, cross-component, migration, security, release, or explicitly auditable work.

Activate the `codex-delivery` skill for delivery mode. Do not impose the full delivery process on trivial edits.

## Delivery invariant

A delivery task is complete only when:

1. the objective is translated into explicit acceptance criteria;
2. implementation is divided into a valid dependency graph with owned writable scopes;
3. independent work is parallelized and overlapping work is ordered;
4. each writer records material outcomes and checks;
5. the integrated result passes repository validation;
6. an independent verifier proves every criterion;
7. independent review has no unresolved critical, high, or medium finding;
8. the run is accepted explicitly or blocked with a concrete reason.

## Native interactive mode

The `delivery_workflow` MCP server exposes persisted `delivery_*` tools. The main thread acts as a read-only orchestrator and delegates bounded work to project agents in `.codex/agents/`.

Interactive mode records state and validates claims, criteria, DAG shape, declared paths, checks, verification, and acceptance. Project hooks log lifecycle and tool metadata, block high-risk commands, and reject standard apply_patch edits outside active scopes. Hooks are guardrails rather than a complete sandbox: some specialized tool paths can opt out, and simultaneous writers still share one working tree. Use the external harness for hard isolation and diff attribution.

## Strict harness mode

For unattended or high-assurance execution, run from a normal shell outside an active Codex session:

```bash
node .codex/delivery-kit/cli.mjs run "<objective>"
```

The harness runs Codex through `codex exec --json`, creates isolated Git worktrees, rejects changed paths outside each declared scope, integrates commits sequentially, runs validation, launches independent verification and review, and persists sanitized telemetry.

Do not start the harness recursively from inside a Codex turn unless the operator explicitly requests nested Codex processes.

## Engineering rules

- Inspect before editing.
- Keep public contracts, data migrations, and cross-component semantics explicit.
- Prefer objective tests and executable checks over narrative confidence.
- Do not weaken tests or acceptance criteria to make a run pass.
- Never store credentials, private keys, full prompts containing secrets, or raw reasoning in delivery result records.
- Treat `.codex/delivery-runs/` as workflow state, not product source.
- Keep deployment and destructive operations outside unattended delivery validation.
