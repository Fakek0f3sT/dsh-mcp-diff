/**
 * dsh-mcp-diff — browser half.
 *
 * Registers a keyed tool view into `tool.call.toolview` for the MCP filesystem
 * server's `edit_file` and `write_file` calls (wire names
 * `mcp__filesystem__edit_file` / `mcp__filesystem__write_file`). The shipped
 * composition has no view for these keys, so they fall back to the generic tool
 * row (no diff). This plugin owns those keys and renders one unified-diff card.
 *
 * Two diff sources, best-available first:
 *   1. `edit_file` after it settles — the standard server returns a fenced
 *      git-style unified diff (createTwoFilesPatch). We parse and colorize it,
 *      keeping the context lines and `@@` hunk headers the server computed:
 *      more readable than a bare removed/added split.
 *   2. Fallback (still-running `edit_file`, or any `write_file`, whose result is
 *      only "Successfully wrote to …") — build the diff from the call ARGUMENTS:
 *      `edits[].oldText/newText`, or `content` as a whole-file add.
 *
 * Both sources render through the SAME local UnifiedDiff card (row-fill
 * highlight + `+N -M` footer), so an MCP edit and an MCP write read identically.
 *
 * A third view owns the plain `bash` key: commands that clearly mutate file
 * lines (parse-bash.ts, conservative command-text parsing) render as a badged
 * diff card — intended change only, never verified filesystem state — while
 * every other bash call keeps a plain terminal-like card, so the chat flow is
 * unchanged for them.
 *
 * The bundle may only value-import the platform module table (react,
 * ui-primitives, ui-slots, runtime/client); ui-tool internals are off-limits by
 * the client purity gate, so the diff card is a small local component styled
 * with the same theme tokens the native DiffBlock uses. The ui-tool import stays
 * type-only (it activates the `tool.call.toolview` SlotMap augmentation).
 */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconApiOutline14, IconChevronDownOutline14, StateDot, TerminalBlock,
  type TerminalBlockProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: activates the `tool.call.toolview` slot declaration on SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { parseBashEdit, type BashEdit } from './parse-bash'

/** Wire tool names this plugin owns:
 *   - MCP filesystem server (`mcp__<serverName>__…`) — has no diff view, so it
 *     falls back to the generic row without this plugin. Change the
 *     `filesystem` segment if your server is mounted under another `serverName`.
 *   - the built-in `edit`/`write` tools — DSH already renders these through its
 *     own `FileMutationRow`/`DiffBlock`; overriding the keys here routes them
 *     through this plugin's card instead, so every file mutation in the chat
 *     reads identically (same row-fill highlight). Removing the plugin restores
 *     the native rows. */
/** MCP filesystem keys — no shipped occupant at priority 0. */
const MCP_TOOL_KEYS = [
  'mcp__filesystem__edit_file',
  'mcp__filesystem__write_file',
] as const

/** Built-in file tools — file-mutation-toolview owns these at priority 0;
 * shadow with a lower rank (ascending priority, lowest renders). */
const BUILTIN_TOOL_KEYS = ['edit', 'write'] as const

/** One `edit_file` edit, as the MCP server's input schema shapes it. */
interface FsEdit {
  oldText: string
  newText: string
}

/** Read the raw JSON argument string off a running or settled call block. */
function argsRawOf(block: ToolCallBlock): string | undefined {
  if ('argsRaw' in block && typeof block.argsRaw === 'string') return block.argsRaw
  const call = (block as { call?: { argsRaw?: string } | null }).call
  return call?.argsRaw
}

/** Parse the call args JSON into a record, or null when unusable (streaming
 * partial JSON, foreign shape). */
function argsRecordOf(block: ToolCallBlock): Record<string, unknown> | null {
  const raw = argsRawOf(block)
  if (raw === undefined || raw.trim() === '') return null
  let args: unknown
  try {
    args = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof args !== 'object' || args === null) return null
  return args as Record<string, unknown>
}

/** The `path` argument, when present. */
function pathOf(block: ToolCallBlock): string | null {
  const record = argsRecordOf(block)
  return record !== null && typeof record.path === 'string' ? record.path : null
}

