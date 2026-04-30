# Cleanup Diagnostics Report

Дата: 2026-04-24

## Выполненные проверки

- `rg legacy|deprecated|compat|migration` по SEAF-коду — найдено 2 релевантных места.
- `ReadLints` по измененным файлам — без ошибок.
- `node drawio-desktop/scripts/seaf-stability-smoke.mjs` — PASS.
- `bash seaf-plugin-runtime/release/runtime/build-runtime.sh` — PASS.
- `npm run release-linux-local -- --x64 --linux deb` — PASS.

## NPM диагностика зависимостей

- `npm audit --omit=dev --json`:
  - результат: **не выполнен** из-за сетевого ограничения (`Proxy connection ended before receiving CONNECT response`).
- `npm outdated --json`:
  - результат: **не выполнен** из-за сетевого ограничения (`ECONNRESET`).
- Локальный lockfile scan (без сети):
  - deprecated package entries: **6**.

## Вывод

Сборочный контур проекта зеленый.  
Полный online-аудит npm заблокирован сетевыми ограничениями окружения; remediation выполнен по lockfile-инвентарю.
