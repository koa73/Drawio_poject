

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
- добавлен режим интерактивного терминала для Python: скрипт с `execution.mode: interactive_terminal` запускается в TTY внутри modal terminal-окна Electron, при этом editor draw.io блокируется overlay до закрытия терминала (демо-скрипты остаются в `seaf-plugin-runtime/python/scripts/examples/`; в поставочном `main_menu.yaml` подключается только **Edit Config**).
- в главном меню **SEAF** в ship-конфиге остаётся пункт **Edit Config**; демо-команды из каталога `examples/` не регистрируются в `main_menu.yaml` (их можно запускать локально с нужным `PYTHONPATH`).
- в подменю **SEAF -> P41** реализованы `Export` и `Import`: Export формирует SEAF YAML, Import читает `inputSeafFile` (файл/каталог), сопоставляет `schema+OID` и обновляет данные стенсилов на всех страницах без изменения `schema`/`OID`.
- Python-скрипты выполняются через интерпретатор, заданный в `SEAF -> Edit Config` (`pythonExecutable` в `env.yaml`); поддерживается путь к бинарнику или к каталогу venv (`.venv`) с авто-резолвом.
- на первичной установке runtime пытается автоматически выбрать системный Python (`python3`, затем `python`) и сохранить его в `env.yaml`.
- зависимости из `python/requirements.txt` автоматически устанавливаются в выбранный интерпретатор; при ошибке выводится точная инструкция с командой ручной установки.
- кастомные библиотеки фигур для `More Shapes` загружаются из `seaf-plugin-runtime/conf/stencils` по конфигу `libraries.json` и обновляются через стандартный runtime update (без обязательной пересборки desktop).
- добавлен auto-event processor для стенсилов: batch-реакция на `add/remove/reparent`, `modify` (через `Edit Data -> Apply`) и edge-операции `connect/disconnect` по правилам `seaf-plugin-runtime/conf/events.yaml` с вызовом скрытых Python handlers.
- для `connect/disconnect` event pipeline нормализует terminal edge к ближайшему schema-bearing стенсилу (а не только к raw terminal `mxCell`), поэтому `seafStencilNetworkConnectionSync` стабилен для grouped stencils и не зависит от контекстного меню `seafEditData`.
- для ошибок auto-event processor действует правило: всегда логировать, показывать popup только при явном маркере `payload.errorPolicy.userVisible=true` в ответе handler.
- routing событий в `events.yaml` работает по `rule.schema` в рамках `listId` с поддержкой `exact`, wildcard (`*`) и опционально `schema: all`, а также `execution: sync|async`.
- для схем `seaf.company.ta.services.dcs` и `seaf.company.ta.services.dc_offices` в `events.yaml` заданы exact-правила: `add` через `seafStencilAllAdd`, `modify` через `seafStencilDataMirrorModify` (`python/scripts/events/data_mirror.py`) для синхронизации данных объектов с одинаковым `OID` на всех страницах текущей диаграммы; перед зеркалированием patch выравнивает пары атрибутов **`title`/`label`** (общий модуль `python/scripts/lib/events/title_label_sync.py`; точечное отключение — `sync_title_with_label: false` в `conf/stencils/config.yaml`). В payload `modify` для стенсилов с `schema` под префиксом событий в `dataBefore`/`dataAfter` включается **`label`**, а правка подписи на схеме (без сессии Edit Data) может эмитить тот же `modify` — см. `seaf-plugin-runtime/CHANGELOG.md` 0.5.35. Для остальных `seaf.company.ta.*` в wildcard-правиле зарегистрирован `modify` → `seafStencilLabelTitleSync` (`events/label_title.py`): при расхождении второе поле дописывается через `updateStencilDataBulk` с `suppressStencilEvents: true`, чтобы не зациклить stencil `modify`. Отдельный Python handler для stencil `remove` не регистрируется (события удаления не уходят в скрипты). lifecycle snapshot-сессии Edit Data завершается отложенно при закрытии диалога (`hideDialog` + `setTimeout(0)`), а снимок «до» для SEAF Apply берётся по целевой ячейке из модели до очистки selection, чтобы `modify` не терялся; эмиссия `modify` в stencil event processor сравнивает нормализованные карты атрибутов `dataBefore`/`dataAfter` (а не только `sanitizeForIpc` XML-узла), чтобы изменения полей вроде `address` не отбрасывались до маршрутизации в `data_mirror`.
- синхронизация `data_mirror` выполняется атомарно через runtime-команду `mirrorDataByOidAtomic` (precheck -> snapshot -> apply -> rollback); при ошибке выводится только error с деталями `pageName` и `OID`, success-popup не показывается.
- назначение `OID` при добавлении фигур выполняется через event-маршруты (`seaf.company.ta.*` и/или explicit `add: seafStencilAllAdd` в exact-правилах для `dcs`/`dc_offices`) и Python handler (без прямого UI-автогенератора); уже непустой `OID` в `data` не переназначается при повторном stencil `add` после reparent/слоя; в stencil-item payload передаётся `currentLayerName`, чтобы не дублировать `moveObjectsToLayer` при `add`, если объект уже на целевом слое; смена родителя в модели эмитится как отдельный `reparent` → `seafStencilReparent`: `reparent.py` пишет в лог полный `event` с флагом `reparentScriptFired` и принудительно запускает schema-based layer-routing через тот же helper `create_layer_commands`, что и `all_add`; команды `moveObjectsToLayer` из Python идут с **`targetMode: "schemaCell"`** (переносится именно schema-ячейка по `objectId`, без подъёма до group-root), при `reparent` слой переустанавливается на конфигурированный, даже если `currentLayerName` уже совпадает с target.
- канонический OID: `<companyPrefix>.<schemaCode>.<sequence>` (`companyPrefix` из `env.yaml`, `schemaCode` = две последние части `schema`, fallback `unknown`).
- уникальность `OID` контролируется строго в рамках текущей диаграммы; при import-коллизиях на **одной странице** показывается таблица конфликтов для ручного разрешения (без автодедупликации); один и тот же OID на разных страницах (зеркала) не считается коллизией (`payload.event.index.objectPage` + `event.page.id`).
- payload для Python handlers обогащен данными объекта: `objectId`, нормализованная `geometry` и `data` (атрибуты из `Edit Data`-модели); тот же контракт применяется для команд контекстного меню.
- примерные Python-обработчики событий пишут диагностику через stderr-протокол (`SEAF_ERROR`/`SEAF_INFO`/`SEAF_LOG`) с префиксом скрипта в `seaf-plugin.log`; INFO управляется `env.scriptLogLevel`, ERROR пишется всегда; дополнительные компактные трассировки `title_label_sync` идут через `ScriptLogger.debug` только при `pluginLogLevel: debug|trace` в payload (`env.yaml`).
- добавлен обратный канал Python -> draw.io: `Response.commands[].name=updateStencilData` для обновления `data` стенсила по `pageId/objectId` в режимах `merge` и `replace`.
- добавлена пакетная команда `Response.commands[].name=updateStencilDataBulk`, а также API групповых операций `bulkUpdateByIds` и `bulkUpdateByCriteria` в renderer runtime.
- логика `all_add` реорганизована по модульной схеме: production orchestrator `python/scripts/events/all_add.py` + библиотека `python/scripts/lib/oid/*`; файл `examples/events/all_add.py` оставлен как shim для совместимости.
- добавлен метод `Response.commands[].name=ensureLayer` для create-or-get слоя по имени на странице с возвратом `layerId` в `result.payload.uiCommandResults`.
- для auto-event processor (`source=stencil_event_processor`) включено исполнение `Response.commands[]` тем же UI executor, что и для menu/system команд; это устраняет потерю `ensureLayer`/`updateStencilData` в event-сценариях.
- для `menu.context` в context menu попадают только команды с явным `enabled: true`; фильтрация выполняется как `scope AND target AND schemaPattern`, поэтому main-only команды не попадают в context menu.
- для P41-стенсилов добавлен собственный диалог `SeafEditDataDialog`, заменяющий штатный «Edit Data» drawio: режим контекстного меню теперь задается в `seaf-plugin-runtime/conf/context_menu.yaml` через `clientAction: seafEditData` и `menu.context.editDataMode: hard|soft` (default `hard`), а `stencils/config.yaml` хранит только `data_lock`/`data_hidden` и metadata схем. В `hard` штатный `Edit Data` скрывается и остается только SEAF-пункт; в `soft` доступны оба способа. Для grouped stencil-элементов target резолвится по ближайшему родителю со `schema`, поэтому RMB-клик в дочерний служебный `mxCell` не ломает логику. Загрузка stencil-policy выполняется через typed IPC action `getSeafStencilConfig`.
- дополнительно устранен дубликат пункта `Edit Data` в RMB для режимов `standard|both`: fallback-проверка наличия стандартного пункта теперь сравнивает нормализованный label (варианты с `...` и `…` считаются эквивалентными), поэтому стандартный пункт не добавляется повторно.
- контекстная команда `Создать страницу` переведена на Python handler `context_menu/add_page.py`: страница создается по `selection.data.title` (с проверками non-empty и уникальности имени) и после успеха в исходный стенсил проставляется page-link через штатный draw.io API `setLinkForCell`.
- `Создать страницу` расширена mirror-сценарием: после успешного `createPage + setCellLinkToPage` runtime переключается на новую страницу, ищет mirror-элемент по `schemas.<sourceSchema>.mirror` в `stencils/config.yaml`, вставляет его из библиотеки `SEAF_Р41`, синхронизирует `data` (copy-all) с исходным объектом в ячейку mirror с той же `schema`, что у родителя, и назначает слой через тот же Python layer-routing helper, что используется в `all_add` (без JS schema->layer fallback); неуспех вставки/резолва слоя дает сообщение `Не возможно добавить элемент <mirror> на страницу` и расширенную диагностику в `seaf-plugin.log`.
- После цепочки `createPage -> setCellLinkToPage` (и при mirror — после `insertStencilFromP41ByTitle -> updateStencilDataBulk -> moveObjectsToLayer`) `add_page` добавляет `assignEmptyOidOnPage`: на новой странице всем объектам с пустым атрибутом `OID` назначаются расчётные значения по правилам генератора из `all_add`.
- После OID-backfill автоматически выполняется `autoLinkParentsOnPage`: на новой странице предзаполняются parent-поля по правилам `parent.schema[]/parent.field` из `stencils/config.yaml` (strict-модель: ровно один parent-кандидат для child).
- После `autoLinkParentsOnPage` add-page всегда выполняет `routePageStencilsToLayers`: layer-routing применяется ко всем schema-bearing стенсилам созданной страницы (а не только mirror-объекту), с автоматическим созданием отсутствующих слоёв и валидацией шага как обязательного gate.
- **Tools → Edit Data (bulk, 0.5.69+)**: выбор группы стенсилов по `layer` из `stencils/config.yaml`, табличное редактирование всех объектов выбранной `schema` на всех страницах (Tabulator), учёт `data_lock` / `data_hidden`, Save → `edit_data_apply.py` → `updateStencilDataBulk` + linked-page sync. **Tabulator** поставляется с **desktop** (`drawio-standalone/.../js/vendor/tabulator/`, preload в `ElectronApp.js`); в runtime tarball — только `seaf-bulk-edit-data-module.js` в корне `plugins/`. При запрете bulk для схемы (schema не попала под `seafEditData` policy в `context_menu.yaml`) plugin пишет `warn` в `seaf-plugin.log` (`Bulk Edit Data denied by schema policy`), а не только показывает popup.
- Контекстная команда `Связать с родителем` (`context_menu/link_with_parent.py`) использует `parent.schema[]` как массив разрешённых parent-типов из `stencils/config.yaml`; связь применяется только если для child найден ровно один parent-кандидат в текущем выделении (0 — missing, >1 — коллизия).
- Добавлена контекстная команда `Создать логическую связь` (`seafCreateLogicalLink`, `clientAction: createLogicalLink`): пункт меню появляется только при ровно двух выбранных стенсилах из разрешённого schema allowlist, открывает вспомогательное окно параметров (`OID(title)`, геометрия, стиль, optional `label`, optional `description`) с устойчивым нижним отступом кнопочного блока `25px`, создает связь через `graph.insertEdge`, записывает `schema=seaf.company.ta.services.logical_links` и SEAF-поля `OID/source/target/direction/title` (и `description`, если заполнено), после чего переносит edge на слой `Логические связи`.
- Добавлен hardening Python-команд: перед Python-зависимыми пунктами меню выполняется единый preflight готовности runtime, для несовместимого host bulk Edit Data используется безопасный degrade (без падения), а update runtime возвращает `updated_degraded` при провале post-check Python.
- **Обновить плагин** выкладывает **весь** комплект из `seaf-plugin-runtime.tar.gz` автоматически (без ручного `tar`): `seaf.plugin.js`, `seaf_plugin/**`, **`seaf-bulk-edit-data-module.js`** — см. `applyRuntimeFromExtractRoot` в [`drawio-desktop/src/main/seaf/seafPluginService.js`](drawio-desktop/src/main/seaf/seafPluginService.js).
- При runtime update сервис сохраняет пользовательский Python runtime: если в backup найден `seaf_plugin/.venv`, он переносится в новый runtime до удаления backup.
- После update выполняется автоматический Python bootstrap и результат возвращается в `payload.pythonBootstrap`; при ошибке update остается успешным, но UI показывает явную диагностику bootstrap.
- Python bootstrap update-flow использует 2-веточный алгоритм: при валидном local `.venv` выполняется health-check без пересоздания, при отсутствующем/битом `.venv` выполняется recreate с последующей валидацией; кандидаты `basePython` внутри managed `.venv` исключаются, чтобы избежать `ENOENT` loop.
- Если `env.yaml` содержит устаревший `pythonExecutable`, runtime автоматически делает recovery через fallback-интерпретатор (`python3`/`python`) и сохраняет рабочий путь.

