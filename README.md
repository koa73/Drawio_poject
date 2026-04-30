# Drawio Project SEAF Extensions

Этот репозиторий содержит доработки к базовому дистрибутиву draw.io для интеграции SEAF runtime, включая:
- bootstrap минимального runtime в составе инсталлятора drawio;
- обновление до полного runtime из репозитория;
- расширение меню и взаимодействие через IPC.
- schema-driven меню `SEAF -> Edit Config` для редактирования `env.yaml` через стандартные формы draw.io.
- диалог `SEAF -> Edit Config` с контент-ориентированной высотой, симметричными внутренними отступами и silent-success поведением (ошибки показываются, успешное сохранение без popup).
- кнопки в `SEAF -> Edit Config` приведены к штатному визуальному паттерну draw.io (`geBtn`/`gePrimaryBtn`), а скролл ограничен телом формы для постоянной доступности футера.
- `Edit Config` использует новый контракт полей `env.yaml`: `companyPrefix`, `inputSeafFile`, `useSameOutputFile`, `outputSeafFile`, `pluginLogLevel`.
- `Edit Config` поддерживает опциональный `helpText` в `configEditor.fields` и показывает иконку `?` с tooltip рядом с label.
- добавлена UX-логика зависимости полей: при `useSameOutputFile=true` значение `outputSeafFile` синхронизируется с `inputSeafFile` и блокируется.
- зависимости полей в `Edit Config` теперь можно описывать декларативно (`syncFrom`, `disableWhen`) в `configEditor.fields`.
- при runtime update выполняется инкрементальный merge `env.yaml` (сохранение всех локальных значений пользователя + добавление недостающих ключей из новой схемы/дефолта, без удаления пользовательских ключей).
- уровень логирования runtime вычисляется из `env.pluginLogLevel` (`none|info|debug`) с fallback к `plugin.yaml logging.*`.
- для применения runtime update сохраняется стабильная модель `restart-required`; in-place hot-reload не используется.
- добавлен режим `SEAF Interactive Terminal Demo`: интерактивный Python-скрипт запускается в настоящем TTY внутри modal terminal-окна Electron, при этом editor draw.io блокируется overlay до закрытия терминала.
- меню `SEAF` реструктурировано во вложенные подменю `P41`, `Tools`, `Examples`; demo-пункты `SEAF ...` сгруппированы в `Examples`.
- Python-скрипты выполняются через интерпретатор, заданный в `SEAF -> Edit Config` (`pythonExecutable` в `env.yaml`); поддерживается путь к бинарнику или к каталогу venv (`.venv`) с авто-резолвом.
- на первичной установке runtime пытается автоматически выбрать системный Python (`python3`, затем `python`) и сохранить его в `env.yaml`.
- зависимости из `python/requirements.txt` автоматически устанавливаются в выбранный интерпретатор; при ошибке выводится точная инструкция с командой ручной установки.
- кастомные библиотеки фигур для `More Shapes` загружаются из `seaf-plugin-runtime/conf/stencils` по конфигу `libraries.json` и обновляются через стандартный runtime update (без обязательной пересборки desktop).
- добавлен auto-event processor для стенсилов: batch-реакция на `add/remove` (и `modify` через `Edit Data -> Apply`) по правилам `seaf-plugin-runtime/conf/events.yaml` с вызовом скрытых Python handlers.
- routing событий в `events.yaml` работает по `rule.schema` в рамках `listId` с поддержкой `exact`, wildcard (`*`) и `all`, а также `execution: sync|async`.
- payload для Python handlers обогащен данными объекта: `objectId`, нормализованная `geometry` и `data` (атрибуты из `Edit Data`-модели); тот же контракт применяется для команд контекстного меню.
- примерные Python-обработчики событий пишут диагностику через stderr-протокол (`SEAF_ERROR`/`SEAF_INFO`/`SEAF_LOG`) с префиксом скрипта в `seaf-plugin.log`; INFO управляется `env.scriptLogLevel`, ERROR пишется всегда.
- добавлен обратный канал Python -> draw.io: `Response.commands[].name=updateStencilData` для обновления `data` стенсила по `pageId/objectId` в режимах `merge` и `replace`.
- добавлен метод `Response.commands[].name=ensureLayer` для create-or-get слоя по имени на странице с возвратом `layerId` в `result.payload.uiCommandResults`.
- для auto-event processor (`source=stencil_event_processor`) включено исполнение `Response.commands[]` тем же UI executor, что и для menu/system команд; это устраняет потерю `ensureLayer`/`updateStencilData` в event-сценариях.

