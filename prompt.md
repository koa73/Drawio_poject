Ты работаешь в проекте /home/oleg/Drawio_poject.

Задача:
1) Добавить в верхнее меню desktop-приложения draw.io новый пункт SEAF с подпунктами:
   - Download
   - Create P41
   - Upload
2) Для подпунктов сделать только заглушки (пустые функции), без бизнес-логики.
3) Не ломать запуск приложения.
4) Собрать Debian amd64 пакет с уже подготовленной версией.
5) Не собирать RPM.

Ограничения и требования:
- Перед изменениями сравни целевые файлы с upstream:
  https://github.com/jgraph/drawio
- Вноси изменения так, чтобы они точно применялись в desktop runtime (учти, что desktop использует app.min.js + ElectronApp.js).
- Важно: код инициализации SEAF в ElectronApp.js должен быть безопасным:
  - без обращения к editorUi.menus.defaultMenuItems;
  - с защитой от разных типов defaultMenuItems (array/string/undefined);
  - с try/catch вокруг блока расширения меню, чтобы ошибка меню не роняла старт приложения.
- Добавь ключ локализации меню:
  - drawio-standalone/src/main/webapp/resources/dia.txt -> seaf=SEAF
  - drawio-standalone/src/main/webapp/resources/dia_ru.txt -> seaf=SEAF
- В electron-builder конфиге исключи RPM из linux targets:
  - файл: drawio-desktop/electron-builder-linux-mac.json
  - оставить только AppImage и deb.

Файлы для правок:
- drawio-standalone/src/main/webapp/js/grapheditor/Menus.js
- drawio-standalone/src/main/webapp/js/diagramly/Menus.js
- drawio-standalone/src/main/webapp/js/diagramly/ElectronApp.js
- drawio-standalone/src/main/webapp/resources/dia.txt
- drawio-standalone/src/main/webapp/resources/dia_ru.txt
- drawio-desktop/electron-builder-linux-mac.json

Детали реализации меню:
- В grapheditor/Menus.js:
  - добавить 'seaf' в Menus.prototype.defaultMenuItems перед 'help'.
- В diagramly/Menus.js:
  - зарегистрировать actions:
    - seafDownload
    - seafCreateP41
    - seafUpload
  - добавить this.put('seaf', new Menu(...)) с пунктами:
    - Download
    - Create P41
    - Upload
- В diagramly/ElectronApp.js:
  - добавить тот же SEAF-блок для desktop runtime;
  - использовать безопасную логику формирования defaultMenuItems;
  - обернуть расширение SEAF в try/catch и логировать console.error('SEAF menu init failed', e).

Сборка:
- Использовать локальный cache:
  ELECTRON_CACHE=/home/oleg/Drawio_poject/.cache/electron
- Команда:
  npm --prefix /home/oleg/Drawio_poject/drawio-desktop run release-linux
- Учти, что release-linux может завершаться ошибкой из-за GH_TOKEN (publish always), но .deb должен быть собран.
- Проверить наличие артефакта:
  /home/oleg/Drawio_poject/drawio-desktop/dist/draw.io-amd64-29.7.0.deb

Проверки после изменений:
- node --check для ElectronApp.js без ошибок.
- В установленном app.asar действительно есть обновленный ElectronApp.js с SEAF-фиксами.
- Приложение стартует.
- В верхнем меню есть пункт SEAF с тремя подпунктами, клики не выполняют логику (заглушки).

В отчете укажи:
- какие файлы изменены;
- какую команду сборки запускал;
- путь к итоговому .deb;
- что проверено (старт + наличие SEAF).
