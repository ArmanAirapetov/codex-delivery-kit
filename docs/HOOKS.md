# Lifecycle hooks и guardrails

## 1. Назначение

`.codex/hooks.json` подключает один детерминированный обработчик:

```text
.codex/delivery-kit/hook.mjs
```

Он решает три задачи:

1. формирует timeline интерактивных Codex sessions и subagents;
2. не допускает часть опасных операций до их выполнения;
3. связывает стандартные file patches с активным delivery workstream.

Hook не заменяет Git worktree, sandbox, rules, tests или code review. Его задача — раннее обнаружение и регистрация ошибок, которые можно определить детерминированно.

## 2. Подключённые события

| Event | Что фиксируется | Управляющее действие |
|---|---|---|
| `SessionStart` | session, model, source, active run | добавляет краткий workflow context |
| `UserPromptSubmit` | hash и length prompt | не сохраняет prompt |
| `SubagentStart` | agent ID/type, turn | только журналирование |
| `PreToolUse` | tool, input hash, patch paths, active scope | может deny command/patch |
| `PostToolUse` | tool, response hash/length | только журналирование |
| `SubagentStop` | agent ID/type, message hash/length | только журналирование |
| `Stop` | message hash/length | только журналирование |
| `SessionEnd` | end reason | закрывающая запись |

## 3. Привязка к run

Приоритет выбора журнала:

1. `CODEX_DELIVERY_RUN_ID` — strict harness передаёт ID явно;
2. `.codex/delivery-runs/latest-interactive` — незавершённый interactive run;
3. `.codex/hook-events/<session-id>.jsonl` — обычная Codex session вне delivery flow.

Terminal interactive run (`accepted`, `blocked`, `failed`) больше не получает события следующих sessions.

Strict harness также передаёт:

```text
CODEX_DELIVERY_ROOT
CODEX_DELIVERY_ROLE
CODEX_DELIVERY_WORKSTREAM
```

Поэтому события writer можно однозначно связать с run и workstream даже при работе в отдельном Git worktree.

## 4. Scope enforcement

Для стандартного `apply_patch` handler извлекает пути из заголовков:

```text
*** Add File: ...
*** Update File: ...
*** Delete File: ...
*** Move to File: ...
```

В strict run разрешён scope workstream из `CODEX_DELIVERY_WORKSTREAM`.

В interactive run разрешено объединение scopes всех workstreams со статусом `running`. Если writer не вызвал `delivery_claim`, patch блокируется. Во время discovery, planning, verification и review patches также блокируются.

Patch отклоняется до выполнения, когда:

- workstream неизвестен;
- нет активного claim;
- path не соответствует scope;
- paths невозможно извлечь из нестандартного patch format.

Это не отменяет последующую проверку фактического Git diff в strict harness. Hook проверяет намерение до tool call; harness проверяет итоговое состояние после turn.

## 5. Bash policy

Hook блокирует только однозначно опасные patterns, например:

- recursive force deletion корня, текущего/родительского каталога, home или wildcard;
- `git reset --hard`;
- destructive `git clean`;
- force push;
- formatting/wiping filesystem;
- raw write в `/dev/*`;
- shutdown/reboot;
- pipe downloaded content directly to shell.

Обычная Bash-команда не блокируется только потому, что может изменить файл: надёжно вычислить side effects произвольной shell program невозможно. При активном workstream модель получает reminder о разрешённом scope, затем итоговый diff проверяет harness.

Production deployment, flashing, secret rotation и другие внешние необратимые действия не должны входить в unattended delivery flow даже при отсутствии совпадения с pattern.

## 6. Данные и приватность

По умолчанию hook не сохраняет:

- полный user prompt;
- полный assistant/subagent message;
- полный tool input;
- полный tool response;
- reasoning;
- secrets.

Сохраняются:

- SHA-256;
- length;
- очищенный короткий command preview;
- tool/event identifiers;
- patch paths;
- policy decision и reason;
- run/session/turn/workstream metadata.

Полный raw Codex JSONL возможен только в strict harness с явным `--raw` и имеет отдельную retention policy.

## 7. Trust model

Project-local command hooks исполняются только после review/trust в Codex. После установки:

```text
/hooks
```

Нужно проверить:

- источник `.codex/hooks.json`;
- точную команду запуска;
- путь `.codex/delivery-kit/hook.mjs`;
- события и matchers;
- отсутствие неизвестных handlers после merge с существующим project config.

Изменение hook definition меняет его hash и требует повторного доверия.

Strict harness использует `--dangerously-bypass-hook-trust`, потому что оператор запускает уже проверенный versioned комплект неинтерактивно. Этот флаг нельзя использовать для неизвестных repository hooks.

## 8. Границы

Hook coverage не является полной security boundary:

- отдельный специализированный tool path может не использовать общий hook path;
- `PostToolUse` не может отменить уже выполненный side effect;
- Bash side effects нельзя полностью определить статически;
- interactive subagents делят filesystem;
- hook process сам зависит от доступности Node.js и корректности project trust.

Поэтому уровни контроля выстроены последовательно:

```text
instructions
→ hook preflight
→ Codex sandbox/rules
→ isolated worktree (strict mode)
→ actual Git diff scope validation
→ tests
→ independent verification/review
→ human merge decision
```
