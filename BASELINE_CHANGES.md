# Изменения базового дистрибутива draw.io (инструкция для обновлений)

Этот файл фиксирует **все актуальные доработки**, сделанные поверх upstream `jgraph/drawio-desktop` (master), и служит **чек‑листом** для переноса изменений при выходе новых версий draw.io.

## База сравнения (upstream)
- **Репозиторий**: `jgraph/drawio-desktop`
- **Ветка**: `master` (сравнение делалось с текущим содержимым GitHub)

## Цели кастомизации
- Встроенная поддержка SEAF runtime‑плагина, работающая **по умолчанию** (без `--enable-plugins`).
- Runtime‑плагин хранится в пользовательском каталоге и может **обновляться из GitHub** без пересборки дистрибутива.
- Версионирование сборки `29.6.10-aNN` и отображение версии в **Help/About** как `v29.6.10-aNN`.

## Ключевые изменения в коде (по файлам)

## Upstream vs кастом (быстрые ссылки и фрагменты)
Ниже — самые критичные места, которые обычно “ломаются” при обновлении upstream. Здесь даны **короткие фрагменты** и ссылки на upstream‑файлы, чтобы быстрее переносить изменения.

### U1) `file://` whitelist для SEAF runtime (Electron main)
Upstream файл: `src/main/electron.js` (GitHub raw):  
`https://raw.githubusercontent.com/jgraph/drawio-desktop/master/src/main/electron.js`

Кастом файл: [`drawio-desktop/src/main/electron.js`](drawio-desktop/src/main/electron.js)

**Upstream (суть):** разрешает `file://.../plugins/` только если включен `--enable-plugins`:

```js
const pluginsCodeUrl = url.pathToFileURL(path.join(getAppDataFolder(), '/plugins/')).href;
// ...
if (!url.startsWith(codeUrl) && (!isPluginsEnabled() || (isPluginsEnabled() && !url.startsWith(pluginsCodeUrl))))
{
  callback({cancel: true});
}
```

**Кастом (суть):** добавляет точечный allowlist для `seaf.plugin.js` и `seaf_plugin/*`, даже когда `enablePlugins=false`:

```js
const allowedSeafUrl = isSeafPluginUrl(details.url);
// ...
if (!currentUrl.startsWith(codeUrl) &&
    !allowedSeafUrl &&
    (!isPluginsEnabled() || (isPluginsEnabled() && !currentUrl.startsWith(pluginsCodeUrl))))
{
  callback({cancel: true});
}
```

Также в кастоме поправлен путь:
- upstream: `path.join(getAppDataFolder(), '/plugins/')`
- кастом: `path.join(getAppDataFolder(), 'plugins')`

### U2) Разрешение `getPluginFile()` без `--enable-plugins` (только SEAF)
Upstream файл: `src/main/electron.js` (GitHub raw):  
`https://raw.githubusercontent.com/jgraph/drawio-desktop/master/src/main/electron.js`

Кастом файл: [`drawio-desktop/src/main/electron.js`](drawio-desktop/src/main/electron.js)

**Upstream (суть):**

```js
function getPluginFile(plugin)
{
  if (!enablePlugins) return null;
  // ...
}
```

**Кастом (суть):**

```js
if (!enablePlugins && !isSeafRuntimePath(normalized))
{
  return null;
}
```

### U3) Автоподключение runtime‑плагина (renderer)
Кастом файл: [`drawio-standalone/src/main/webapp/js/diagramly/ElectronApp.js`](drawio-standalone/src/main/webapp/js/diagramly/ElectronApp.js)

**Кастом (суть):**
- миграция старых путей `./plugins/seaf.plugin.js` → `seaf.plugin.js`
- гарантирует наличие `seaf.plugin.js` в списке plugins
- далее `mxscript(file://<appData>/plugins/seaf.plugin.js)` грузит runtime‑плагин

Критично: без U1/U2 в main‑процессе эта загрузка будет заблокирована и плагин “тихо” не стартует.

### U4) Версия сборки и Help/About: `v29.6.10-aNN` (без IPC)
Upstream `sync.cjs` (GitHub raw):  
`https://raw.githubusercontent.com/jgraph/drawio-desktop/master/sync.cjs`

