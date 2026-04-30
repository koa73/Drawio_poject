# Cleanup Legacy Inventory

Дата: 2026-04-24

## Найденные legacy-артефакты (SEAF/runtime)

- `drawio-desktop/src/main/seaf/seafPluginService.js`
  - `cleanupLegacyNestedRuntime(...)` удаляет старые пути:
    - `seaf_plugin/seaf_plugin`
    - `seaf_plugin/seaf.plugin.js`
  - Статус: **оставлено осознанно** как migration-shim для старых раскладок runtime.

- `seaf-plugin-runtime/plugin/seaf.plugin.js`
  - Комментарий про backward compatibility для success payload.
  - Статус: **оставлено**, низкий риск.

## Не относится к SEAF cleanup scope

- legacy/deprecated элементы внутри `drawio-standalone` и upstream/minified assets.
- deprecated npm notice в lockfile (обрабатывается отдельным dependency remediation).

## Решение

1. Legacy cleanup в `seafPluginService` не удалять до подтверждения нулевого срабатывания в 2 релизных циклах.
2. После сбора статистики удалить блок и зафиксировать в release notes.
