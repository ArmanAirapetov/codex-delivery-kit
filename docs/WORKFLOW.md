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

## 4. Наблюдение

В другом terminal:

```bash
./scripts/codex-delivery status
./scripts/codex-delivery report
```

`summary.md` обновляется после фаз, workstream и gate transitions.

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
7. Accepted commits интегрируются последовательно.
8. Validation commands выполняются harness.
9. Verifier доказывает каждый criterion.
10. Reviewer и security запускаются параллельно.
11. При failure создаётся bounded repair DAG.

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

После ручного решения можно запустить новый run с уточнённым objective. Resume текущего automated run пока намеренно не реализован: новый base commit и новый audit trail проще доказать, чем частично восстановленную process tree.

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