/** Join the text content of a settled tool result; '' for a running call. */
function resultTextOf(block: ToolCallBlock): string {
  const content = (block as { content?: readonly unknown[] }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } =>
      typeof b === 'object' && b !== null
      && (b as { type?: unknown }).type === 'text'
      && typeof (b as { text?: unknown }).text === 'string')
    .map(b => b.text)
    .join('')
}

/** One rendered line of a unified diff. */
type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx'
interface DiffLine {
  kind: DiffLineKind
  text: string
}
interface DiffView {
  lines: DiffLine[]
  added: number
  removed: number
}

/** Split a side's text into content lines, dropping a single trailing newline
 * (a terminator, not an extra blank line). Empty text is zero lines. */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/** Line-level diff of two blocks via a longest-common-subsequence table:
 * shared lines become `ctx`, the rest `del` (only-in-old) then `add`
 * (only-in-new). Used for the built-in edit/write cards, whose per-hunk
 * `oldText`/`newText` each bake in the same context lines — a plain del-all /
 * add-all would print that context twice; the LCS recovers it as one neutral
 * row, matching the unified look of the MCP server diff.
 * ponytail: O(n·m) table, fine for a card's few-line hunks; a hunk of thousands
 * of changed lines would want Myers, but edit/write hunks are small. */
function lcsLines(oldText: string, newText: string): { lines: DiffLine[]; added: number; removed: number } {
  const a = contentLines(oldText)
  const b = contentLines(newText)
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push({ kind: 'ctx', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ kind: 'del', text: a[i] }); removed++; i++ }
    else { lines.push({ kind: 'add', text: b[j] }); added++; j++ }
  }
  for (; i < n; i++) { lines.push({ kind: 'del', text: a[i] }); removed++ }
  for (; j < m; j++) { lines.push({ kind: 'add', text: b[j] }); added++ }
  return { lines, added, removed }
}

/** A diff-card render view carried on a settled or running tool block: the
 * built-in edit/write tools attach `card:'diff'` with contextual FileDiff
 * hunks. Loosely typed to avoid a value dependency on the presentation types. */
interface DiffCardView {
  card?: unknown
  diffs?: unknown
}
interface FileDiff {
  path: string
  oldText: string | null
  newText: string
}

/** Read the FileDiff hunks off a block's diff card view — result side first
 * (the applied change once settled), else the call side (the intended change
 * while running). Null when the block carries no `card:'diff'` view (every MCP
 * call: the MCP filesystem server ships no render view). */
function nativeDiffs(block: ToolCallBlock): FileDiff[] | null {
  const pick = (view: DiffCardView | null | undefined): FileDiff[] | null => {
    if (view === null || view === undefined || view.card !== 'diff') return null
    if (!Array.isArray(view.diffs) || view.diffs.length === 0) return null
    const out: FileDiff[] = []
    for (const h of view.diffs as unknown[]) {
      if (typeof h !== 'object' || h === null) return null
      const { path, oldText, newText } = h as Record<string, unknown>
      if (typeof path !== 'string' || typeof newText !== 'string') return null
      if (oldText !== null && typeof oldText !== 'string') return null
      out.push({ path, oldText, newText })
    }
    return out
  }
  const b = block as { callView?: DiffCardView | null; resultView?: DiffCardView | null }
  return pick(b.resultView) ?? pick(b.callView)
}

/** Turn the built-in tool's contextual FileDiff hunks into one unified view:
 * an LCS per hunk (so context lines read neutral, not doubled), hunks joined by
 * a `⋯` gap on the hunk kind's dim tone. `oldText: null` (a create/overwrite)
 * is all additions. */
function viewFromNative(diffs: FileDiff[]): DiffView {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  diffs.forEach((d, idx) => {
    if (idx > 0) lines.push({ kind: 'hunk', text: '⋯' })
    if (d.oldText === null) {
      for (const t of contentLines(d.newText)) { lines.push({ kind: 'add', text: t }); added++ }
      return
    }
    const h = lcsLines(d.oldText, d.newText)
    lines.push(...h.lines)
    added += h.added
    removed += h.removed
  })
  return { lines, added, removed }
}

