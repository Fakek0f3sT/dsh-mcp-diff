# PROGRESS — журнал

Формат: одна запись на закрытую задачу/релиз, новые сверху. Пишет агент,
закрывающий задачу (см. `AGENTS.md`, `TODO.md`).

## 2026-08-30 — move_file как инфо-карточка (TODO #2)

Ветка `feat/mcp-move-file-card` → `main` (ff).

- ключ `mcp__filesystem__move_file` (priority 0, как остальные MCP-ключи)
  зарегистрирован на новый `MoveFileRow`: заголовок = source с бейджем `move`,
  в теле строка `→ destination`; оба пути через `displayPath(…, cwd)` — внутри
  workspace относительные.
- карточка собрана на `UnifiedDiff` без diff-строк — бесплатно шеврон и стиль
  семейства; пока args не распарсились — dim-строка toolName (как fallback у
  McpDiffRow).

## 2026-08-30 — multi-file в шапке bash-карточки (TODO #1)

Ветка `feat/multi-file-bash-header` → `main` (ff).

- при `edit.files.length > 1` в теле bash-карточки перед footnote появляется
  dim-строка `also touches: …` с остальными путями через `displayPath(…, cwd)`;
  заголовок по-прежнему показывает первый файл.
- для карточек без diff-строк (sed -i, redirect) этот список — единственная
  содержательная часть тела, кроме command/output; один файл — вид не менялся.

## 2026-08-30 — v0.2.0 (опубликован в npm)

Ветка `feat/bash-edit-cards` + `feat/diff-card-polish`, смержены в `main` (ff).

- bash-мутации рендерятся diff-карточкой с бейджем `bash edit · replace|write|in-place`
  (`parse-bash.ts`: python-heredoc пары `old`/`new`, `cat >`/`tee`/`>` записи, `sed -i`).
- fallback для немутаций — реплика нативного bash-sample: свёрнутая строка
  `▣ Bash · описание`, внутри TerminalBlock (prompt/cwd, Done/exit, Copy) + Inspect.
- фикс коллизии: bash-view регистрируется с `priority: -1` (ядро держит
  `bash-toolview-sample` на 0 — иначе падал load плагина).
- тело diff-карточек ограничено ~20 строками (448px) с прокруткой внутри.
- шеврон на diff-карточках (инжект-стиль `dsh-mcp-diff-style`).
- пути в заголовках: workspace-относительные (`displayPath`).

## 2026-08-29 — v0.1.1 (опубликован)

- diff-карточки для встроенных `edit`/`write` (priority -1, LCS-unify hunks).
- README + скриншот, английская копия.
- PR #3591 в awesome-dsh-plugin (категория ui) — зелёный, ждал мейнтейнера.

## 2026-08-29 — v0.1.0 (первая публикация)

- diff-карточки для MCP filesystem `edit_file` (server diff / args) и
  `write_file` (args → adds), единый `UnifiedDiff` (collapsed, `+N −M`).