## SEAF Extensions Tree

```text
Drawio_poject/
├─ README.md
├─ drawio-desktop/
│  ├─ src/main/electron.js
│  ├─ src/main/seaf/seafPluginService.js
│  ├─ verify-seaf-minimal-stage.cjs
│  ├─ electron-builder-linux-mac.json
│  └─ electron-builder-win.json
└─ seaf-plugin-runtime/
   ├─ plugin/seaf.plugin.js
   ├─ conf/
   │  ├─ plugin.yaml
   │  ├─ main_menu.yaml
   │  ├─ context_menu.yaml
   │  ├─ events.yaml
   │  ├─ stencils/
   │  │  ├─ libraries.json
   │  │  └─ *.xml
   │  └─ README.md
   ├─ python/scripts/
   │  ├─ README.md
   │  ├─ examples/*.py
   │  └─ lib/*
   ├─ python/requirements.txt
   ├─ runtime/version.json
   ├─ minimal-runtime/
   │  ├─ seaf.plugin.js
   │  └─ seaf_plugin/
   │     ├─ conf/plugin.yaml
   │     ├─ runtime/version.json
   │     └─ log/
   └─ release/runtime/
      ├─ build-runtime.sh
      ├─ build-minimal-runtime.sh
      └─ check-version-consistency.sh
```

## Files, Purpose, Functions

| Путь | Назначение | Ключевые функции/точки |
|---|---|---|
| `drawio-desktop/src/main/electron.js` | Bootstrap runtime, IPC маршрутизация, доступ к runtime-файлам | `ensureSeafRuntimeInstalled()`, `getSeafRuntimeDefaults()`, `getSeafRuntimeTargets()`, `rendererReq` switch |
| `drawio-desktop/src/main/seaf/seafPluginService.js` | Основная серверная логика SEAF (main-process) | `loadConfig()`, `runCommand()`, `prepareInteractiveTerminalCommand()`, `updateRuntime()`, `runNativeSshRuntimeUpdate()`, `pollJob()`, `cancelJob()` |
| `drawio-desktop/src/main/seaf/jobMetaUtils.js` | Утилиты оптимизации async-job метаданных | Ограничение размеров `stdout/stderr` в `pollJob` payload (`tail` + size) |
| `drawio-desktop/verify-seaf-minimal-stage.cjs` | Fail-fast проверка наличия minimal runtime stage перед релизной сборкой desktop | Проверка `release/out/minimal-stage` и обязательных файлов |
| `drawio-desktop/scripts/gui/seaf-terminal-smoke-main.cjs` | GUI smoke harness для проверки IPC-потока interactive terminal | Тестовый BrowserWindow + mock handlers `getSeafInteractiveTerminalSnapshot/writeSeafInteractiveTerminalInput/resizeSeafInteractiveTerminal` |
| `drawio-desktop/scripts/gui/seaf-terminal-ipc-smoke-renderer.js` | Renderer часть GUI smoke harness | Проверка доставки snapshot/data/exit событий и базовых IPC roundtrip |
| `drawio-desktop/electron-builder-linux-mac.json` | Встраивание minimal runtime в Linux/macOS пакет | `extraResources.from = ../seaf-plugin-runtime/release/out/minimal-stage` |
| `drawio-desktop/electron-builder-win.json` | Встраивание minimal runtime в Windows пакет | `extraResources.from = ../seaf-plugin-runtime/release/out/minimal-stage` |
| `seaf-plugin-runtime/plugin/seaf.plugin.js` | Full renderer plugin: меню, вызовы IPC, индикаторы, update | `registerMainMenu()`, `registerActions()`, `executeSystemUpdate()`, `pollAsyncJob()`, `detectRuntimeVersion()` |
| `seaf-plugin-runtime/conf/plugin.yaml` | Core full runtime конфигурация | `plugin.*`, `python.*`, `logging.*`, `update.*`, `includes.*` |
| `seaf-plugin-runtime/conf/main_menu.yaml` | Конфиг главного меню | Определение команд и `menu.main.*` |
| `seaf-plugin-runtime/conf/context_menu.yaml` | Конфиг контекстного меню | Overrides `menu.context.*` по `id` |
| `seaf-plugin-runtime/conf/events.yaml` | Конфиг event processor | `schemaPrefix`, `stencilLists`, `rules`, скрытые event handlers |
| `seaf-plugin-runtime/conf/stencils/libraries.json` | Конфиг SEAF библиотек фигур для `More Shapes` | `sections[]`, `entries[]`, `file` |
| `seaf-plugin-runtime/conf/env.yaml` | Глобальные переменные для Python-библиотек SEAF и user-настройки `Edit Config` | `companyPrefix`, `inputSeafFile`, `useSameOutputFile`, `outputSeafFile`, `pluginLogLevel`, `scriptLogLevel`, `pythonExecutable` |
| `seaf-plugin-runtime/conf/README.md` | Документация формата `plugin.yaml` | Описание полей и примеры |
| `seaf-plugin-runtime/python/scripts/README.md` | Документация Python-контракта скриптов | Формат root REQUEST/RESPONSE, прогресс, примеры |
| `seaf-plugin-runtime/python/scripts/examples/*.py` | Командные entrypoint-скрипты runtime | Реализация demo/примеров команд |
| `seaf-plugin-runtime/python/scripts/lib/*` | Общие Python helper-модули | `io`, `config` и reusable-утилиты для entrypoint-скриптов |
| `seaf-plugin-runtime/python/requirements.txt` | Файл зависимостей Python | Используется для автоматической установки зависимостей в выбранный интерпретатор |
| `seaf-plugin-runtime/runtime/version.json` | Версия full runtime | Поле `version` для UI/update |
| `seaf-plugin-runtime/minimal-runtime/seaf.plugin.js` | Minimal renderer plugin для bootstrap-поставки | `runSystemUpdate()`, `registerSeafMenu()`, `detectRuntimeVersion()` |
| `seaf-plugin-runtime/minimal-runtime/seaf_plugin/conf/plugin.yaml` | Minimal runtime конфиг | update-параметры, базовые настройки |
| `seaf-plugin-runtime/minimal-runtime/seaf_plugin/runtime/version.json` | Версия minimal runtime | Поле `version` |
| `seaf-plugin-runtime/release/runtime/build-runtime.sh` | Сборка full runtime и release asset | Stage: `release/out/stage`, asset: `seaf-plugin-runtime.tar.gz` |
| `seaf-plugin-runtime/release/runtime/build-minimal-runtime.sh` | Сборка minimal runtime stage | Stage: `release/out/minimal-stage` |
| `seaf-plugin-runtime/release/runtime/check-version-consistency.sh` | Проверка согласованности версий full runtime | Сверка `seaf.plugin.js` + `plugin.yaml` + `runtime/version.json` |

