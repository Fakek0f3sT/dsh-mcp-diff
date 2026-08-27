# dsh-mcp-diff

Кастомный клиентский плагин для **DeepSeek Harness (Web GUI)**, который рендерит
все правки файлов в чате как **единообразные дифф-карточки** — свёрнутые по
умолчанию, с построчной подсветкой (зелёным добавления, красным удаления).

Покрывает и MCP-сервер `filesystem` (`edit_file` / `write_file`), и встроенные
инструменты DSH (`edit` / `write`), приводя их к одному виду.

## Зачем

По умолчанию DSH рисует дифф только для своих файловых инструментов
(`edit`, `write`), и своим рендером. Когда агент правит файлы через MCP-сервер
`@modelcontextprotocol/server-filesystem`, вызов называется
`mcp__filesystem__edit_file` / `mcp__filesystem__write_file` — для него нет
зарегистрированного toolview, и в чате виден только generic-блок без диффа.

Плагин:

- регистрирует toolview под MCP-ключами и строит дифф из ответа сервера
  (готовый unified-diff с контекстом и `@@`-заголовками) либо из аргументов
  вызова, когда ответа ещё нет (`write_file`, ещё выполняющийся `edit_file`);
- перекрывает и встроенные `edit` / `write`, унифицируя их контекстные хунки
  (построчный LCS: общие строки — нейтральный контекст, а не дублируются);
- рисует всё одной карточкой на нативном `<details>` — **свёрнута по
  умолчанию**, в шапке путь + `+N -M`, разворачивается по клику.

## Установка (из git)

Пакет пока не в npm, поэтому ставим из репозитория.

```bash
# 1. клонируем и собираем плагин
git clone https://github.com/Fakek0f3sT/dsh-mcp-diff.git
cd dsh-mcp-diff
npm install
npm run build       # → lib/index.js (host) + lib/client.js (browser bundle)
```

Затем подключаем в свой DSH-профиль (`~/.dsh/profiles/<profile>/package.json`).
Ставим ссылку на локальную сборку и добавляем плагин в бандлы профиля:

```bash
cd ~/.dsh/profiles/web        # ваш профиль
npm install /path/to/dsh-mcp-diff   # или "link:" на клон
```

```jsonc
{
  "dependencies": { "dsh-mcp-diff": "link:./node_modules/dsh-mcp-diff" },
  "dsh": { "profile": { "bundles": [ "…", "dsh-mcp-diff" ] } }
}
```

**Важно:** DSH подхватывает набор плагинов только при старте — после подключения
**перезапустите `dsh web`** и обновите страницу GUI.

Проверить, что бандл отдаётся:

```bash
curl -s http://127.0.0.1:3080/plugins/dsh-mcp-diff/client.js | head -c 80
```

## Настройка под другой MCP-сервер

Ключи toolview заданы под серверное имя `filesystem`. Если ваш MCP-сервер
файловой системы называется иначе (поле `serverName` в конфиге), поправьте
константу `TOOL_KEYS` в `src/client/index.tsx` (ключи вида
`mcp__<serverName>__edit_file`). Там же — ключи `edit` / `write`: уберите их,
если не хотите перекрывать встроенный рендер.

## Разработка

```bash
npm install
npm run build
node --import tsx/esm src/client/parse-diff.test.ts   # self-check парсера диффа
```

## Совместимость

Проверено на DSH `0.1.1-rc.2`. Плагин использует только платформенные модули
(react, ui-primitives, ui-slots, runtime/client) — внутренности ui-tool не
импортируются.

## Лицензия

MIT