/** Build a diff view from the call ARGUMENTS — the fallback source when no
 * server diff is available (running `edit_file`, or any `write_file`). All
 * `oldText` lines are removals, all `newText` lines additions; no context (the
 * arguments carry none). Null routes the row to a plain note. */
function viewFromArgs(toolName: string, block: ToolCallBlock): DiffView | null {
  const record = argsRecordOf(block)
  if (record === null) return null
  const path = typeof record.path === 'string' ? record.path : undefined
  if (path === undefined) return null
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  const push = (oldText: string | null, newText: string) => {
    if (oldText !== null) for (const t of contentLines(oldText)) { lines.push({ kind: 'del', text: t }); removed++ }
    for (const t of contentLines(newText)) { lines.push({ kind: 'add', text: t }); added++ }
  }

  if (toolName.endsWith('write_file')) {
    const content = typeof record.content === 'string' ? record.content : undefined
    if (content === undefined) return null
    push(null, content) // whole-file write: every line is an addition
    return { lines, added, removed }
  }

  const edits = Array.isArray(record.edits) ? (record.edits as unknown[]) : undefined
  if (edits === undefined || edits.length === 0) return null
  for (const edit of edits) {
    if (typeof edit !== 'object' || edit === null) return null
    const { oldText, newText } = edit as Partial<FsEdit>
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null
    push(oldText, newText)
  }
  return { lines, added, removed }
}

/** Parse the server's git-style unified diff (a fenced ```diff block from
 * createTwoFilesPatch). We skip the `Index:`/`===`/`---`/`+++` preamble by
 * ignoring everything before the first `@@`, then classify body lines by their
 * leading sign — which also strips the surrounding code fence. Null when no
 * hunk is present (e.g. `write_file`'s "Successfully wrote to …" result). */
function parseServerDiff(text: string): DiffView | null {
  if (text === '') return null
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let seenHunk = false
  for (const raw of text.split('\n')) {
    if (raw.startsWith('```')) {
      if (seenHunk) break // closing fence ends the diff body
      continue // opening ```diff fence
    }
    if (raw.startsWith('@@')) {
      seenHunk = true
      lines.push({ kind: 'hunk', text: raw })
      continue
    }
    if (!seenHunk) continue // Index:/===/---/+++ preamble before the first hunk
    if (raw.startsWith('\\')) continue // "\ No newline at end of file"
    if (raw.startsWith('+')) { lines.push({ kind: 'add', text: raw.slice(1) }); added++ }
    else if (raw.startsWith('-')) { lines.push({ kind: 'del', text: raw.slice(1) }); removed++ }
    else lines.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw })
  }
  return seenHunk ? { lines, added, removed } : null
}

// Theme tokens shared with the native DiffBlock, so this card reads as one
// family with the built-in edit/write diff cards.
const COLOR: Record<DiffLineKind, string> = {
  hunk: 'var(--dsw-alias-label-tertiary)',
  add: 'var(--dsw-alias-state-success-primary)',
  del: 'var(--dsw-alias-state-error-primary)',
  ctx: 'var(--dsw-alias-label-primary)',
}
const SIGN: Record<DiffLineKind, string> = { hunk: '', add: '+ ', del: '- ', ctx: '  ' }

// Row fill: the state token mixed toward transparent, so add/del rows read as a
// green/red band (like Monaco's inserted/removedTextBackground) while still
// adapting to the active theme. Context and hunk rows keep the card surface.
const FILL: Record<DiffLineKind, string | undefined> = {
  add: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent)',
  del: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent)',
  hunk: undefined,
  ctx: undefined,
}

/** A colorized unified-diff card, collapsed by default so a run of file
 * mutations stays scannable in the chat flow. The native `<details>` carries
 * the open/closed state (no JS) — `<summary>` shows the path + `+N -M` count and
 * toggles the diff body on click. `badge` annotates non-tool mutations (bash);
 * `children` render after the diff lines (command/output for bash cards). */
