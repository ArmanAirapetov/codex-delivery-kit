# Конфигурация

## 1. Codex project config

`.codex/config.toml` задаёт предел subagent concurrency, включает lifecycle hooks и локальный MCP server:

```toml
[agents]
max_concurrent_threads_per_session = 6

[features]
hooks = true

[mcp_servers.delivery_workflow]
command = "node"
args = [".codex/delivery-kit/mcp-server.mjs"]
startup_timeout_sec = 15
tool_timeout_sec = 120
```

Это локальный STDIO server. Ошибки вида `codex_apps ... HTTP 401 ... token_expired` относятся к отдельному HTTP MCP connector в Codex account/session configuration, а не к `delivery_workflow`.

Модель намеренно не закреплена. Custom agents наследуют model текущего Codex session, если в TOML agent file не задан `model`.

Project hooks описаны в `.codex/hooks.json`. После установки их нужно просмотреть и доверить через `/hooks`; при любом изменении definition Codex запросит повторную проверку.

## 2. Custom agents

Каждый `.codex/agents/<name>.toml` задаёт:

- `name`;
- `description`;
- `model_reasoning_effort`;
- `sandbox_mode`;
- `developer_instructions`.

Для role-specific model можно добавить:

```toml
model = "<доступная Codex model>"
```

Доступность моделей зависит от текущего Codex account и версии CLI. Поэтому комплект не навязывает конкретные имена.

## 3. Harness config

`codex-delivery.config.json`:

### maxParallel

Максимум writer worktrees одной волны.

Рекомендации:

- 2: небольшой проект или дорогая модель;
- 3–4: обычный multi-component task;
- 5–6: большое число действительно независимых packages;
- выше 6: обычно растут context cost и integration overhead.

### maxRepairs

Число автоматических repair cycles. Default: 2.

Ноль означает: первая неудачная verification/review сразу блокирует run.

### timeoutMinutes

Timeout одного Codex role turn и validation command.

### retainRawEvents

При `false` сохраняется sanitized journal, per-agent `prompt.txt`, `request.json`, `response.json`, `final.json` и worker snapshots. При `true` дополнительно сохраняется raw Codex JSONL.

### keepWorkerWorktrees

По умолчанию accepted writer branch/worktree удаляется после cherry-pick. Commit остаётся в integration history. Включите для debugging.

### model и models

`model` — общий override. `models` — override по role.

```json
{
  "model": null,
  "models": {
    "explorer": "<fast-model>",
    "architect": "<strong-model>",
    "implementer": "<coding-model>",
    "verifier": "<strong-model>"
  }
}
```

Пустое/null значение использует обычную Codex configuration.

### reasoning

Role phase reasoning effort:

```json
{
  "discovery": "medium",
  "planning": "high",
  "implementation": "high",
  "verification": "high",
  "review": "high"
}
```

### discoveryTracks

Можно убрать ненужный track или добавить domain-specific read-only role.

### reviewTracks

Можно добавить performance/release/reverse track. Для каждого должен существовать логически подходящий prompt focus. Harness не требует custom agent TOML для direct `codex exec`, но одинаковые role names упрощают аналитику.

### allowedValidationPrefixes

Allowlist команд. Prefix должен быть достаточно узким. Не добавляйте общий `bash ` или `python ` без необходимости: это превращает allowlist в формальность.

Default allowlist covers common deterministic checks, including `node ...`, `npm run ...`, `npm --prefix ...`, `python -m pytest ...`, `python -m compileall ...`, `docker compose config ...`, and equivalent ecosystem test/build commands. Add project-specific prefixes only when the command is a repeatable validation check and not dependency installation, deployment, or destructive maintenance.

If an installed project still has a kit-managed older default allowlist, runtime config loading merges in newer defaults. A customized allowlist remains explicit and is not broadened automatically.

## 4. Hooks, sandbox и approvals

Interactive mode использует hooks как детерминированные guardrails:

- `PreToolUse` проверяет dangerous Bash patterns и стандартные `apply_patch` paths;
- `PostToolUse` журналирует hashes/lengths результата;
- session/subagent/stop events формируют timeline;
- полный prompt, message и tool response не копируются в журнал.

Hooks не заменяют sandbox и не считаются полной файловой изоляцией.

### Strict harness permissions

Harness всегда задаёт:

- discovery/planning: `read-only`;
- writers: `workspace-write`;
- verifier/reviewer disposable worktrees: `workspace-write`, но изменения обнаруживаются и отбрасываются;
- approvals: наследуются от текущего Codex CLI policy; harness явно задаёт sandbox mode;
- `--dangerously-bypass-hook-trust` только для project hooks, уже поставленных и проверенных оператором вместе с harness.

Причина `workspace-write` для verifier: многие test tools создают cache/build artifacts. Disposable worktree предотвращает попадание этих изменений в integration branch.

## 5. Raw events

Включать только локально:

```bash
./scripts/codex-delivery run "..." --raw
./scripts/codex-delivery run "..." --quiet
./scripts/codex-delivery run "..." --verbose
./scripts/codex-delivery run "..." --background
```

Если запускаете harness не из project root, передайте repository явно:

```bash
./scripts/codex-delivery run --repo /path/to/project "..."
./scripts/codex-delivery resume --repo /path/to/project --run <run-id>
./scripts/codex-delivery resume --repo /path/to/project --run <run-id> --background
./scripts/codex-delivery logs --repo /path/to/project --run <run-id> --follow
./scripts/codex-delivery logs --repo /path/to/project --run <run-id> --follow --tail 30
./scripts/codex-delivery logs --repo /path/to/project --run <run-id> --follow --all
./scripts/codex-delivery status --repo /path/to/project
./scripts/codex-delivery stop --repo /path/to/project --run <run-id>
```

Path-only invocation (`run /path/to/project`) считается ошибкой без objective.

`logs --follow` по умолчанию показывает последние 80 event records и затем новые события. Используйте `--tail <n>` для другого окна или `--all`, если нужен полный history перед live follow.

`--background` не меняет delivery semantics: создаются те же `state.json`, `events.jsonl`, `results.jsonl`, agent artifacts, snapshots и integration worktree. Дополнительно появляются `background.json` и `background.log`. Несколько active runs в одном repository разрешены, но один и тот же run нельзя запустить/resume в background второй раз, пока предыдущий PID жив.

Для refresh Codex authentication используйте:

```bash
codex login status
codex login
codex mcp list
codex mcp login <server-name>
```

Raw stream может содержать:

- полные команды;
- agent messages;
- tool arguments;
- пути;
- случайно раскрытые данные.

Не публикуйте `.codex/delivery-runs` без проверки.