Кастом файл: [`drawio-desktop/sync.cjs`](drawio-desktop/sync.cjs)

**Upstream (суть):** версия берется из `drawio/VERSION` и пишется в `package.json`, UI‑версия остаётся `@DRAWIO-VERSION@`:

```js
pj.version = ver
fs.writeFileSync(appjsonpath, JSON.stringify(pj, null, 2), 'utf8')
```

**Кастом (суть):**
- формирует `package.json.version = 29.6.10-aNN`
- и **до сборки** подменяет `EditorUi.VERSION` на `v29.6.10-aNN` в `drawio/src/main/webapp/js/diagramly/EditorUi.js`

### U5) Packaging дефолтного runtime (electron-builder)
Upstream `electron-builder-linux-mac.json` (GitHub raw):  
`https://raw.githubusercontent.com/jgraph/drawio-desktop/master/electron-builder-linux-mac.json`

Кастом: [`drawio-desktop/electron-builder-linux-mac.json`](drawio-desktop/electron-builder-linux-mac.json)

**Upstream:** без `extraResources` для SEAF runtime.  
**Кастом:** добавляет:

```json
"extraResources": [
  { "from": "../seaf-plugin-runtime/release/out/stage", "to": "seaf-runtime-default" }
]
```

### U6) SEAF bulk Edit Data: Tabulator в webapp host (не в runtime tarball)
Кастом файлы:
- [`drawio-standalone/src/main/webapp/js/vendor/tabulator/`](drawio-standalone/src/main/webapp/js/vendor/tabulator/) — `tabulator.min.js`, `tabulator.min.css`
- [`drawio-standalone/src/main/webapp/index.html`](drawio-standalone/src/main/webapp/index.html) — `<link href="js/vendor/tabulator/tabulator.min.css">`
- [`drawio-standalone/src/main/webapp/js/diagramly/ElectronApp.js`](drawio-standalone/src/main/webapp/js/diagramly/ElectronApp.js) — `ensureSeafTabulatorHost()` до загрузки plugins

**Контракт:**
- Desktop host предоставляет `window.Tabulator` (путь относительно `codeUrl`, разрешён CSP `script-src 'self'`).
- Runtime tarball содержит только [`seaf-bulk-edit-data-module.js`](seaf-plugin-runtime/plugin/seaf-bulk-edit-data-module.js) в корне plugins (allowlist: `seaf-bulk-edit-data-module.js` в [`isSeafRuntimePath`](drawio-desktop/src/main/electron.js)).
- [`build-runtime.sh`](seaf-plugin-runtime/release/runtime/build-runtime.sh): `cp conf/.` → merge (без `conf/conf/`), без Tabulator в `seaf_plugin/conf/vendor/`.

### U7) Runtime update: deploy всех root-артефактов tarball
Файл: [`drawio-desktop/src/main/seaf/seafPluginService.js`](drawio-desktop/src/main/seaf/seafPluginService.js) — `applyRuntimeFromExtractRoot`.

**Обязательный deploy при «Обновить плагин»** (пользователь ничего не копирует вручную):
- `plugins/seaf.plugin.js`
- `plugins/seaf-bulk-edit-data-module.js` (если есть в архиве; для runtime с `loadPluginRootScriptOnce` — обязателен, иначе update fail)
- `plugins/seaf_plugin/**` (conf, python, runtime, keys)

Temp + rename + rollback для bulk-модуля в том же цикле, что и для `seaf.plugin.js`.

### 1) Desktop host: загрузка runtime‑плагина без `--enable-plugins`
Файл: [`drawio-desktop/src/main/electron.js`](drawio-desktop/src/main/electron.js)

Что добавлено/изменено:
- **Bootstrap runtime**: установка дефолтного SEAF runtime из ресурсов приложения в appData:
  - `ensureSeafRuntimeInstalled()`
  - цель: `~/.config/draw.io/plugins/seaf.plugin.js` и `~/.config/draw.io/plugins/seaf_plugin/**`
