# Cleanup Policy (Legacy + Deprecated Dependencies)

## 1. Цель

Снижать техдолг без регресса runtime/update UX.

## 2. Политика legacy-кода

- Legacy migration-shim допускается только если:
  - подтверждена необходимость совместимости со старыми install-layout;
  - нет безопасного одношагового удаления.
- Удаление legacy-шима разрешено только после gate:
  - smoke PASS;
  - runtime build PASS;
  - linux deb build PASS;
  - подтверждено отсутствие критичных регрессий.

## 3. Политика deprecated dependencies

- Приоритет устранения:
  1. memory leak / security-risk deprecated packages;
  2. deprecated в frequently executed paths;
  3. low-risk nested deprecated.
- Обновления только батчами 3-10 пакетов.
- После каждого батча обязательны валидации:
  - `test:seaf-stability`
  - runtime build
  - linux x64 deb build

## 4. Исключения

- Если remediation блокируется внешней сетью/прокси, допускается lockfile-based audit.
- Исключение документируется в `docs/cleanup-diagnostics.md`.

## 5. Gate на удаление legacy-кода

- Использовать `npm run gate:legacy-removal` перед удалением legacy-блоков.
- Gate проверяет, что валидационный статус актуален и все обязательные проверки отмечены как PASS.
