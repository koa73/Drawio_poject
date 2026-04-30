# Dependency Upgrade Batches

Дата: 2026-04-24

## Batch 1 (high impact, low blast radius)

- Цель: убрать `inflight`/`rimraf@2` через обновление родительских пакетов.
- Шаги:
  1. обновить direct dependencies, которые тянут старые tree;
  2. обновить lockfile;
  3. прогнать smoke/build.

## Batch 2 (glob chains)

- Цель: убрать `glob@7.x` из основных цепочек.
- Шаги:
  1. обновить родителей с `glob` как transitives;
  2. проверить, что paths/glob behavior не регрессировал;
  3. прогнать release build.

## Batch 3 (low priority cleanup)

- `lodash.isequal` -> `node:util isDeepStrictEqual` (где применимо).
- `boolean` и остальные deprecated nested — по факту обновления родителей.

## Журнал изменений (template)

| Date | Batch | Packages | Result | Risks/Notes |
|---|---|---|---|---|
| 2026-04-24 | planning | N/A | prepared | network limits for online audit |

## Execution status

- `batch-upgrades` в этом проходе выполнен как **controlled no-op**:
  - подготовлен список батчей,
  - подготовлена валидация и gate,
  - фактическое обновление пакетов отложено из-за нестабильного сетевого доступа к npm registry (`ECONNRESET` / proxy CONNECT reset).
