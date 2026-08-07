# Модель главных результатов

## 1. Проблема обычного agent log

Большой transcript содержит:

- промежуточные гипотезы;
- команды;
- повторения;
- stack traces;
- временные планы;
- исправленные ошибки.

Он полезен для forensic анализа, но плохо отвечает на вопросы:

- что система узнала;
- какое решение принято;
- что осталось неизвестным;
- какой результат создал workstream;
- чем доказан acceptance criterion.

Поэтому главные результаты фиксируются отдельно.

## 2. Формат

```json
{
  "id": "RES-a1b2c3d4",
  "at": "2026-08-07T...Z",
  "runId": "...",
  "phase": "implementation",
  "kind": "outcome",
  "title": "Rotation endpoint implemented",
  "summary": "Added atomic key replacement with grace-period validation.",
  "details": [
    "Old and new hashes remain valid during configured grace period."
  ],
  "paths": [
    "server/auth/rotation.py",
    "server/auth/tests/test_rotation.py"
  ],
  "criterionIds": ["AC-2", "AC-4"],
  "workstreamId": "W2",
  "role": "implementer",
  "confidence": "high",
  "tags": ["auth", "rotation"]
}
```

## 3. Kinds

### discovery

Подтверждённый факт о текущей системе, который влияет на план.

Хорошо:

```text
Token lookup используется из двух entry points: REST middleware и websocket handshake.
```

Плохо:

```text
Посмотрел auth.
```

### decision

Выбранное решение и основание.

```text
Выбрана additive migration, потому что zero-downtime deployment требует совместимости old/new app versions.
```

### assumption

Условие, которое пока не доказано.

```text
Предполагается, что external clients не зависят от порядка JSON fields.
```

Assumption не должна маскироваться как факт.

### risk

Возможная проблема, требующая mitigation или наблюдения.

```text
Grace period увеличивает окно компрометации украденного старого ключа.
```

### finding

Конкретный обнаруженный дефект или review issue.

```text
Concurrent rotations могут потерять update из-за read-modify-write без lock.
```

### evidence

Наблюдение, непосредственно доказывающее или опровергающее criterion.

```text
Integration test test_old_key_expires_after_grace passed against PostgreSQL.
```

### outcome

Созданный результат workstream.

```text
Добавлены schema, migration, endpoint и tests для key rotation.
```

## 4. Критерий полезности

Результат следует записывать, если он изменит хотя бы одно из:

- план;
- архитектурное решение;
- risk assessment;
- дальнейшую реализацию;
- verification verdict;
- решение принять/заблокировать run;
- понимание следующего инженера.

Не следует записывать:

- каждую прочитанную функцию;
- каждую выполненную команду;
- рассуждение без вывода;
- повтор final summary;
- большие фрагменты source;
- секреты.

## 5. Связи

Желательная цепочка:

```text
objective
  ↓
AC-N
  ↓
workstream W-N
  ↓
outcome/evidence results
  ↓
verifier criterion status
  ↓
quality gate
```

Чем больше semantic results имеют `workstreamId` и `criterionIds`, тем легче анализировать стоимость принятого результата, а не стоимость генерации.

## 6. Confidence

- `high`: прямое наблюдение, test, diff или authoritative contract;
- `medium`: сильный вывод, но не полное runtime доказательство;
- `low`: гипотеза, требующая проверки.

Высокая confidence не заменяет verification evidence.

## 7. Итоговый набор

Для accepted run желательно иметь минимум:

- discovery result для каждого ключевого affected area;
- decisions для существенных архитектурных выборов;
- risks и assumptions, если они существовали;
- outcome каждого required workstream;
- evidence каждого AC;
- review findings или positive evidence;
- terminal final record.
