# Операторский протокол

## 1. Подготовка

Перед strict run:

```bash
git status --short
codex --version
node --version
./scripts/smoke-test.sh
# После первого запуска Codex: откройте /hooks и проверьте project hooks
```

Репозиторий должен быть Git repository с сохранённым base commit. Незакоммиченные product changes следует commit или stash.

## 2. Формулировка objective

Хороший objective описывает результат, а не последовательность действий:

```text
Добавить ротацию API-ключей без остановки существующих клиентов,
с миграцией данных, административным UI, аудитом и rollback-путём.
```

Слабый objective:

```text
Посмотри проект и сделай как лучше.
```

Acceptance criteria сформирует architect, но objective должен содержать продуктовый смысл и жёсткие ограничения.

## 3. Запуск

```bash
./scripts/codex-delivery run "<objective>"
```

Harness не требует API key, если Codex CLI уже авторизован обычным способом. В CI допускается отдельная официально поддерживаемая аутентификация Codex, но секрет не должен попадать в repository или run logs.

Foreground запуск пишет concise sanitized progress в stderr и финальный JSON в stdout. Для detached запуска:

```bash
./scripts/codex-delivery run "<objective>" --background
```

Команда вернёт `runId`, `pid`, `statePath`, `eventsPath` и `backgroundLogPath`, а delivery продолжится в background process.

Если при новом `run`/`resume` уже виден active delivery process в этом repository, CLI печатает notice в stderr:

```text
[codex-delivery] Notice: another Codex delivery process appears active in this repository.
  - run=<run-id> pid=<pid> mode=run status=running
    follow: ./scripts/codex-delivery logs --follow --run <run-id>
```

Отдельные runs всё ещё разрешены. Duplicate background process для того же `runId` блокируется.

## 4. Наблюдение

В другом terminal:

```bash
./scripts/codex-delivery logs --follow
./scripts/codex-delivery logs --follow --tail 30
./scripts/codex-delivery logs --follow --all
./scripts/codex-delivery review --run <run-id>
./scripts/codex-delivery review --run <run-id> --json
./scripts/codex-delivery review --run <run-id> --tui
./scripts/codex-delivery status
./scripts/codex-delivery status --json
./scripts/codex-delivery status --run <run-id> --tui
./scripts/codex-delivery tui --run <run-id>
./scripts/codex-delivery web
./scripts/codex-delivery report
```

`logs --follow` показывает тот же sanitized progress из `events.jsonl`, который foreground run пишет в stderr. Human progress/log output includes run-relative elapsed prefixes such as `[+03m14s]`; `--no-time` hides those prefixes. По умолчанию follow выводит последние 80 event records и затем новые события; `--tail <n>` меняет размер начальной истории, `--all` включает полный history dump перед follow. Normal output включает фазы, sanitized command starts, file-change counts, длину agent messages и background heartbeats, поэтому долгий agent не выглядит зависшим. Plain `logs` без `--follow` по-прежнему выводит весь event history. `review --json` строит read-only inbox для внешнего UI или ручного анализа. `status --json` возвращает machine-readable state, validation, reviews, human reviews, final result, timing/progress/ETA, background metadata and artifact paths. `tui`, `status --tui` and `review --tui` open the Ink/React TUI with Cockpit, Review, Timeline, Workspace and Diagnostics panels. `web` starts the local Vite/React operator console with the same panels, SSE live updates, and token-gated write actions. The Cockpit includes progress rails, elapsed/phase time, conservative ETA, active work, Timeline snapshot and an Intervention Queue for operator-required actions. `summary.md` обновляется после фаз, workstream, human-review и gate transitions and includes timing summary. `status` дополнительно показывает background PID, heartbeat и log path, если run был запущен через `--background`.

Текущий run ID:

```bash
cat .codex/delivery-runs/latest
```

## 5. Что происходит автоматически

1. Три read-only discovery tracks запускаются параллельно.
2. Architect создаёт contract и DAG.
3. Structural validator проверяет plan.
4. Ready writers запускаются waves до `maxParallel`.
5. Каждый writer работает в отдельном worktree.
6. Out-of-scope diff отклоняется.
7. Failed worker checks блокируют workstream только когда они отражают реальный product/test failure. Strict-only delivery helper failures, dependency installation attempts and declared checks that cannot run because the tool is unavailable are logged as non-blocking worker evidence.
8. Accepted commits интегрируются последовательно.
9. If human review approved repair for missing project dependencies, harness prepares checked-in Python/npm dependencies in the integration worktree before validation.
10. Validation commands выполняются harness.
11. Verifier доказывает каждый criterion.
12. Reviewer и security запускаются параллельно.
13. При failure создаётся bounded repair DAG. Strict harness agents return schema JSON directly and should not call interactive `delivery_*` MCP tools; the harness records their output and state transitions.

## 6. Результат accepted run

`final.json` содержит:

- integration branch;
- integration commit;
- integration worktree;
- итог quality gate;
- terminal summary.

Проверка diff:

