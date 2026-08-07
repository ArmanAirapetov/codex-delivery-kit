# Codex Delivery Kit v1

Набор конфигурации и исполняемый harness для управляемой разработки через OpenAI Codex. Он переносит подход `contract-first → scoped DAG → parallel implementation → sequential integration → independent verification → review → bounded repair` в Codex CLI.

## Зачем нужен отдельный harness

Codex поддерживает `AGENTS.md`, project-scoped custom agents, skills, MCP, subagents, lifecycle hooks и машинный режим `codex exec --json`. Комплект использует нативные hooks для журналирования жизненного цикла, блокировки опасных команд и проверки `apply_patch` относительно активного workstream. Hooks являются сильным guardrail, но не полной границей: отдельные специализированные tool paths могут обходить общий hook path, а несколько writers в одном рабочем каталоге всё равно не получают физической изоляции.

Поэтому комплект имеет два режима:

| Режим | Назначение | Уровень контроля |
|---|---|---|
| **Interactive native** | Работа в текущем Codex CLI/App/IDE с subagents | MCP хранит FSM и результаты; hooks журналируют lifecycle, блокируют опасные команды и проверяют стандартные patches; общий worktree остаётся ограничением |
| **Strict harness** | Автономный или аудируемый delivery-run | Отдельный Git worktree для каждого writer, фактическая проверка changed paths, последовательная интеграция и JSONL-телеметрия |

## Основной поток

```text
parallel read-only discovery
        ↓
acceptance contract
        ↓
scoped workstream DAG
        ↓
parallel writers in isolated Git worktrees
        ↓
sequential cherry-pick integration
        ↓
repository validation commands
        ↓
independent criterion-level verification
        ↓
parallel correctness + security review
        ↓
acceptance OR bounded repair DAG OR block
```

## Состав

```text
AGENTS.md
.codex/
├── config.toml
├── hooks.json
├── agents/*.toml
└── delivery-kit/
    ├── cli.mjs
    ├── hook.mjs
    ├── mcp-server.mjs
    ├── analyze-runs.mjs
    └── lib/*.mjs
.agents/skills/codex-delivery/
├── SKILL.md
└── references/system-summary.md
delivery/schemas/*.schema.json
scripts/
├── codex-delivery
├── install.sh
├── validate.mjs
├── core-smoke.mjs
├── mcp-smoke.mjs
├── hook-smoke.mjs
├── install-smoke.mjs
├── analyzer-smoke.mjs
├── workflow-smoke.mjs
└── smoke-test.sh
docs/
├── SYSTEM.md
├── WORKFLOW.md
├── OBSERVABILITY.md
├── HOOKS.md
├── RESULTS.md
├── CONFIGURATION.md
├── TESTING.md
└── MIGRATION.md
```

## Установка

```bash
unzip codex-delivery-kit-v1.zip
cd codex-delivery-kit
./scripts/install.sh /path/to/project
```

Установщик:

- делает резервную копию затрагиваемых файлов;
- добавляет инструкции в `AGENTS.md`;
- устанавливает custom agents и skill;
- добавляет MCP server в `.codex/config.toml`, не удаляя существующую конфигурацию;
- объединяет `.codex/hooks.json` с существующими hooks и сохраняет резервную копию;
- копирует harness, схемы, анализатор и пример конфигурации;
- добавляет runtime state в `.gitignore`.

Требования:

- Git;
- Node.js 18+;
- установленный и авторизованный Codex CLI;
- чистое состояние репозитория для strict run.

## Strict harness

Запуск из обычного shell, не из активного Codex turn:

```bash
./scripts/codex-delivery run \
  "Добавить API-key authentication, rotation, migration, UI и tests"
```

Команду нужно запускать из установленного project root. Если запускаете wrapper из другого каталога, укажите target repository явно:

```bash
./scripts/codex-delivery run --repo /path/to/project "Исправить issue"
./scripts/codex-delivery run /path/to/project "Исправить issue"
```

Один путь без objective не запускает delivery-run:

```bash
./scripts/codex-delivery run /path/to/project
```

Strict harness стартует только из чистого Git состояния. После установки сначала commit/stash установленную конфигурацию или осознанно добавьте `--allow-dirty`.

Полезные параметры:

```bash
./scripts/codex-delivery run "..." --max-parallel 4 --max-repairs 2
./scripts/codex-delivery run --repo /path/to/project "..."
./scripts/codex-delivery run "..." --model <available-codex-model>
./scripts/codex-delivery run "..." --raw
./scripts/codex-delivery resume --run <run-id>
./scripts/codex-delivery run "..." --background
./scripts/codex-delivery resume --run <run-id> --background
./scripts/codex-delivery logs --follow --run <run-id>
./scripts/codex-delivery logs --follow --tail 30 --run <run-id>
./scripts/codex-delivery logs --follow --all --run <run-id>
./scripts/codex-delivery status
./scripts/codex-delivery report
./scripts/codex-delivery stop --run <run-id>
./scripts/codex-delivery cleanup --integration
```

