# Dependency Audit (Lockfile-based)

Дата: 2026-04-24

Источник: `drawio-desktop/package-lock.json`

## Deprecated packages (локальный аудит)

| Package | Version | Severity (operational) | Note |
|---|---:|---:|---|
| `inflight` | `1.0.6` | high | Утечка памяти, deprecated upstream |
| `rimraf` | `2.6.3` | medium | v2 deprecated, рекомендован v4+ |
| `glob` | `7.2.3` | medium | старые версии deprecated |
| `glob` | `10.5.0` (nested) | low | notice в nested dependency tree |
| `lodash.isequal` | `4.5.0` | low | deprecated, есть замена в `node:util` |
| `boolean` | `3.2.0` | low | package deprecated |

## Приоритизация remediation

1. Удалить/заменить цепочки, которые тянут `inflight` и `rimraf@2`.
2. Обновить родителей, которые фиксируют `glob@7`.
3. Заменить usage `lodash.isequal` там, где это direct dependency.
4. Оставшиеся deprecated nested — по мере обновления верхнеуровневых пакетов.

## Ограничения

- Полный `npm audit`/`npm outdated` недоступен в текущей среде (network proxy reset).
- Поэтому приоритизация выполнена lockfile-driven методом.