```bash
git -C <integration-worktree> log --oneline --decorate -n 20
git -C <integration-worktree> diff <base-commit>..<integration-commit>
```

Применение:

```bash
git merge <integration-branch>
```

или:

```bash
git cherry-pick <integration-commit>
```

Выбор зависит от branch policy проекта. Harness не делает merge автоматически.

## 7. Blocked run

Причины обычно находятся в:

- `final.json`;
- последнем `quality.gate` в `events.jsonl`;
- failed criteria в `state.json`;
- findings в `results.jsonl`;
- validation logs в `commands/`.

Если причина исправима без изменения base branch, можно продолжить тот же run:

```bash
./scripts/codex-delivery review --run <run-id>
./scripts/codex-delivery review --run <run-id> --tui
./scripts/codex-delivery resume --run <run-id>
./scripts/codex-delivery resume --repo /path/to/project --run <run-id>
./scripts/codex-delivery resume --run <run-id> --background
```

`review` запускает guided terminal review только для `blocked`/`failed` runs. Он собирает failed validation commands, failed/unknown acceptance criteria и blocking reviewer/security findings, показывает action descriptions и shortcuts (`r/e/m/a`), предлагает suggested action (`repair_requested`, `environment_required`, `manual_required`, `acknowledged`) и сохраняет решения в `human-reviews.jsonl`, `artifacts/human-reviews/*.json`, `state.humanReviews` и `summary.md`. `review --tui` пишет те же durable artifacts, но открывает Cockpit/Review/Timeline/Workspace/Diagnostics без выхода из terminal UI. The Cockpit is the default for `tui` and `status --tui`: it highlights automation progress, elapsed/phase time, conservative ETA, active work, and the Intervention Queue. Durable TUI actions require confirmation: press `s` or select a save item, then `y` to save; press `R`, then `y` to start background resume. `Esc`/`n` cancels confirmation. Review keys remain `Enter`, `r/e/m/a`, `A`, `x`, and note editing with `n`; `?` toggles help. Panels are `1` Cockpit, `2` Review, `3` Timeline, `4` Workspace, `5` Diagnostics; legacy `--panel overview|events|checkpoints` aliases still work. Press `v` to cycle normal/detail/raw (`simple|verbose|extended` remain accepted). If the repository is dirty, press `4` for Workspace and `!` to explicitly allow dirty resume for this TUI session. `tui --once --no-color` renders one non-interactive frame for snapshots and tests. Missing project dependencies such as `pytest`, `tsc`, Vite or Vitest default to `repair_requested`, so pressing Enter approves Codex to fix requirements/package manifests and lets resume prepare checked-in dependencies before validation. Missing system tools, services or credentials still default to `environment_required`. Сначала вводится action, затем note; если note случайно введён в action prompt, CLI объясняет ошибку и повторяет prompt. Interactive output colorized в TTY; `--no-color` или `NO_COLOR=1` отключают ANSI. `--no-time` hides human elapsed-time rendering; `status --json` still includes timing/progress/ETA. После записи команда печатает рекомендуемый `resume --max-repairs ... --background`; если рабочее дерево грязное, отдельно печатается вариант с `--allow-dirty`.

Resume сохраняет прежний terminal result в `state.resumes` и `artifacts/resume-*.json`, архивирует failed/running workstreams перед reset и продолжает DAG от текущего integration commit. Accepted/integrated workstreams не запускаются повторно.

Если base branch нужно изменить, лучше стартовать новый run с уточнённым objective.

Остановить background process без удаления artifacts:

```bash
./scripts/codex-delivery stop --run <run-id>
```

`stop` отправляет SIGTERM process group, пишет `background.stop.requested`, затем `background.stopped` или `background.stop.pending` в `events.jsonl` и обновляет `background.json`. Сам run остаётся доступен для анализа или явного `resume`.

## 8. Interactive mode

Для работы в текущем Codex session:

1. убедиться, что project hooks доверены через `/hooks`;
2. активировать `$codex-delivery`;
3. основной thread вызывает `delivery_begin`;
4. discovery делегируется custom agents;
5. результаты сохраняются `delivery_record_result`;
6. contract и plan фиксируются MCP tools;
7. worker получает workstream и claim token;
8. verification и reviews сохраняются отдельно;
9. `delivery_accept` выполняет gate check.

Lifecycle hooks журналируют эти шаги, блокируют опасные команды и проверяют стандартные patches по active scope. Тем не менее для нескольких writable subagents безопаснее создавать отдельные Codex App chats/worktrees либо перейти на strict harness. Одновременные writers в одном рабочем каталоге не дают надёжной атрибуции.

## 9. Очистка

Удалить disposable worker worktrees и ветки:

```bash
./scripts/codex-delivery cleanup --run <id>
```

Удалить также integration worktree/branch:

```bash
./scripts/codex-delivery cleanup --run <id> --integration
```

Удалить журналы:

```bash
./scripts/codex-delivery cleanup --run <id> --integration --logs
```

Не удаляйте accepted integration branch до применения или осознанного отказа от результата.