## SEAF Extensions Tree

```text
Drawio_poject/
├─ README.md
├─ drawio-desktop/
│  ├─ src/main/electron.js
│  ├─ src/main/seaf/seafPluginService.js
│  ├─ verify-seaf-minimal-stage.cjs
│  ├─ sync.cjs
│  ├─ electron-builder-linux-mac.json
│  └─ electron-builder-win.json
├─ drawio-standalone/   (symlink: drawio-desktop/drawio)
│  └─ src/main/webapp/js/vendor/tabulator/   ← Tabulator для bulk Edit Data
└─ seaf-plugin-runtime/
   ├─ plugin/seaf.plugin.js
   ├─ plugin/seaf-bulk-edit-data-module.js
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
   │  ├─ events/*.py
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
| `drawio-desktop/src/main/seaf/seafPluginService.js` | Основная серверная логика SEAF (main-process) | `loadConfig()`, `runCommand()`, `updateRuntime()`, `applyRuntimeFromExtractRoot()` (deploy `seaf.plugin.js`, `seaf_plugin/**`, `seaf-bulk-edit-data-module.js`) |
| `drawio-standalone/src/main/webapp/js/vendor/tabulator/` | Tabulator (desktop host) для bulk Edit Data | `tabulator.min.js`, `tabulator.min.css`; preload `ensureSeafTabulatorHost()` в `ElectronApp.js` |
| `drawio-standalone/src/main/webapp/js/diagramly/ElectronApp.js` | Bootstrap desktop + SEAF plugin load | `ensureSeafTabulatorHost()`, загрузка `seaf.plugin.js` |
| `seaf-plugin-runtime/plugin/seaf-bulk-edit-data-module.js` | Bulk Edit Data UI (Tabulator table) | `SeafBulkEditData.openBulkEditDataDialog`; lazy-load из `plugins/` |
| `drawio-desktop/scripts/test-apply-runtime-deploy.mjs` | Contract: update deploy выкладывает bulk-модуль | `applyRuntimeFromExtractRoot` + tarball |
| `drawio-desktop/scripts/test-runtime-tarball-layout.mjs` | Contract: layout tarball (env.yaml, root artifacts) | — |
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
| `seaf-plugin-runtime/python/scripts/examples/*.py` | Локальные демо-скрипты Python (не из поставочного `main_menu.yaml`) | Контракт `REQUEST`/`Response`, ручной запуск |
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
| Deploy всех root-артефактов при update | SEAF service | `seafPluginService.js` | `seaf.plugin.js` + `seaf_plugin/**` + `seaf-bulk-edit-data-module.js` (fail, если архив неполный для нового plugin) |
| Tools → Edit Data (bulk table) | Renderer + Python | `seaf.plugin.js`, `seaf-bulk-edit-data-module.js`, `main_menu/edit_data_apply.py` | `bulkEditData`, Tabulator host + `loadPluginRootScriptOnce` |
| Системный пункт меню `Обновить плагин` | Full renderer plugin | `seaf-plugin-runtime/plugin/seaf.plugin.js` | `registerActions()`, `executeSystemUpdate()`, `registerMainMenu()` |
| Фиксированный порядок пунктов меню SEAF | Full/minimal renderer plugins | `plugin/seaf.plugin.js`, `minimal-runtime/seaf.plugin.js` | Команды с `menu.main.enabled: true` (из YAML) -> `Обновить плагин` -> `SEAF Runtime v...`; подменю только через `menu.main.submenu`/`submenuTitle`; context-only команды (например `seafAddPage`) не попадают в main menu |
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
| `getSeafScriptEnvSchema` | `seafPluginService.getSeafScriptEnvSchema(args)` | Загрузка схемы `scriptEnvEditor` из `scripts/*.script_env.yaml` (относительно `conf/`) | `plugin/seaf.plugin.js` |
| `getSeafScriptEnvDefaults` | `seafPluginService.getSeafScriptEnvDefaults(args)` | Загрузка значений по умолчанию для `persist: scriptDefaults` | `plugin/seaf.plugin.js` |
| `saveSeafScriptEnvDefaults` | `seafPluginService.saveSeafScriptEnvDefaults(args)` | Сохранение defaults для `scriptEnvEditor` | `plugin/seaf.plugin.js` |
| `getSeafEnvConfig` | `seafPluginService.getEnvConfig(args)` | Загрузка `env.yaml` и схемы полей для `Edit Config` | `plugin/seaf.plugin.js` |
| `getSeafEventConfig` | `seafPluginService.getEventConfig(args)` | Загрузка и нормализация `events.yaml` для auto-event processor (`handlers` включают `add`, `remove`, `modify`, `reparent`, `connect`, `disconnect`) | `plugin/seaf.plugin.js` |
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
- Runtime update deploy contract: после успешного «Обновить плагин» в `~/.config/draw.io/plugins/` обязаны быть `seaf.plugin.js`, `seaf_plugin/conf/env.yaml`, и (для runtime ≥ 0.5.69) `seaf-bulk-edit-data-module.js`. Пользователь **не** распаковывает tarball вручную.

## Сборка draw.io desktop (Linux amd64)

Порядок для разработчика (см. также [`BASELINE_CHANGES.md`](BASELINE_CHANGES.md), [`prompt.md`](prompt.md)):

1. Собрать runtime и minimal-stage:
   ```bash
   bash seaf-plugin-runtime/release/runtime/build-runtime.sh
   bash seaf-plugin-runtime/release/runtime/build-minimal-runtime.sh
   ```
2. Опубликовать `seaf-plugin-runtime/release/out/seaf-plugin-runtime.tar.gz` в git репозитория runtime (иначе «Обновить плагин» на других машинах получит старый архив).
3. Версия desktop (`29.6.10-aNN`): `cd drawio-desktop && npm run sync` — счётчик берёт **максимум** из `package.json` и `.custom-version-state.json`, затем +1. Явная версия: `node sync.cjs --custom-suffix=a59`.
4. Собрать **только Linux amd64 deb** (без AppImage/arm64):
   ```bash
   cd drawio-desktop
   npm run release-linux-local
   ```
   Артефакт: `drawio-desktop/dist/draw.io-amd64-<version>.deb`
5. Установить `.deb` или запустить `dist/linux-unpacked/drawio`, затем **SEAF → Обновить плагин** (если runtime в git новее установленного).

Bulk Edit Data требует **и** новый desktop (Tabulator в webapp), **и** актуальный runtime после update.

## Stability release checklist

- Run runtime build: `seaf-plugin-runtime/release/runtime/build-runtime.sh`.
- Run tarball layout: `node drawio-desktop/scripts/test-runtime-tarball-layout.mjs`.
- Run update deploy contract: `node drawio-desktop/scripts/test-apply-runtime-deploy.mjs`.
- Run stability smoke: `node drawio-desktop/scripts/seaf-stability-smoke.mjs`.
- Run bulk contract: `cd drawio-desktop && npm run test:edit-data-bulk-contract`.
- Run desktop GUI smoke: `cd drawio-desktop && npm run test:seaf-gui`.
- Manual UI check: `More Shapes` contains `SEAF` with `SEAF_Р41` and no `undefined`.
- Manual update check: after `SEAF -> Обновить плагин`, user values in `env.yaml` remain unchanged; в `plugins/` есть `seaf-bulk-edit-data-module.js` (для 0.5.69+).
- Manual bulk Edit Data: **Tools → Edit Data** → таблица → Save без ошибки в `seaf-plugin.log`.

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
