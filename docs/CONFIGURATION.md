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

При `false` сохраняется sanitized journal. При `true` дополнительно сохраняется raw Codex JSONL.

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
- approval: `never` внутри sandbox;
- `--dangerously-bypass-hook-trust` только для project hooks, уже поставленных и проверенных оператором вместе с harness.

Причина `workspace-write` для verifier: многие test tools создают cache/build artifacts. Disposable worktree предотвращает попадание этих изменений в integration branch.

## 5. Raw events

Включать только локально:

```bash
./scripts/codex-delivery run "..." --raw
```

Raw stream может содержать:

- полные команды;
- agent messages;
- tool arguments;
- пути;
- случайно раскрытые данные.

Не публикуйте `.codex/delivery-runs` без проверки.
