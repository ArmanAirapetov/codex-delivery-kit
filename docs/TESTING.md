# Тестирование комплекта

## 1. Уровни

### Syntax validation

`node --check` для всех `.mjs`, JSON parse для schemas/config и TOML parse через Python `tomllib`.

### Core smoke

Проверяет:

- DAG topological order;
- cycle rejection;
- overlap ordering;
- glob scope matching;
- ready workstreams;
- legal state transitions.

### Hook smoke

Проверяет lifecycle hook как отдельный процесс: разрешённый patch внутри scope, блокировку out-of-scope patch, блокировку destructive Bash и sanitized PostToolUse event.

### MCP smoke

Запускает stdio MCP server, выполняет `initialize`, `tools/list`, `delivery_begin`, contract и plan calls в временном Git repository.

### Installer smoke

Дважды устанавливает комплект в временный repository и проверяет backup/merge/idempotency для `AGENTS.md`, `config.toml`, `hooks.json` и `.gitignore`.

### Analyzer smoke

Создаёт synthetic run и проверяет:

- token aggregation;
- concurrent interval calculation;
- proof metrics;
- result linkage.

### TUI smoke

Проверяет dependency-free terminal UI without a real terminal:

- pure Overview, Events, Checkpoints and Review rendering;
- color/no-color rendering paths;
- keyboard reducer for panels, movement, decisions and notes;
- non-TTY rejection;
- `status --tui`, `tui --panel events` and `review --tui`;
- alternate-screen enter/restore and raw-mode cleanup;
- durable human-review artifact persistence from the TUI save action.

### Workflow smoke

Полный offline test:

1. создаёт временный Git repository;
2. устанавливает fake `codex` binary;
3. запускает настоящий `cli.mjs run`;
4. fake Codex возвращает schema-conformant discovery/plan/results;
5. два writer worktrees изменяют разные files параллельно;
6. harness проверяет scopes и commits;
7. integration cherry-pick объединяет commits;
8. реальный Node validation script проверяет integrated files;
9. fake verifier доказывает criteria;
10. два reviews approve;
11. analyzer проверяет telemetry;
12. worktrees очищаются.

Этот test не доказывает качество реальной модели, но доказывает механику orchestration и audit pipeline.

## 2. Запуск

```bash
./scripts/smoke-test.sh
```

Отдельно:

```bash
node scripts/validate.mjs
node scripts/core-smoke.mjs
node scripts/mcp-smoke.mjs
node scripts/hook-smoke.mjs
node scripts/install-smoke.mjs
node scripts/analyzer-smoke.mjs
node scripts/review-smoke.mjs
node scripts/tui-smoke.mjs
node scripts/workflow-smoke.mjs
```

## 3. Live acceptance test

После установки в disposable repository рекомендуется реальный небольшой run:

```bash
./scripts/codex-delivery run \
  "Добавить команду version, unit test и README example; не менять другие функции"
```

Проверить:

- plan scopes адекватны;
- writer branches действительно параллельны;
- `events.jsonl` содержит Codex events и usage;
- `results.jsonl` содержит outcomes/evidence;
- integration branch проходит checks;
- current branch не изменён.

## 4. Compatibility

Codex CLI развивается быстро. После обновления CLI нужно повторить smoke tests и live disposable run. Особое внимание:

- флагам `codex exec`;
- JSONL event field names;
- JSON Schema output behavior;
- project config/custom agents schema;
- MCP protocol compatibility;
- lifecycle hook event/input/output schema and trust behavior;
- sandbox semantics.

Parser намеренно игнорирует неизвестные event fields и сохраняет базовый type/status/usage, но изменение CLI flags потребует обновления runner.