- **Whitelist для SEAF**:
  - `getPluginFile()` теперь возвращает путь к `seaf.plugin.js` и `seaf_plugin/*` даже когда `enablePlugins=false`
  - `onBeforeRequest(file://*)` разрешает `file://.../plugins/seaf.plugin.js` и `file://.../plugins/seaf_plugin/*` **точечно**, не открывая доступ ко всем внешним плагинам
  - функции: `normalizePluginRequestPath()`, `isSeafRuntimePath()`, `isSeafPluginUrl()`
- **Фикс пути pluginsCodeUrl**:
  - upstream использует `path.join(getAppDataFolder(), '/plugins/')`, что при некоторых комбинациях может быть проблемным
  - в кастоме используется `path.join(getAppDataFolder(), 'plugins')`

Почему это нужно:
- В upstream внешние плагины требуют `--enable-plugins`, а `file://` загрузки в целом ограничены.
- Для SEAF нужно безопасно разрешить только свой runtime‑плагин в appData.

### 2) Упаковка дефолтного SEAF runtime в дистрибутив
Файлы:
- [`drawio-desktop/electron-builder-linux-mac.json`](drawio-desktop/electron-builder-linux-mac.json)
- [`drawio-desktop/electron-builder-win.json`](drawio-desktop/electron-builder-win.json)

Что изменено:
- добавлен `extraResources` для доставки дефолтного runtime (bootstrap source):
  - `from: ../seaf-plugin-runtime/release/out/stage`
  - `to: seaf-runtime-default`

### 3) Backend для команд плагина и обновления runtime из GitHub
Файл: [`drawio-desktop/src/main/seaf/seafPluginService.js`](drawio-desktop/src/main/seaf/seafPluginService.js)

Что добавлено/изменено:
- `updateRuntime()` загружает GitHub release asset `seaf-plugin-runtime.tar.gz` и атомарно обновляет:
  - `~/.config/draw.io/plugins/seaf.plugin.js`
  - `~/.config/draw.io/plugins/seaf_plugin/**`
- **Нормализация ошибок** Python‑скриптов:
  - при `exit != 0` теперь приоритетно поднимается `parsed.message` из JSON stdout
  - async‑ошибки нормализуются в строку (чтобы не получать `[object Object]`)

### 4) Runtime‑плагин SEAF (единственный, встроенного нет)
Master‑каталог: [`seaf-plugin-runtime/`](seaf-plugin-runtime/)

Ключевые файлы:
- [`seaf-plugin-runtime/plugin/seaf.plugin.js`](seaf-plugin-runtime/plugin/seaf.plugin.js)
  - динамическое меню `SEAF` по `conf/plugin.yaml`
  - пункт обновления runtime из GitHub
  - отображение версии runtime последним пунктом меню (`SEAF Runtime vX.Y.Z`)
  - версия в шапке файла: `Runtime script version: 0.1.0`
- [`seaf-plugin-runtime/conf/plugin.yaml`](seaf-plugin-runtime/conf/plugin.yaml)
  - `plugin.runtimeVersion`
- [`seaf-plugin-runtime/runtime/version.json`](seaf-plugin-runtime/runtime/version.json)
- [`seaf-plugin-runtime/release/runtime/build-runtime.sh`](seaf-plugin-runtime/release/runtime/build-runtime.sh)
  - в архив включается `runtime/` (metadata)

### 5) Renderer: автоподключение runtime‑плагина + миграция старых путей
Файл: [`drawio-standalone/src/main/webapp/js/diagramly/ElectronApp.js`](drawio-standalone/src/main/webapp/js/diagramly/ElectronApp.js)

Что изменено:
- удалена логика «встроенного seaf.plugin.js» из `./plugins/`
- добавлена миграция настроек:
  - `./plugins/seaf.plugin.js`, `plugins/seaf.plugin.js`, `/plugins/seaf.plugin.js` → `seaf.plugin.js`
- при старте гарантируется наличие `seaf.plugin.js` в списке plugins (это внешний runtime из appData)

Файл: [`drawio-standalone/src/main/webapp/js/diagramly/Settings.js`](drawio-standalone/src/main/webapp/js/diagramly/Settings.js)
- дефолтный список plugins содержит `seaf.plugin.js` (runtime)

### 6) Версионирование сборки и статическая версия в Help/About
Файлы:
- [`drawio-desktop/sync.cjs`](drawio-desktop/sync.cjs)
- [`drawio-desktop/package.json`](drawio-desktop/package.json)

