# Наблюдаемость и аудит

## 1. Два независимых журнала

Система намеренно разделяет:

```text
events.jsonl  = техническая хронология
results.jsonl = смысловые результаты
```

Если хранить всё в одном потоке, важные решения теряются среди тысяч command/tool events. Если хранить только semantic summary, невозможно восстановить duration, failure rate и токены.

## 2. events.jsonl

Каждая строка — самостоятельный JSON object.

Основные группы:

### Workflow

- `workflow.started`;
- `workflow.plan.approved`;
- `workflow.checkpoint`;
- `workflow.accepted`;
- `workflow.blocked`;
- `workflow.error`.

### Codex harness

- `codex.run.started`;
- sanitized `thread.started`, `turn.started`, `item.*`, `turn.completed`, `turn.failed`, `error`;
- `codex.run.completed`;
- `codex.result.invalid`.

### Native lifecycle hooks

- `codex.hook.session-start/session-end`;
- `codex.hook.user-prompt-submit`;
- `codex.hook.subagent-start/subagent-stop`;
- `codex.hook.pre-tool-use/post-tool-use`;
- `codex.hook.stop`.

Hook events contain hashes and lengths rather than full prompts/messages/outputs. `PreToolUse` additionally records the policy decision, extracted patch paths and active workstream scopes.

### Workstreams

- `workstream.wave.started/completed/failed`;
- `workstream.started/completed/failed`.

### Integration

- `integration.created`;
- `integration.started`;
- `integration.conflict`;
- `integration.completed`.

### Quality

- `validation.started/completed/rejected`;
- `inspection.started/completed`;
- `inspection.mutations.discarded`;
- `quality.gate`;
- `repair.plan.approved`.

### Background execution

- `background.started`;
- `background.heartbeat`;
- `background.stop.requested`;
- `background.stop.pending`;
- `background.stopped`;
- `background.exited`.

## 3. Live CLI progress

Foreground `run` и `resume` рендерят concise sanitized progress в stderr из того же event stream. Финальный structured JSON остаётся в stdout.

```bash
./scripts/codex-delivery run "..." --verbose
./scripts/codex-delivery run "..." --quiet
./scripts/codex-delivery logs --follow --run <run-id>
./scripts/codex-delivery logs --follow --tail 30 --run <run-id>
./scripts/codex-delivery logs --follow --all --run <run-id>
```

`logs` читает `events.jsonl` и применяет тот же renderer. Plain `logs` выводит весь history; `logs --follow` по умолчанию начинает с последних 80 event records, чтобы длинные resume chains не скрывали current process. `--tail <n>` задаёт другое окно, `--all` возвращает полный history перед follow. Normal output показывает high-level phases, sanitized command starts, file-change counts, agent message lengths and background heartbeats, so a long-running agent does not look silent. It still does not include prompt text, agent message text or raw JSONL. `--verbose` adds sanitized paths, command completions, duration and token totals.

## 4. Sanitized Codex and hook records

Для command item сохраняются:

```json
{
  "type": "item.completed",
  "item": {
    "id": "...",
    "type": "command_execution",
    "status": "completed",
    "commandHash": "sha256...",
    "commandPreview": "pytest tests/auth -q",
    "cwd": "..."
  }
}
```

Для agent message:

```json
{
  "item": {
    "type": "agent_message",
    "messageHash": "sha256...",
    "messageLength": 1842
  }
}
```

Сам text не копируется в central event journal. Strict harness сохраняет полный prompt и request/response metadata отдельно в `agents/<step>/prompt.txt`, `request.json`, `response.json`; structured final output хранится в `agents/<step>/final.json`. Native interactive hooks применяют hash/length принцип: prompt/message/tool-response сохраняются только как SHA-256 и length; короткий очищенный preview допускается только для команды, необходимой для диагностики policy.

Worker generations дополнительно архивируются в `artifacts/workstreams/<id>/snapshots/<stamp>/`. Snapshot содержит status, changed paths, diffs, `worker-final.json` и `source.tgz` без типичных dependency/build директорий (`node_modules`, `dist`, `web/node_modules`, `web/dist`).

Background runs дополнительно пишут:

- `background.json`: PID, mode, status, timestamps, heartbeat, exit/signal metadata;
- `background.log`: stdout/stderr detached child process, включая foreground-style progress и final JSON/error text.

## 5. Usage

`turn.completed` usage агрегируется в `codex.run.completed`:

```json
{
  "usage": {
    "input_tokens": 24763,
    "cached_input_tokens": 24448,
    "output_tokens": 122,
    "reasoning_output_tokens": 0
  }
}
```

Analyzer группирует usage по role.

Денежная стоимость не вычисляется автоматически, потому что:

- Codex может использовать ChatGPT-managed credits;
- модели и тарифы меняются;
- billing unit не всегда эквивалентна публичной API price.

Для экономики следует добавить собственный versioned price table и явно обозначать результат как estimate.

## 6. results.jsonl

Подробно описан в [RESULTS.md](RESULTS.md). Типовые kinds:

- `discovery`;
- `decision`;
- `assumption`;
- `risk`;
- `finding`;
- `evidence`;
- `outcome`.

## 7. Метрики

`analyze-runs.mjs` рассчитывает:

### Throughput

- lead time;
- число Codex runs;
- duration по roles;
- completed/integrated workstreams;
- repair iterations.

### Parallelism

- maximum concurrent workstreams;
- average concurrent workstreams;
- intervals по writer.

### Quality

- validation pass/fail;
- criteria proven/failed/unknown;
- findings по severity;
- final status.

### Evidence discipline

- result count;
- results linked to workstreams;
- results linked to criteria;
- result coverage каждого workstream.

### Resource consumption

- input/cached/output/reasoning tokens;
- usage по role.

## 8. Практический анализ bottleneck

Примеры интерпретации:

- высокий planning duration и мало repairs: возможно, дорогой planning окупается;
- низкий parallelism при большом числе независимых scopes: planner недоиспользует fan-out;
- высокий repair rate: слабые criteria, плохой discovery или слишком широкие workstreams;
- много results без criterion linkage: журнал превращается в заметки, а не evidence;
- высокий reviewer token share без findings: review prompts или model tier избыточны;
- частые out-of-scope failures: scope слишком узкий либо worker prompt плохо локализован;
- validation passes, но verifier unknown: tests не доказывают product behavior.

## 9. Retention

Рекомендуемый режим:

- `state.json`, `results.jsonl`, `summary.md`, `final.json`: хранить вместе с engineering records;
- sanitized `events.jsonl`: хранить для анализа runs;
- `background.json` и `background.log`: хранить вместе с run artifacts, если использовался `--background`;
- `.codex/hook-events/`: fallback telemetry sessions, не привязанных к delivery run; хранить короче либо периодически импортировать;
- command logs: срок зависит от конфиденциальности проекта;
- raw JSONL: удалять быстро или не включать;
- worktrees: удалять после merge/отказа;
- integration branch: хранить согласно branch retention policy.
