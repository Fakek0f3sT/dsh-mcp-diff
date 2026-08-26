# dsh-mcp-diff

Кастомный клиентский плагин для **DeepSeek Harness (Web GUI)**, который рендерит
**дифф-карточки** для вызовов инструментов MCP-сервера `filesystem`
(`edit_file`, `write_file`) — так же, как встроенные `edit`/`write` показывают
дифф, вместо простого текстового блока.

## Зачем

По умолчанию DSH рисует дифф только для своих файловых инструментов (`edit`,
`write`). Когда агент правит файлы через MCP-сервер
`@modelcontextprotocol/server-filesystem`, вызов называется
`mcp__filesystem__edit_file` / `mcp__filesystem__write_file` — для него нет
зарегистрированного toolview, и в чате виден только generic-блок без диффа.

Этот плагин регистрирует toolview под этими ключами и строит дифф **из
аргументов вызова** (`edits[].oldText/newText` для `edit_file`, `content` для
`write_file`), поэтому дифф виден даже если MCP-сервер не вернул его в ответе.

## Установка

```bash
npm install dsh-mcp-diff
```

Затем добавьте пакет в свой профиль DSH (`package.json` профиля):

```jsonc
{
  "dependencies": { "dsh-mcp-diff": "^0.1.0" },
  "dsh": { "profile": { "bundles": [ "dsh-mcp-diff" ] } }
}
```

Или вставьте строку композиции вручную (см. `cordis.patch.yml`):

```yaml
- insert:
    - id: mcp-diff
      name: dsh-mcp-diff
```

## Настройка под другой MCP-сервер

Ключи toolview жёстко заданы под серверное имя `filesystem`. Если ваш MCP-сервer
файловой системы называется иначе (поле `serverName` в конфиге), поправьте ключи
в `src/client/index.tsx` — константа `TOOL_KEYS`.

## Сборка

```bash
npm install
npm run build      # → lib/index.js (host) + lib/client.js (browser bundle)
```

## Лицензия

MIT