Что изменено:
- Базовая версия форка фиксируется через `DRAWIO_BASE_VERSION` (по умолчанию `29.6.10`).
- Генерация суффикса `aNN`:
  - хранение состояния в `.custom-version-state.json`
  - override: `DRAWIO_CUSTOM_SUFFIX` или `--custom-suffix=...`
- В `package.json.version` пишется `29.6.10-aNN` (semver‑валидно).
- **Статическая подстановка версии UI до сборки**:
  - `sync.cjs` подменяет `EditorUi.VERSION` на `v29.6.10-aNN` в:
    - `drawio/src/main/webapp/js/diagramly/EditorUi.js`
    - (при необходимости) `drawio/src/main/webapp/js/diagramly/Menus.js`

Важно:
- upstream отображает Help/About через `EditorUi.VERSION`, который по умолчанию приходит из `@DRAWIO-VERSION@` и не содержит `-aNN`.
- В кастоме Help/About должен показывать `v29.6.10-aNN` **всегда**, без IPC.

### 7) Локальная сборка без GitHub token
Файл: [`drawio-desktop/package.json`](drawio-desktop/package.json)
- добавлен скрипт:
  - `release-linux-local` = `electron-builder ... --publish never`

## Атавизмы / потенциальный долг (что проверить и, возможно, убрать)

### A) Каталог `seaf_plugin/` в репозитории
Папка: [`seaf_plugin/`](seaf_plugin/)
- содержит standalone‑bridge и документацию раннего прототипа.
- если текущая целевая реализация = **только runtime‑плагин в `seaf-plugin-runtime/`**, то `seaf_plugin/` можно:
  - либо удалить (если точно не нужен),
  - либо пометить как архив/legacy (чтобы не вводил в заблуждение).

### B) `.asar_extract_new/`
Папка: [`.asar_extract_new/`](.asar_extract_new/)
- выглядит как извлеченный артефакт из `app.asar` для исследования.
- не должна участвовать в релизе; стоит исключить из основного рабочего дерева/документации.

### C) Дубли `drawio-desktop/electron.js` и `drawio-desktop/ElectronApp.js`
Файлы:
- [`drawio-desktop/electron.js`](drawio-desktop/electron.js)
- [`drawio-desktop/ElectronApp.js`](drawio-desktop/ElectronApp.js)

Наблюдение:
- в проекте есть и “исходники” (`src/main/electron.js`, `drawio-standalone/.../ElectronApp.js`), и копии рядом в корне `drawio-desktop/`.
- важно определить, **какие файлы реально пакуются** в `app.asar` и поддерживать **один источник правды** (или добавить генерацию копий на build‑шаге).

## Как переносить изменения на будущие версии draw.io (чек‑лист)
1. Обновить submodule/исходники upstream (drawio-desktop + drawio webapp).
2. Повторно применить изменения в:
   - `drawio-desktop/src/main/electron.js` (bootstrap + whitelist + getPluginFile)
   - `drawio-desktop/src/main/seaf/seafPluginService.js`
   - `drawio-standalone/.../ElectronApp.js` и `Settings.js` (runtime plugin path + миграция)
   - `drawio-desktop/sync.cjs` (версионирование + инъекция Help/About)
   - `electron-builder-*.json` (`extraResources` для дефолтного runtime)
3. Пересобрать runtime asset `seaf-plugin-runtime.tar.gz` и проверить структуру `release/out/stage`:
   - `seaf.plugin.js`
   - `seaf_plugin/conf/plugin.yaml`
   - `seaf_plugin/python/**`
   - `seaf_plugin/runtime/version.json`
4. Собрать desktop пакет (только **Linux amd64 deb**, без AppImage/arm64):
   - `npm run sync`
   - `npm run release-linux-local` (внутри: `--linux deb --x64`)
5. Smoke‑проверки:
   - Help/About: показывает `v29.6.10-aNN`
   - SEAF меню инициализируется, команды работают
   - `~/.config/draw.io/plugins/seaf_plugin/logs/seaf-plugin.log` не пустой после вызова команд
   - Update runtime из GitHub меняет версию runtime и файлы в `~/.config/draw.io/plugins`