Foreground `run`/`resume` печатает краткий sanitized progress в stderr: фазы, agents, waves, validation, integration, reviews и итог. Финальный JSON остаётся в stdout. `--quiet` отключает progress, `--verbose` добавляет sanitized artifact paths, duration и token totals.

Background режим сразу возвращает `runId`, `pid` и пути к артефактам, а сам delivery продолжает detached process:

```bash
./scripts/codex-delivery run "..." --background
./scripts/codex-delivery logs --follow --run <run-id>
./scripts/codex-delivery stop --run <run-id>
```

`logs --follow` по умолчанию выводит последние 80 event records и затем live progress; `--tail <n>` задаёт другое окно, `--all` печатает всю историю перед follow. Normal output показывает sanitized command starts, file-change counts, agent message lengths и background heartbeats, поэтому долгий agent не выглядит зависшим. Plain `logs` без `--follow` остаётся forensic full-history view.

Несколько background runs в одном repository разрешены; каждый run получает собственные worktrees и run artifacts. Для одного и того же run повторный background resume отклоняется, если прежний background process ещё жив.
Если в repository уже есть active delivery process, новый `run`/`resume` печатает notice в stderr с `runId`, `pid` и командой `logs --follow`. Это предупреждение не блокирует отдельный новый run, но same-run duplicate background resume остаётся ошибкой.

Результат не применяется автоматически к текущей ветке. Accepted run оставляет отдельную integration branch и worktree. После проверки оператор может выполнить merge/cherry-pick обычными средствами Git.

## Interactive native mode

В Codex активируйте skill:

```text
$codex-delivery
```

или попросите:

```text
Use the codex-delivery workflow for this task.
```

Основной thread использует `delivery_*` MCP tools и делегирует задачи агентам из `.codex/agents/`.

После установки откройте `/hooks` и подтвердите доверие к project-local hooks. Этот режим перехватывает стандартные Bash/apply_patch/MCP/local-function calls, но не может физически разделить subagents в общем worktree и не гарантирует покрытие специализированных tool paths. Для строгой атрибуции используйте harness.

Если Codex при startup пишет `codex_apps ... token_expired`, это отдельный first-party HTTP MCP connector, а не локальный `delivery_workflow` server из этого комплекта. Проверьте авторизацию:

```bash
codex login status
codex login
codex mcp list
codex mcp login codex_apps
```

Для полного сброса CLI credentials используйте `codex logout`, затем `codex login`.

## Артефакты запуска

```text
.codex/delivery-runs/<run-id>/
├── state.json
├── background.json
├── background.log
├── events.jsonl
├── results.jsonl
├── summary.md
├── final.json
├── artifacts/
│   ├── discovery.json
│   ├── plan.json
│   ├── repair-plan-N.json
│   └── workstreams/<id>/snapshots/<stamp>/
│       ├── snapshot.json
│       ├── source.tgz
│       ├── status.txt
│       ├── tracked.diff
│       └── untracked-files.txt
├── agents/<step>/
│   ├── prompt.txt
│   ├── request.json
│   ├── response.json
│   ├── final.json
│   ├── stderr.log
│   └── raw.jsonl       # только при --raw
└── commands/*.log
```

`events.jsonl` отвечает на вопрос **что происходило**, а `results.jsonl` — **что важного было установлено, решено или доказано**.
`resume` продолжает тот же run ID: failed/running workstreams архивируются в snapshots, предыдущий terminal result сохраняется в `state.resumes` и `artifacts/resume-*.json`, затем DAG продолжается от текущего integration commit.

## Анализ

```bash
node .codex/delivery-kit/analyze-runs.mjs --run <run-id>
node .codex/delivery-kit/analyze-runs.mjs --run <run-id> --json
```

Метрики включают lead time, фактический параллелизм, repair iterations, validation failures, proof ratio, findings по severity, usage tokens и распределение затрат по ролям.

## Проверка комплекта

```bash
./scripts/smoke-test.sh
```

Набор тестов отдельно проверяет MCP и lifecycle hooks. End-to-end smoke test использует fake Codex CLI, реальный временный Git-репозиторий, две параллельные writer-ветки, cherry-pick integration, validation, verification и review. Сетевые/API-вызовы не нужны.

Подробная архитектура: [docs/SYSTEM.md](docs/SYSTEM.md).