function UnifiedDiff({ path, lines, added, removed, badge, children }: {
  path: string | null
  lines: DiffLine[]
  added: number
  removed: number
  badge?: string
  children?: ReactNode
}) {
  return (
    <details style={{
      margin: '16px 0',
      background: 'var(--dsw-alias-markdown-code-block)',
      borderRadius: 12,
      color: 'var(--dsw-alias-label-primary)',
    }}>
      <summary style={{
        padding: '10px 14px',
        cursor: 'pointer',
        font: 'var(--dsw-font-markdown-code-block)',
        color: 'var(--dsw-alias-label-secondary)',
        display: 'flex',
        gap: 12,
        alignItems: 'baseline',
        whiteSpace: 'pre',
        overflow: 'hidden',
      }}>
        <span style={{ display: 'flex', flexShrink: 0, alignSelf: 'center' }}>
          <IconChevronDownOutline14 className="dsh-mcp-diff-chev" />
        </span>
        {path !== null && (
          <span style={{
            fontWeight: 600,
            color: 'var(--dsw-alias-label-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>{path}</span>
        )}
        {badge !== undefined && (
          <span style={{ flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>{badge}</span>
        )}
        {lines.length > 0 && (
          <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
            <span style={{ color: 'var(--dsw-alias-state-success-primary)' }}>{`+${String(added)}`}</span>
            {' '}
            <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{`-${String(removed)}`}</span>
          </span>
        )}
      </summary>
      <div style={{
        padding: '4px 14px 12px',
        font: 'var(--dsw-font-markdown-code-block)',
        overflowX: 'auto',
        overflowY: 'hidden',
      }}>
        {lines.map((line, i) => (
          <div key={i} style={{
            whiteSpace: 'pre',
            minHeight: 22,
            color: COLOR[line.kind],
            background: FILL[line.kind],
            // Bleed the row fill to the card edges past the body padding, so the
            // band spans the full width instead of stopping at the text column.
            margin: '0 -14px',
            padding: '0 14px',
          }}>
            {SIGN[line.kind] + line.text}
          </div>
        ))}
        {children}
      </div>
    </details>
  )
}

/** The composed props the keyed slot hands each atomic tool view. Typed
 * loosely here (the fields this row reads) to avoid a value dependency on
 * ui-tool's contract types. */
interface McpDiffRowProps {
  toolName: string
  block: ToolCallBlock
  /** Session workspace root, for shortening workspace-rooted paths. */
  cwd?: string | undefined
  /** Session host home, so a terminal cwd equal to it collapses to `~`. */
  home?: string | undefined
  inspect?: () => void
}

/** Shorten a file path for display: a workspace-rooted file renders relative
 * to the session workspace, anything else stays absolute. */
function displayPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return path
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}

/** Diff row rendered as one unified card for every file mutation, MCP or
 * built-in, so they read identically:
 *   - built-in edit/write carry a `card:'diff'` view with contextual hunks →
 *     LCS-unified so context reads neutral.
 *   - MCP `edit_file` (settled) → the server's unified diff (context + `@@`).
 *   - MCP running edit / any MCP write → a view from the call arguments.
 * A non-diffable payload shows a short note so the row is never blank. */
function McpDiffRow({ toolName, block, cwd }: McpDiffRowProps) {
  const native = nativeDiffs(block)
  if (native !== null) {
    const view = viewFromNative(native)
    return <UnifiedDiff path={displayPath(native[0].path, cwd)} lines={view.lines} added={view.added} removed={view.removed} />
  }
  const view = (toolName.endsWith('edit_file') ? parseServerDiff(resultTextOf(block)) : null)
    ?? viewFromArgs(toolName, block)
  if (view === null) {
    return <div style={{ opacity: 0.6, fontSize: 12 }}>{toolName}</div>
  }
  const argsPath = pathOf(block)
  return <UnifiedDiff path={argsPath === null ? null : displayPath(argsPath, cwd)} lines={view.lines} added={view.added} removed={view.removed} />
}

function bashCommandOf(block: ToolCallBlock): string | null {
  const args = argsRecordOf(block)
  return args !== null && typeof args.command === 'string' ? args.command : null
}

function bashDescriptionOf(block: ToolCallBlock): string | null {
  const args = argsRecordOf(block)
  return args !== null && typeof args.description === 'string' ? args.description : null
}

/** Diff lines derivable from a parsed bash command: replace pairs LCS-unified,
 * heredoc write bodies as add rows. Path-only shapes yield no lines. */
function bashLines(edit: BashEdit): { lines: DiffLine[]; added: number; removed: number } {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  for (const pair of edit.pairs) {
    const unified = lcsLines(pair.old, pair.new)
    lines.push(...unified.lines)
    added += unified.added
    removed += unified.removed
  }
  for (const write of edit.writes) {
    if (write.body === null) continue
    for (const text of contentLines(write.body)) {
      lines.push({ kind: 'add', text })
      added++
    }
  }
  return { lines, added, removed }
}

function bashKindBadge(edit: BashEdit): string {
  const kinds = [
    edit.pairs.length > 0 ? 'replace' : null,
    edit.writes.length > 0 ? 'write' : null,
    edit.seds.length > 0 ? 'in-place' : null,
  ].filter((kind): kind is string => kind !== null)
  const files = edit.files.length > 1 ? ` · ${String(edit.files.length)} files` : ''
  return `bash edit · ${kinds.join('+')}${files}`
}

/** The bash-mutation card: intended diff from the command text, clearly badged
 * as a bash edit (not an edit/MCP result), with the full command and the
 * result tail one click away — that is all the client can honestly know.
 * The header always shows the first file; a multi-file command lists the
 * remaining paths in the body (for line-less cards — sed/redirect — that list
 * is the whole mutation picture besides command/output). */
function BashEditCard({ edit, command, block, cwd }: { edit: BashEdit; command: string; block: ToolCallBlock; cwd?: string | undefined }) {
  const view = bashLines(edit)
  const out = resultTextOf(block)
  const tail = out === '' ? '' : out.split('\n').slice(-31).join('\n')
  return (
    <UnifiedDiff
      path={edit.files.length > 0 ? displayPath(edit.files[0], cwd) : null}
      lines={view.lines}
      added={view.added}
      removed={view.removed}
      badge={bashKindBadge(edit)}
    >
      {edit.files.length > 1 && (
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', margin: '6px 0 2px' }}>
          {`also touches: ${edit.files.slice(1).map((f) => displayPath(f, cwd)).join(', ')}`}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', margin: '6px 0 2px' }}>
        intended change parsed from the bash command — not an edit/MCP tool result
      </div>
      <details style={{ marginTop: 2 }}>
        <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>command</summary>
        <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{command}</pre>
      </details>
      {tail !== '' && (
        <details style={{ marginTop: 2 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>output</summary>
          <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{tail}</pre>
        </details>
      )}
    </UnifiedDiff>
  )
}

/** Terminal-card props from the raw block, mirroring the essentials of ui-tool's
 * terminalCardModel (not importable from a plugin): the call side carries the
 * command and its working directory, the result side the output and exit
 * status. Null → not a terminal card (the call should not draw a terminal). */
function terminalCardProps(block: ToolCallBlock, sessionCwd: string | undefined, home: string | undefined): TerminalBlockProps | null {
  const call = block.callView !== null && block.callView.card === 'terminal' ? block.callView : null
  const cwd = call === null || call.cwd === undefined || call.cwd === ''
    ? sessionCwd
    : sessionCwd === undefined ? call.cwd : resolveWorkspacePath(sessionCwd, call.cwd)
  if (!('kind' in block)) {
    return call === null ? null : { command: call.title, cwd, home, running: true }
  }
  const result = block.resultView !== null && block.resultView.card === 'terminal' ? block.resultView : null
  if (result === null) return null
  return {
    command: result.title ?? call?.title ?? '',
    cwd: call === null ? undefined : cwd,
    home,
    output: result.output,
    exitCode: result.exitCode,
    signal: result.signal,
  }
}

/** The plain bash row for non-mutating commands — a replica of the core
 * bash-sample row this view shadows: an icon + `Bash · description` summary
 * toggle (red state dot on failure), and the command's own TerminalBlock
 * (prompt, Done/exit pill, Copy, native output handling) inside, plus Inspect.
 * The keyed slot hands us every bash call, so this row must render for all of
 * them; only the chrome around the block is hand-rolled. */
function TerminalCard({ toolName, block, cwd, home, inspect }: McpDiffRowProps) {
  const card = terminalCardProps(block, cwd, home)
  const command = card?.command ?? bashCommandOf(block) ?? ''
  const description = bashDescriptionOf(block)
  const summary = description ?? (command !== '' ? command.split('\n')[0] : null)
  const failed = card !== null && card.running !== true
    && ((card.exitCode !== undefined && card.exitCode !== 0) || card.signal !== undefined)
  return (
    <details style={{
      margin: '16px 0',
      background: 'var(--dsw-alias-markdown-code-block)',
      borderRadius: 12,
      font: 'var(--dsw-font-markdown-code-block)',
      color: 'var(--dsw-alias-label-primary)',
    }}>
      <summary style={{
        padding: '8px 14px',
        cursor: 'pointer',
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        overflow: 'hidden',
      }}>
        {failed ? <StateDot state="error" /> : <IconApiOutline14 size={14} />}
        <span style={{ fontWeight: 600, flexShrink: 0 }}>
          {toolName.charAt(0).toUpperCase() + toolName.slice(1)}
        </span>
        {summary !== null && (
          <span style={{
            color: 'var(--dsw-alias-label-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{summary}</span>
        )}
        <span style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex' }}>
          <IconChevronDownOutline14 className="dsh-mcp-diff-chev" />
        </span>
      </summary>
      <div style={{ padding: '0 14px 12px' }}>
        {card !== null && <TerminalBlock {...card} />}
        {inspect !== undefined && (
          <button type="button" onClick={inspect} style={{
            marginTop: 8,
            padding: '2px 10px',
            font: 'inherit',
            fontSize: 11,
            color: 'var(--dsw-alias-label-secondary)',
            background: 'transparent',
            border: '1px solid var(--dsw-alias-label-tertiary)',
            borderRadius: 8,
            cursor: 'pointer',
          }}>Inspect</button>
        )}
      </div>
    </details>
  )
}

/** Bash tool row: a file-mutating command renders as a badged diff-style card;
 * everything else keeps a plain terminal-like card. The keyed slot hands us
 * every bash call, so the null path (no recognizable mutation) must still
 * render the whole row. */
function BashRow(props: McpDiffRowProps) {
  const command = bashCommandOf(props.block)
  const edit = command === null ? null : parseBashEdit(command)
  if (edit === null || command === null) return <TerminalCard {...props} />
  return <BashEditCard edit={edit} command={command} block={props.block} cwd={props.cwd} />
}

/** Services this browser half reads; activation waits on the slot service. */
export const inject = ['slots']

/** Plugin name: matches the package name and the composition row id family. */
export const name = 'dsh-mcp-diff'

/** One-shot stylesheet for what inline styles cannot express: the chevron
 * rotating once its <details> opens. Idempotent across activations. */
function ensureCardStyle(): void {
  if (document.getElementById('dsh-mcp-diff-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-mcp-diff-style'
  style.textContent = [
    '.dsh-mcp-diff-chev{transition:transform .15s ease;color:var(--dsw-alias-label-tertiary)}',
    'details[open]>summary .dsh-mcp-diff-chev{transform:rotate(90deg)}',
  ].join('\n')
  document.head.appendChild(style)
}

/**
 * Register the diff row into the Tool-owned keyed view slot under each owned
 * tool name (MCP filesystem mutations + the built-in edit/write). A keyed
 * registration shadows the shipped one, so edit/write route through this card
 * too; `slots.inject` defers until the slot declaration is live and re-runs
 * across the owner's HMR lifetime.
 *
 * The `bash` key routes through BashRow: diff-style cards for recognizable
 * line mutations, a terminal-like card for everything else (the keyed slot has
 * no per-call decline, so the view owns the whole tool and must always render).
 * @param ctx - client root context (disposal rides ctx.effect inside register).
 */
export function apply(ctx: Context): void {
  ensureCardStyle()
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of MCP_TOOL_KEYS) {
      yield ctx.slots.register({ name: 'tool.call.toolview', key }, McpDiffRow)
    }
    for (const key of BUILTIN_TOOL_KEYS) {
      yield ctx.slots.register({ name: 'tool.call.toolview', key, priority: -1 }, McpDiffRow)
    }
    // bash-toolview-sample owns `bash` at priority 0; shadow like edit/write.
    yield ctx.slots.register(
      { name: 'tool.call.toolview', key: 'bash', priority: -1 },
      BashRow,
    )
  })
}
