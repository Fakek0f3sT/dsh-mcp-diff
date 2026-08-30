# AGENTS.md — краткий брифинг по репозиторию

`dsh-mcp-diff` — клиентский плагин для **DeepSeek Harness Web GUI**, который
рендерит каждую мутацию файла в чате единой diff-карточкой: MCP filesystem
(`edit_file`/`write_file`), встроенные `edit`/`write` и мутирующие **bash**-команды
(python-heredoc с парами `old`/`new`, `cat >`/`tee`/`>` записи, `sed -i`).

## Как плагин подключается к DSH

- Слот `tool.call.toolview` — **keyed**: одна registration на wire-имя тула
  (`edit`, `write`, `bash`, `mcp__filesystem__edit_file`, …). Кто занял ключ —
  рисует ВСЕ вызовы этого тула; вернуть `null` из компонента = пустая строка,
  НЕ fallback. Выборочного перехвата нет.
- Приоритеты: по возрастанию, «lowest renders». Ядро DSH держит
  `bash-toolview-sample` на ключе `bash` (priority 0) — наш bash-view
  регистрируется с `priority: -1`. То же у `edit`/`write`. MCP-ключи свободны —
  там priority 0.
- Owner-пропсы, которые приходят в view-компонент: `toolName`, `block`,
  `cwd` (корень workspace сессии), `home`, `openFile`, `inspect` (`() => void`).

## Client purity gate (критично)

Клиентский бандл может **value-импортировать только** платформенные модули:
`react`, `@deepseek-ai/dsh-client-ui-primitives` (TerminalBlock, иконки,
StateDot), `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-runtime/client`
(в т.ч. `resolveWorkspacePath`), `@deepseek-ai/cordis` (типы).
`@deepseek-ai/dsh-client-ui-tool` — **только type-only импорт** (активация слота);
ui-tool internals (GenericToolCard, toolRowModel, terminalCardModel, css-модули)
импортировать нельзя. Локальные модули (`./parse-bash`) — можно.

## Файлы

| Путь | Что |
|---|---|
| `src/client/index.tsx` | все view-компоненты: `UnifiedDiff`, `McpDiffRow`, `BashRow`, `BashEditCard`, `TerminalCard`, регистрация в `apply()` |
| `src/client/parse-bash.ts` | чистый детектор мутаций bash-команд (+ типы `BashEdit`) |
| `src/client/parse-bash.test.ts` | self-check детектора (импортирует parse-bash) |
| `src/client/parse-diff.test.ts` | self-check парсера server-diff (зеркало кода из index.tsx — при изменении парсера зеркалировать) |
| `cordis.patch.yml` | декларация `tool.call.toolview` + дефолтная inject-цель |
| `tsdown.config.ts` | сборка клиентского бандла |
| `docs/screenshot.png` | скриншот для README |

## Команды

```bash
npm install
npm run build        # tsc -p tsconfig.build.json && tsdown  (lib/client.js)
npm run typecheck    # tsc --noEmit (включая тесты)
node --import "$DSH_CHECKOUT/node_modules/tsx/dist/loader.mjs" src/client/parse-bash.test.ts
node --import "$DSH_CHECKOUT/node_modules/tsx/dist/loader.mjs" src/client/parse-diff.test.ts
# DSH_CHECKOUT = ~/projects/github/deepseek-harness (локально есть tsx из его node_modules)
```

Self-check печатают `… self-check ok` и exit 0, либо имена упавших кейсов.
Тестам **нельзя** использовать node-глобалы (`process`, `node:assert`) без
необходимости — в плагине нет `@types/node` (старый тест обёрнут `@ts-nocheck`).

## Живая проверка

`~/.dsh/profiles/web/node_modules/dsh-mcp-diff` — **symlink на этот репозиторий**:
`npm run build` + refresh страницы GUI = живой результат. **Никогда не
перезапускай `dsh web`** (это убьёт сессию). Браузерных проверок у агента нет —
финальную визуальную проверку делает человек; агент обязан довести build +
typecheck + оба self-check до зелёного перед каждым коммитом.

## Конвенции

- Коммиты мелкие, разбитые по смыслу: `feat: …`, `fix: …`, `docs: …`, `ci: …`, `chore: …`.
- Одна задача = одна ветка от свежего `main`; после зелёных проверок — merge
  `--ff-only` в `main` и push.
- Версия: только `npm version minor --no-git-tag-version` одним `chore: release X.Y.Z`
  коммитом в конце пачки задач. `npm publish` делает **только пользователь** (2FA).
- Не переименовывать пакет (npm-идентичность + запись в каталоге awesome-dsh).
- Отвечать на русском, если контекст русскоязычный.
