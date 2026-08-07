# Codex Delivery Kit — архитектура системы

## 1. Цель

Система превращает работу с Codex из последовательного диалога в управляемый delivery pipeline. Она не пытается максимизировать количество сгенерированного кода. Оптимизируемая величина — скорость получения интегрированного результата, который:

- соответствует зафиксированному контракту;
- прошёл объективные проверки;
- независимо верифицирован;
- не содержит известных блокирующих дефектов;
- оставляет пригодный для анализа журнал.

Базовый итеративный цикл сохраняется:

```text
plan → implement → test → repair
```

но запускается одновременно внутри нескольких независимых workstream и объединяется через последовательные quality gates.

## 2. Почему реализация отличается от OpenCode

OpenCode Delivery Kit строился вокруг project-local plugin hooks. Codex предоставляет другой, но уже достаточно полный набор нативных точек расширения:

- `AGENTS.md` формирует иерархию инструкций;
- `.codex/agents/*.toml` определяет custom subagents;
- `.agents/skills/*/SKILL.md` хранит повторяемый workflow;
- `.codex/hooks.json` подключает lifecycle hooks до и после локальных tools, при старте/остановке sessions и subagents;
- MCP добавляет типизированные workflow tools и persisted FSM;
- `codex exec --json` выдаёт поток машинных событий;
- Git worktrees физически изолируют независимые изменения.

Из этого следует разделение на два слоя.

## 3. Слои системы

### 3.1 Native interactive layer

```text
Codex main thread
    ├── AGENTS.md
    ├── codex-delivery skill
    ├── project custom agents
    ├── lifecycle hooks
    └── delivery_workflow MCP server
```

Назначение:

- управляемая работа с человеком в текущем session;
- прозрачный fan-out subagents;
- фиксация acceptance criteria, DAG, claims, results, verification и reviews;
- восстановление после compaction через persisted state.

Контроль в этом слое распределён:

- MCP хранит acceptance contract, DAG, claims, semantic results и quality gates;
- `PreToolUse` блокирует опасные Bash-команды и проверяет стандартные `apply_patch` paths относительно активного scope;
- `PostToolUse`, session/subagent/stop hooks записывают очищенную телеметрию;
- `SessionStart` возвращает модели краткий контекст активного run.

Ограничение остаётся принципиальным: hooks являются guardrail, а не полной sandbox. Некоторые специализированные tool paths могут не использовать общий hook path; Bash mutation невозможно всегда статически сопоставить с файлами; subagents в interactive mode делят один worktree. Поэтому строгая атрибуция обеспечивается только внешним harness.


### 3.2 Lifecycle hook layer

`.codex/hooks.json` подключает единый `.codex/delivery-kit/hook.mjs` к событиям:

- `SessionStart` и `SessionEnd`;
- `UserPromptSubmit`;
- `SubagentStart` и `SubagentStop`;
- `PreToolUse` и `PostToolUse`;
- `Stop`.

Hook не сохраняет полный prompt, assistant message, tool input или tool response. Он пишет hashes, длины, tool name, session/turn/workstream identifiers, извлечённые patch paths и решение policy. Для `apply_patch` путь блокируется до выполнения, если он не входит в scope активного workstream. Для Bash до выполнения блокируются только однозначно опасные шаблоны; остальные команды логируются и остаются под sandbox/rules и последующей Git-проверкой.

Полный event/policy contract описан в [HOOKS.md](HOOKS.md).

Project-local hooks требуют доверия. Оператор должен открыть `/hooks` после установки и проверить точные definitions. Strict harness передаёт Codex флаг обхода hook-trust только потому, что запускает комплект, уже проверенный оператором, в изолированных worktrees.

### 3.3 Strict external harness

```text
operator shell
    ↓
.codex/delivery-kit/cli.mjs
    ├── codex exec --json
    ├── Git worktree controller
    ├── scope validator
    ├── integration controller
    ├── validation runner
    ├── verifier/reviewer launcher
    └── event/result persistence
```

Назначение:

- автономные runs;
- жёсткая изоляция writers;
- проверяемая атрибуция diff к workstream;
- стабильный структурированный output;
- последующий количественный анализ.

## 4. Компоненты strict harness

### 4.1 Orchestrator

