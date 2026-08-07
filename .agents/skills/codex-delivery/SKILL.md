---
name: codex-delivery
description: Run a contract-first, multi-agent software delivery workflow with parallel bounded workstreams, independent verification, review, repair gates, persistent results, and auditable logs. Use for large features, migrations, security-sensitive changes, cross-component work, or when the user explicitly requests an auditable delivery run. Do not use for trivial local edits.
---

# Codex Delivery Workflow

## Choose the execution surface

Use **interactive mode** while the user wants to steer the work in the current Codex session. Use the `delivery_*` MCP tools, project-scoped custom agents, and trusted project lifecycle hooks. Hooks provide telemetry and guard standard edits, but do not replace isolated worktrees.

Use the **external harness** when the task must run unattended, writers require hard Git worktree isolation, changed paths must be enforced, or detailed JSONL telemetry is required. The operator launches it from a normal shell:

```bash
node .codex/delivery-kit/cli.mjs run "<objective>"
```

Do not invoke the external harness recursively from an active Codex turn unless the operator explicitly asks for nested Codex processes.

## Interactive protocol

1. Confirm the project hooks are trusted when Codex reports pending hook review, then call `delivery_begin` immediately with the exact objective.
2. Delegate independent read-only discovery in parallel to `explorer`, `test_analyst`, and `risk_analyst` as relevant.
3. Persist material discoveries, decisions, assumptions, risks, findings, and evidence with `delivery_record_result`.
4. Ask `architect` to synthesize objective acceptance criteria, non-goals, safe validation commands, and a scoped workstream DAG.
5. Call `delivery_define_contract`, then `delivery_approve_plan`.
6. Delegate every ready independent workstream in parallel to its configured role. Pass only its exact task, scope, criteria, dependencies, and required checks.
7. A worker calls `delivery_claim` before editing and keeps the returned claim token.
8. A worker edits only its declared scope, runs checks, records material results, and calls `delivery_complete` with every changed path and check.
9. When all required workstreams are complete, ask `verifier` to test the actual integrated state and prove every criterion. Record it with `delivery_record_verification`.
10. Run `reviewer` and `security` in parallel when relevant. Record each with `delivery_record_review`.
11. Accept only through `delivery_accept`. If evidence is incomplete or repair limits are exhausted, call `delivery_block`.

## Parallelism rules

- Parallelize read-only exploration broadly but keep each assignment bounded.
- Parallelize writers only when their declared writable scopes do not overlap and dependencies are satisfied.
- Order overlapping scopes through dependencies.
- Keep architecture decisions, public contracts, database schema changes, integration, verification, and release decisions sequential.
- Prefer three or four strong bounded agents over a large speculative swarm.

## Result discipline

Record a result only when it answers one of these questions:

- What did we learn that changes execution?
- Which decision was made and why?
- Which assumption remains unproven?
- Which risk or defect was found?
- Which evidence proves a criterion?
- Which concrete outcome did a workstream produce?

Use concise summaries, repository-relative paths, criterion IDs, confidence, and tags. Never record secrets, full source files, raw prompts, hidden reasoning, or verbose command output.

## Recovery

After interruption, compaction, or uncertainty, call `delivery_status`. Persisted state is authoritative. Do not recreate the plan or duplicate a workstream while a valid run exists.

Read `references/system-summary.md` for the architecture and enforcement boundaries.