## Implemented Functionality Table

| Функциональность | Компонент | Где реализовано | Ключевые функции |
|---|---|---|---|
| Bootstrap минимального runtime из пакета drawio | Main-process desktop | `drawio-desktop/src/main/electron.js` | `ensureSeafRuntimeInstalled()` |
| Диагностические bootstrap-логи и причины отказа | Main-process desktop | `drawio-desktop/src/main/electron.js` | `[SEAF bootstrap] ...` |
| Idempotent перенос ключей в пользовательский runtime | Main-process desktop | `drawio-desktop/src/main/electron.js` | часть `ensureSeafRuntimeInstalled()` |
| Native update runtime по `ssh_git` | SEAF service | `drawio-desktop/src/main/seaf/seafPluginService.js` | `runNativeSshRuntimeUpdate()`, `updateRuntime()` |
| Async update runtime с процентным прогрессом | SEAF service + renderer | `seafPluginService.js`, `plugin/seaf.plugin.js`, `minimal-runtime/seaf.plugin.js` | `updateRuntime()` async, `pollSeafPluginJob`, percent indicator |
| Синхронный интерактивный terminal-режим для Python | Desktop main-process + renderer plugin + terminal window | `electron.js`, `seafPluginService.js`, `plugin/seaf.plugin.js`, `src/main/seaf/terminal-window.*` | modal terminal-window, `node-pty`, `xterm`, блокировка editor до закрытия окна |
| Smoke GUI-проверка interactive terminal IPC | Test harness (desktop scripts) | `drawio-desktop/scripts/gui/*` | `npm run test:seaf-gui`, `npm run test:seaf-gui:xvfb` |
| Финальный update UX с обязательным рестартом | Full/minimal renderer plugins | `seaf-plugin-runtime/plugin/seaf.plugin.js`, `seaf-plugin-runtime/minimal-runtime/seaf.plugin.js` | Индикатор до 100%, затем success + restart-required message без autoreload |
| No-op update без ложного restart-required | Full/minimal renderer plugins + SEAF service | `plugin/seaf.plugin.js`, `minimal-runtime/seaf.plugin.js`, `seafPluginService.js` | `payload.status=already_up_to_date` -> сообщение «Установлена актуальная версия ...», без переустановки |
| Гарантированное обновление plugin entry после restart | Renderer app bootstrap | `drawio-standalone/js/diagramly/ElectronApp.js` | cache-busting `file://...seaf.plugin.js?v=<mtime>` |
| Нормализация и дедупликация plugins settings | Renderer app bootstrap | `drawio-standalone/js/diagramly/ElectronApp.js` | Сведение `file:///.../seaf.plugin.js?...` к `seaf.plugin.js`, дедуп до `mxSettings.setPlugins()` |
| Атомарная подмена runtime с rollback | SEAF service | `drawio-desktop/src/main/seaf/seafPluginService.js` | `applyRuntimeFromExtractRoot()` |
| Системный пункт меню `Обновить плагин` | Full renderer plugin | `seaf-plugin-runtime/plugin/seaf.plugin.js` | `registerActions()`, `executeSystemUpdate()`, `registerMainMenu()` |
| Фиксированный порядок пунктов меню SEAF | Full/minimal renderer plugins | `plugin/seaf.plugin.js`, `minimal-runtime/seaf.plugin.js` | Кастомные команды -> `Обновить плагин` -> `SEAF Runtime v...` |
| Защита от устаревшего update asset | SEAF service + runtime config | `drawio-desktop/src/main/seaf/seafPluginService.js`, `*/conf/plugin.yaml` | `update.expectedMinVersion`, валидация версии архива до apply |
| Явный контракт update-статусов | SEAF service | `drawio-desktop/src/main/seaf/seafPluginService.js` | `payload.status`, `payload.requiresRestart` для `updated/already_up_to_date` |
| Разделитель между системным и кастомными пунктами меню | Full renderer plugin | `seaf-plugin-runtime/plugin/seaf.plugin.js` | `registerMainMenu()` |
| Выполнение sync/async команд runtime | Main + renderer | `seafPluginService.js`, `plugin/seaf.plugin.js` | `runCommand()`, `pollAsyncJob()` |
| Ручные/авто индикаторы и остановка задач | Main + renderer | `seafPluginService.js`, `plugin/seaf.plugin.js` | `startManualIndicator()`, `finishManualIndicator()`, `cancelJob()` |
| Определение и отображение версии runtime | Renderer plugins | `plugin/seaf.plugin.js`, `minimal-runtime/seaf.plugin.js` | `detectRuntimeVersion()`, `registerRuntimeVersionMenu()` |