`cli.mjs` является детерминированным control plane. Модель не определяет допустимость переходов самостоятельно. Harness:

1. создаёт run;
2. запускает discovery tracks;
3. валидирует план;
4. вычисляет ready workstreams;
5. создаёт worktrees;
6. запускает writers;
7. проверяет фактический diff;
8. интегрирует commits;
9. запускает validation;
10. выполняет verification/review;
11. принимает, ремонтирует или блокирует run.

### 4.2 Codex runner

`lib/codex-runner.mjs` запускает:

```bash
codex exec \
  --json \
  --ephemeral \
  --dangerously-bypass-hook-trust \
  --sandbox <read-only|workspace-write> \
  --ask-for-approval never \
  --cd <worktree> \
  --output-schema <schema> \
  --output-last-message <file> \
  -
```

Prompt передаётся через stdin. Финальное сообщение обязано соответствовать JSON Schema. JSONL stdout разбирается по мере поступления.

`--ephemeral` используется потому, что долгосрочное состояние хранит сам harness, а не история Codex thread. Это снижает зависимость от resume semantics и предотвращает накопление лишних локальных sessions.

### 4.3 Git worktree controller

Для каждого ready writer:

```text
integration HEAD at start of wave
    ├── branch/worktree W1
    ├── branch/worktree W2
    └── branch/worktree W3
```

Все workstreams одной волны стартуют от одинакового integration commit. После завершения accepted commits последовательно cherry-pick в integration worktree.

Зависимый workstream стартует только в следующей волне и уже видит интегрированные результаты dependencies.

Преимущества:

- writers физически не редактируют один working directory;
- конфликт не скрывается общей файловой системой;
- diff каждого writer однозначно определяется его branch;
- downstream workstream получает консистентную integrated base.

### 4.4 Scope validator

Planner объявляет для workstream:

```json
{
  "id": "W1",
  "scope": ["server/auth/**", "server/migrations/0042_*.py"]
}
```

После Codex turn harness получает фактический список:

```bash
git diff --name-only HEAD
git diff --cached --name-only HEAD
git ls-files --others --exclude-standard
```

Каждый path проверяется против scope. Любой out-of-scope path делает workstream failed; commit не создаётся.

Это важное отличие от проверки final narrative: доверяется Git state, а не утверждение модели.

### 4.5 Plan validator

План отклоняется, если:

- отсутствуют acceptance criteria или workstreams;
- ID повторяются или имеют неверный формат;
- dependency ссылается на неизвестный ID;
- graph циклический;
- criterion ID неизвестен;
- required criterion не покрыт required workstream;
- потенциально пересекающиеся scopes не dependency-ordered.

Overlap detector консервативен: лучше лишняя последовательность, чем nondeterministic conflict.

### 4.6 Integration controller

Accepted worker commit cherry-pick выполняется строго последовательно. При конфликте запускается `integrator` в текущем integration worktree.

Integrator обязан:

- разрешить только существующий conflict;
- сохранить intents обеих сторон;
- выполнить `git cherry-pick --continue`;
- зафиксировать resolved paths и checks.

Если conflict остаётся, cherry-pick abort, run блокируется.

### 4.7 Validation runner

Validation commands предлагает architect, но harness не запускает произвольный shell. Команда должна:

- начинаться с разрешённого prefix;
- не содержать shell metacharacters и redirections;
- не включать destructive/elevation patterns.

Примеры разрешённых классов:

- `pytest`, `python -m pytest`;
- `npm test`, `npm run ...`, `pnpm`, `yarn`, `bun`;
- `cargo test/check/clippy`;
- `go test`, `go vet`;
- `./gradlew`, `mvn`, `dotnet test`;
- project-local `node scripts/...`, `./scripts/...`.

Deployment, flashing, database production migrations, `sudo`, `rm -rf`, pipe-to-shell и внешние destructive actions не допускаются.

### 4.8 Independent verification

Verifier получает disposable worktree от integration commit. Он может запускать безопасные проверки, но любые его изменения отбрасываются.

Для каждого criterion обязательна запись:

```json
{
  "id": "AC-3",
  "status": "proven | failed | unknown",
  "evidence": ["..."],
  "paths": ["..."],
  "commands": ["..."]
}
```

