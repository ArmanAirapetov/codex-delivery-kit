# Миграция с OpenCode Delivery Kit

## 1. Что сохраняется концептуально

- objective acceptance contract;
- read-only discovery fan-out;
- scoped workstream DAG;
- независимые writers;
- последовательная интеграция;
- criterion-level verification;
- parallel review tracks;
- bounded repair;
- `events.jsonl` и `results.jsonl`;
- offline analytics.

## 2. Что меняется технически

| OpenCode | Codex |
|---|---|
| project plugin hooks | Codex lifecycle hooks + MCP + external harness |
| OpenCode task agents | Codex custom agents/subagents |
| plugin edit interception | `PreToolUse` guardrails in interactive mode; Git worktree diff validation in strict mode |
| plugin compaction hook | `SessionStart` after compact + persisted state + explicit `delivery_status` |
| OpenCode event payloads | `codex exec --json` JSONL |
| shared worktree scopes | isolated worktree per writer |
| plugin workflow tools | MCP `delivery_*` tools |

## 3. Рекомендуемый переход

1. Сохранить OpenCode kit отдельно; оба инструмента могут сосуществовать.
2. Установить Codex kit в repository.
3. Проверить merge `.codex/config.toml`, `.codex/hooks.json` и `AGENTS.md`; подтвердить hooks через `/hooks`.
4. Настроить role models только после проверки доступных Codex models.
5. Адаптировать validation allowlist.
6. Выполнить smoke tests.
7. Провести один небольшой real run.
8. Сравнить метрики accepted task, а не только tokens/lines generated.

## 4. Совместное использование

Не запускайте OpenCode strict run и Codex strict run одновременно против одной base branch и одних target paths. Оба создают собственное состояние и branches, но могут конкурировать за external resources, tests, database fixtures и developer attention.

Run directories различаются:

- OpenCode: `.opencode/state/runs/...`;
- Codex: `.codex/delivery-runs/...`.

Git branch prefixes также различаются.