## IPC Methods Table

Источник IPC-обработки: `drawio-desktop/src/main/electron.js` (`rendererReq`, `args.action`).

| Action | Обработчик | Назначение | Где вызывается |
|---|---|---|---|
| `getSeafPluginConfig` | `seafPluginService.loadConfig(args.configPath)` | Загрузка и валидация runtime конфигурации | `plugin/seaf.plugin.js`, `minimal-runtime/seaf.plugin.js` |
| `runSeafPluginCommand` | `seafPluginService.runCommand(args)` | Запуск команды runtime (sync/async) | `plugin/seaf.plugin.js` |
| `startSeafInteractiveTerminalSession` | main-process interactive terminal session manager | Запуск модального interactive terminal-окна и TTY-сессии Python | `plugin/seaf.plugin.js` |
| `getSeafInteractiveTerminalSnapshot` | main-process interactive terminal session manager | Получение текущего terminal buffer/status для terminal-window renderer | `src/main/seaf/terminal-window.js` |
| `writeSeafInteractiveTerminalInput` | main-process interactive terminal session manager | Передача пользовательского terminal input в PTY | `src/main/seaf/terminal-window.js` |
| `resizeSeafInteractiveTerminal` | main-process interactive terminal session manager | Resize terminal viewport и PTY (`cols/rows`) | `src/main/seaf/terminal-window.js` |
| `closeSeafInteractiveTerminalSession` | main-process interactive terminal session manager | Закрытие terminal-session и принудительная остановка процесса при необходимости | `src/main/seaf/terminal-window.js` |
| `reportSeafInteractiveTerminalRendererEvent` | main-process interactive terminal session manager | Структурированное логирование renderer bootstrap/snapshot ошибок terminal-окна | `src/main/seaf/terminal-window.js` |
| `getSeafEnvConfig` | `seafPluginService.getEnvConfig(args)` | Загрузка `env.yaml` и схемы полей для `Edit Config` | `plugin/seaf.plugin.js` |
| `getSeafEventConfig` | `seafPluginService.getEventConfig(args)` | Загрузка и нормализация `events.yaml` для auto-event processor | `plugin/seaf.plugin.js` |
| `saveSeafEnvConfig` | `seafPluginService.saveEnvConfig(args)` | Сохранение измененных значений в `env.yaml` | `plugin/seaf.plugin.js` |
| `selectSeafEnvFile` | `showOpenDialog(...)` | Выбор файла через системный навигатор для `filePicker` полей | `plugin/seaf.plugin.js` |
| `updateSeafPluginRuntime` | `seafPluginService.updateRuntime(args)` | Системное обновление runtime | `plugin/seaf.plugin.js`, `minimal-runtime/seaf.plugin.js` |
| `pollSeafPluginJob` | `seafPluginService.pollJob(args.jobId)` | Получение статуса async задачи | `plugin/seaf.plugin.js` |
| `cancelSeafPluginJob` | `seafPluginService.cancelJob(args.jobId)` | Отмена async задачи | `plugin/seaf.plugin.js` |
| `writeSeafPluginLog` | `seafPluginService.writeClientLog(args)` | Клиентское логирование через runtime logging policy | `plugin/seaf.plugin.js` |
| `startSeafManualIndicator` | `seafPluginService.startManualIndicator(args)` | Создание ручного индикатора | `plugin/seaf.plugin.js` |
| `finishSeafManualIndicator` | `seafPluginService.finishManualIndicator(args)` | Завершение ручного индикатора | `plugin/seaf.plugin.js` |
| `readFile` | Общий IPC `readFile(args.filename, args.encoding)` | Чтение `runtime/version.json` для отображения версии | `plugin/seaf.plugin.js`, `minimal-runtime/seaf.plugin.js` |