Acceptance запрещён, если хотя бы один criterion не `proven`.

### 4.9 Independent reviews

По умолчанию параллельно выполняются:

- `reviewer`: correctness, regressions, compatibility, maintainability, test gaps;
- `security`: trust boundaries, auth, secrets, injection, unsafe defaults.

Review worktrees disposable. Critical/high/medium finding блокирует acceptance и передаётся repair planner.

### 4.10 Bounded repair

Quality gate failure не возвращает управление человеку немедленно. До `maxRepairs` architect создаёт минимальный repair DAG на основе конкретных:

- failed/unknown criteria;
- failed validation commands;
- critical/high/medium findings.

Repair workstreams запускаются от текущего integration commit, проходят ту же scope validation и интеграцию. Затем validation, verification и reviews выполняются заново.

## 5. State machine

```text
new
 ↓
discovery
 ↓
planning
 ↓
implementation
 ↓
integration
 ↓
verification
 ↓
review ───────────────→ accepted
  │
  └→ repair → integration → verification → review
  │
  └───────────────────→ blocked
```

`failed` зарезервирован для внутренней невозможности сохранить корректное состояние; пользовательский недоказанный результат обычно завершается `blocked`.

## 6. Workstream lifecycle

```text
pending
  ↓ dependencies satisfied
ready
  ↓ worktree created
running
  ↓ valid structured result + checks + in-scope diff
completed
  ↓ commit cherry-picked
integrated
```

Аварийный terminal status: `failed`.

## 7. Acceptance gate

Run accepted только при одновременном выполнении условий:

```text
all required workstreams integrated
AND every validation command passed
AND verifier verdict == passed
AND every criterion == proven
AND every review verdict == approved
AND no critical/high/medium finding
```

Модель не может изменить этот boolean rule своим final text.

## 8. Repository memory

Состояние вынесено из conversational context:

- objective и contract — `state.json`;
- discovery/plan/repair — `artifacts/*.json`;
- technical chronology — `events.jsonl`;
- semantic knowledge — `results.jsonl`;
- current readable status — `summary.md`;
- terminal decision — `final.json`.

Это позволяет продолжать анализ после завершения session, сравнивать runs и менять модели без потери методологии.

## 9. Безопасность

### 9.1 Что система не сохраняет по умолчанию

- raw hidden reasoning;
- полные prompts;
- полный agent message text;
- полный stdout всех Codex items;
- environment variables;
- credential files.

### 9.2 Что сохраняется

- sanitized event metadata;
- command preview и SHA-256;
- changed paths;
- duration/status;
- usage counters;
- structured final role output;
- validation logs с best-effort redaction.

`--raw` сохраняет исходный Codex JSONL и должен использоваться только в доверенном закрытом окружении.

### 9.3 Sandbox

Read-only roles запускаются в `read-only`. Writers — в `workspace-write` внутри disposable worktree. Harness не использует `danger-full-access`.

### 9.4 Dirty repository

По умолчанию запуск запрещён при незакоммиченных изменениях. `--allow-dirty` существует для осознанного исключения, но снижает воспроизводимость base commit и не рекомендуется.

## 10. Ограничения

- Scope validation выполняется после Codex turn, а не до каждой записи. Изменение вне scope успевает произойти только внутри disposable worktree и затем отклоняется.
- Система не является OS/container security boundary.
- Validation allowlist требует адаптации под нестандартные build commands.
- Planner всё ещё может предложить плохую декомпозицию; детерминированный validator ловит структурные, но не все семантические ошибки.
- Слишком мелкая декомпозиция увеличивает стоимость discovery/context и integration overhead.
- Strict run не применяет integration branch в текущую ветку автоматически.
- Usage events содержат токены, но не гарантируют денежную стоимость для ChatGPT-managed Codex. Cost model можно добавить отдельно по фактическому provider billing.

## 11. Рекомендуемая область применения

Strict harness оправдан для:

- изменений в нескольких сервисах;
- auth/security;
- миграций данных;
- OTA/release tooling;
- firmware/reverse-engineering automation;
- публичных API;
- изменений с высокой стоимостью регрессии;
- задач, где требуется последующий анализ эффективности моделей.

Для маленького локального исправления обычный Codex thread быстрее и дешевле.
