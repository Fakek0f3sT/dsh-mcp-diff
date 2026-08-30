# TODO — активные задачи

Порядок исполнения снизу вверх не менять: 1 → 2 → 3. Контекст проекта и
команды — в `AGENTS.md`; журнал сделанного — в `PROGRESS.md` (обновлять после
каждой закрытой задачи). Перед каждым коммитом: `npm run build` +
`npm run typecheck` + оба self-check зелёные.

---

## 1. Multi-file в шапке bash-карточки — ветка `feat/multi-file-bash-header`

**Проблема.** Команда может менять несколько файлов (heredoc-скрипт с двумя
`Path(...)`, `sed -i` по списку). `parseBashEdit()` уже возвращает все файлы в
`edit.files`, но `BashEditCard` (src/client/index.tsx) показывает в заголовке
только `edit.files[0]`, а в бейдже — `· N files`.

**Задача.** Когда `edit.files.length > 1`, перечислить остальные файлы в теле
карточки: до diff-строк (или после — на усмотрение) блок из путей
`displayPath(file, cwd)`, стилем как строка-примечание (dim, small). Заголовок
оставить как есть (первый файл). Для карточек без строк (sed/redirect) этот
список — единственное содержимое тела, кроме command/output.

**Acceptance:**
- heredoc с двумя+ файлами → заголовок = первый файл, в теле видны остальные;
- `sed -i … a.md b.md` → карточка перечисляет оба;
- один файл → вид не изменился;
- build/typecheck/self-checks зелёные.

**Подсказка:** `children`-проп `UnifiedDiff` уже рендерится после строк — список
можно передать туда же, где footnote/command/output у `BashEditCard`.

---

## 2. `move_file` (MCP filesystem) как инфо-карточка — ветка `feat/mcp-move-file-card`

**Проблема.** Официальный `@modelcontextprotocol/server-filesystem` умеет
`move_file` (аргументы `{ source: string, destination: string }`). Сейчас ключ
не занят нами → generic-строка, никакого результата мутации не видно.

**Задача.** Зарегистрировать ключ `mcp__filesystem__move_file` (priority 0,
как остальные MCP-ключи) на новый маленький компонент `MoveFileRow`:
- summary: `source → destination`, оба через `displayPath(…, cwd)`;
- переиспользовать `UnifiedDiff` (path = source, `badge="move"`, `lines=[]`,
  destination строкой в `children`) — так карточка бесплатно получает шеврон и
  стиль семейства; либо свой мини-компонент в том же стиле, если UnifiedDiff
  не ложится;
- running-состояние: показывать как у `McpDiffRow` (dim-строка toolName) или
  компактно — на усмотрение.

**Acceptance:**
- `mcp__filesystem__move_file` рендерит карточку `source → destination`;
- пути внутри workspace — относительные;
- build/typecheck/self-checks зелёные. Визуальную проверку делает человек.

**Подсказка:** аргументы читаются через `argsRecordOf(block)`; этот блок не
терминальный и не diff — `nativeDiffs`/`parseServerDiff` тут не участвуют.

---

## 3. CI (GitHub Actions) — ветка `ci/github-actions`

**Задача.** `.github/workflows/ci.yml`: на push и PR — node 22
(`actions/setup-node@v4`), pnpm через `pnpm/action-setup` (в репо
`pnpm-lock.yaml`), затем:

1. `pnpm install --frozen-lockfile`
2. `pnpm run build`
3. `pnpm run typecheck`
4. оба self-check

Для self-check нужен `tsx`, которого нет в devDependencies (локально брали из
checkout DSH). Добавить `tsx` в devDependencies (`pnpm add -D tsx`), добавить
скрипт `"test": "node --import tsx src/client/parse-bash.test.ts && node --import tsx src/client/parse-diff.test.ts"`,
использовать его в CI и в `AGENTS.md`/README заменить локальный запуск на
`npm run test` (или pnpm-эквивалент). pnpm-lock закоммитить.

**Acceptance:**
- workflow зелёный на пуш этой же ветки (проверить `gh run list`);
- `pnpm run test` локально зелёный;
- README/AGENTS.md обновлены.

**Подсказка:** в workflow нельзя полагаться на `~/projects/github/deepseek-harness`.

---

## Бэклог (не брать сейчас)

- Новый скриншот README под 0.2.0+ (бейджи bash edit, шеврон, относительные пути).
- Парсер: `python -c "…"`, `perl -pi -e` — отдача падает, брать только при
  реальном пропущенном кейсе.
- Кастомные имена MCP-серверов (сейчас ключи захардкожены на `filesystem`).