## Known Consistency Notes

- Единственный актуальный main-entry для desktop: `drawio-desktop/src/main/electron.js`.
- При изменении функциональности/IPC/структуры дополнения должен обновляться этот файл `README.md` в корне проекта.
- Документация `seaf-plugin-runtime/conf/README.md`, `seaf-plugin-runtime/python/scripts/README.md` и `seaf-plugin-runtime/README.md` должна обновляться синхронно с кодом.

## Stability invariants

- `env.yaml` update contract: preserve all existing user keys/values, add only missing keys from new runtime defaults/schema, keep unknown keys untouched.
- More Shapes title contract: SEAF custom section/entry labels must stay compatible with `EditorUi.getResource` (`{main: ...}` object form).
- Visibility contract: saved library selection (`respect_saved`) has priority over `enabledByDefault`.
- Init resilience contract: one failing subsystem must not silently break the whole plugin; errors are mandatory in `seaf-plugin.log`.
- Runtime update safety contract: no partial runtime/plugin state is allowed after failed apply/rename.

## Stability release checklist

- Run runtime build: `seaf-plugin-runtime/release/runtime/build-runtime.sh`.
- Run stability smoke: `node drawio-desktop/scripts/seaf-stability-smoke.mjs`.
- Run desktop GUI smoke: `cd drawio-desktop && npm run test:seaf-gui`.
- Manual UI check: `More Shapes` contains `SEAF` with `SEAF_Р41` and no `undefined`.
- Manual update check: after `SEAF -> Обновить плагин`, user values in `env.yaml` remain unchanged.

## Repository publication and upstream sync

- `seaf-plugin-runtime` is intentionally excluded from this repository and is maintained in a separate repository.
- Clone this project normally:
  - `git clone <origin-url>`

### Remotes

```bash
git remote add origin <your-github-drawio-poject-url>
git remote add upstream-desktop https://github.com/jgraph/drawio-desktop.git
git remote add upstream-drawio https://github.com/jgraph/drawio.git
git fetch --all --prune
```

### Sync from drawio-desktop

```bash
git checkout master
git fetch upstream-desktop
git merge upstream-desktop/master
```

### Sync from drawio via subtree

```bash
git checkout master
git fetch upstream-drawio
git subtree pull --prefix drawio-standalone upstream-drawio master --squash
```

Detailed operational guide (including conflict recovery):
- `docs/upstream-sync-regulation.md`
