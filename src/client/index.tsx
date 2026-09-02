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
 * `move_file` is a mutation without a diff: its card is informational —
 * `source → destination` in the same card family (no diff lines exist).
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
import { useMemo, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconApiOutline14, IconCheckOutline16, IconChevronDownOutline14, IconCopyOutline16,
  StateDot, TerminalBlock, writeClipboard,
  type TerminalBlockLabels, type TerminalBlockProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: activates the `tool.call.toolview` slot declaration on SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'

// The host merges the `conversation` dictionary namespace (and the shared
// `common` vocabulary) into LocaleNamespaceMap from packages this plugin does
// not depend on — declare the keys this view consumes so `locale:
// 'conversation'` typechecks and the framework-synthesized `t` seat is typed.
// At runtime the host's real dictionaries serve every lookup; this local merge
// types only this compilation.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    conversation:
      | 'terminal.signal'
      | 'terminal.exitCode'
      | 'terminal.running'
      | 'terminal.failed'
      | 'terminal.done'
      | 'terminal.noOutput'
      | 'terminal.collapseAria'
      | 'terminal.expandAria'
      | 'terminal.expandRest'
    common: 'copy' | 'copied' | 'collapse'
  }
}
import { parseBashEdit, type BashEdit } from './parse-bash'
import { containedOpenPath } from './paths'

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

/** MCP filesystem `move_file` (args `{ source, destination }`) — a free key
 * like the two above, but a move carries no diff, so it gets its own info
 * row instead of McpDiffRow. */
const MCP_MOVE_FILE_KEY = 'mcp__filesystem__move_file'

/** MCP filesystem `create_directory` (args `{ path }`) — the same family:
 * no diff, an informational row. */
const MCP_CREATE_DIR_KEY = 'mcp__filesystem__create_directory'

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
  const flat = text.replace(/\r\n/g, '\n')
  const body = flat.endsWith('\n') ? flat.slice(0, -1) : flat
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
  // Past the table-size threshold the dp allocation would reach hundreds of MB
  // on the GUI main thread; degenerate to del-all/add-all (context lost, the
  // +N -M counts stay exact).
  if (n * m > LCS_CELL_LIMIT) {
    return {
      lines: [
        ...a.map((text): DiffLine => ({ kind: 'del', text })),
        ...b.map((text): DiffLine => ({ kind: 'add', text })),
      ],
      added: m,
      removed: n,
    }
  }
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

/** LCS dp cells above which a hunk pair degenerates to del-all/add-all:
 * 1000 × 1000 lines — far above any real edit hunk, far below an OOM. */
const LCS_CELL_LIMIT = 1_000_000

/** Diff rows a card renders before the body footer truncates the rest. The
 * card body scrolls at ~20 visible rows, so 400 keeps expansion and scrolling
 * light no matter how large the diff is. */
const MAX_RENDERED_ROWS = 400

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

/** The server's fenced ```diff block with the fences stripped — a real,
 * `git apply`-able patch (only offered for a settled `edit_file` whose result
 * parsed as one). Null when the text carries no fenced diff. */
function fencedDiffText(text: string): string | null {
  const start = text.indexOf('```diff')
  if (start === -1) return null
  const bodyStart = text.indexOf('\n', start)
  if (bodyStart === -1) return null
  const end = text.indexOf('```', bodyStart)
  if (end === -1) return null
  return text.slice(bodyStart + 1, end)
}

/** One copy affordance: a ghost icon button with a transient copied state
 * (check icon), wired to the primitives' clipboard channel. Copies on click,
 * never on render. */
function CopyButton({ getText, label }: { getText: () => string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void writeClipboard(getText()).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button type="button" aria-label={label} title={label} onClick={copy} style={{
      display: 'flex',
      alignItems: 'center',
      padding: '2px 6px',
      font: 'inherit',
      fontSize: 11,
      color: copied ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)',
      background: 'transparent',
      border: 'none',
      borderRadius: 6,
      cursor: 'pointer',
    }}>{copied ? <IconCheckOutline16 size={14} /> : <IconCopyOutline16 size={14} />}</button>
  )
}

/** A small ghost text chip for card-body toggles (wrap, show-all) — the
 * Inspect-button look, always off the <summary> toggle path. */
function ToggleChip({ on, onClick, children }: {
  on?: boolean
  onClick: () => void
  children: ReactNode
}): ReactNode {
  return (
    <button type="button" onClick={onClick} style={{
      padding: '2px 8px',
      font: 'inherit',
      fontSize: 11,
      color: on === true ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)',
      background: 'transparent',
      border: '1px solid var(--dsw-alias-label-tertiary)',
      borderRadius: 8,
      cursor: 'pointer',
    }}>{children}</button>
  )
}

/** Card action row: copy the diff as text, the command, or the real server
 * patch when one exists, plus view toggles on the left. Rendered at the top
 * of the card body — visible when expanded, off the <summary> toggle path. */
function CardActions({ diff, patch, command, left }: {
  diff: (() => string) | null
  patch?: string | null
  command?: string | null
  left?: ReactNode
}): ReactNode {
  if (diff === null && (patch === undefined || patch === null) && (command === undefined || command === null) && left === undefined) return null
  return (
    <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end', margin: '0 -14px 2px', padding: '0 14px' }}>
      {left !== undefined && (
        <span style={{ display: 'flex', gap: 4, marginRight: 'auto' }}>{left}</span>
      )}
      {command !== undefined && command !== null && <CopyButton getText={() => command} label="copy command" />}
      {diff !== null && <CopyButton getText={diff} label="copy diff" />}
      {patch !== undefined && patch !== null && <CopyButton getText={() => patch} label="copy patch (git apply)" />}
    </div>
  )
}

/** The summary path as an open-file affordance: a real button calling the
 * host's file opener (the same channel the native tool rows use — the host
 * resolves the path against the session workspace and opens it in the user's
 * IDE/editor). Click and Enter/Space never reach the <details> toggle,
 * mirroring the core ToolRow's file-link behaviour. */
function PathLink({ path, onOpen }: { path: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="dsh-mcp-diff-filelink"
      onClick={(event) => { event.stopPropagation(); onOpen() }}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}
    >{path}</button>
  )
}

/** A colorized unified-diff card, collapsed by default so a run of file
 * mutations stays scannable in the chat flow. The native `<details>` carries
 * the open/closed state (no JS) — `<summary>` shows the path + `+N -M` count and
 * toggles the diff body on click. `badge` annotates non-tool mutations (bash);
 * `children` render after the diff lines (command/output for bash cards). */
function UnifiedDiff({ path, lines, added, removed, badge, state, openPath, openFile, copyPatch, copyCommand, children }: {
  path: string | null
  lines: DiffLine[]
  added: number
  removed: number
  badge?: string
  /** Collapsed-row outcome; a badge renders in the summary when present. */
  state?: RowState
  /** The card's path spelled for the host opener, when it is openable. */
  openPath?: string | null
  openFile?: ((path: string) => void) | undefined
  /** A real server patch (settled `edit_file`), fence-stripped. */
  copyPatch?: string | null
  /** The full bash command, for the command copy button. */
  copyCommand?: string | null
  children?: ReactNode
}) {
  // Per-card view state (persists across collapse/expand): wrap re-flows long
  // lines; show-all lifts the render cap for THIS card only, by explicit
  // click — the default stays capped.
  const [wrap, setWrap] = useState(false)
  const [renderAll, setRenderAll] = useState(false)
  const truncated = !renderAll && lines.length > MAX_RENDERED_ROWS
  const shown = renderAll ? lines : lines.slice(0, MAX_RENDERED_ROWS)
  return (
    <details data-state={state !== undefined ? state : undefined} style={{
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
        {/* Outcome badge: fixed 14px slot so the summary text and the
            running→done swap never shift the row layout. */}
        {state !== undefined && (
          <span style={{ display: 'flex', width: 14, flexShrink: 0, alignSelf: 'center', justifyContent: 'center' }}>
            <StateBadge state={state} />
          </span>
        )}
        {path !== null && (
          openPath !== undefined && openPath !== null && openFile !== undefined
            ? (
              <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <PathLink path={path} onOpen={() => openFile(openPath)} />
              </span>
            )
            : (
              <span style={{
                fontWeight: 600,
                color: 'var(--dsw-alias-label-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>{path}</span>
            )
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
        // Cap the visible body at ~20 rows and scroll inside the card, so a
        // large diff expands in place instead of taking over the chat flow.
        // Kept on this same div as the horizontal scroller: the rows' full-bleed
        // fill (negative margins) must stay inside ONE scroll context.
        maxHeight: 448,
        overflowY: 'auto',
      }}>
        {(lines.length > 0 || (copyCommand !== undefined && copyCommand !== null)) && (
          <CardActions
            diff={lines.length > 0 ? () => lines.map((line) => SIGN[line.kind] + line.text).join('\n') : null}
            patch={copyPatch}
            command={copyCommand}
            left={
              <>
                {lines.length > MAX_RENDERED_ROWS && (
                  <ToggleChip on={renderAll} onClick={() => setRenderAll((v) => !v)}>
                    {renderAll ? 'collapse' : `show all ${String(lines.length)}`}
                  </ToggleChip>
                )}
                <ToggleChip on={wrap} onClick={() => setWrap((v) => !v)}>wrap</ToggleChip>
              </>
            }
          />
        )}
        {shown.map((line, i) => (
          <div key={i} style={{
            whiteSpace: wrap ? 'pre-wrap' : 'pre',
            wordBreak: wrap ? 'break-all' : undefined,
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
        {truncated && (
          <div style={{
            fontSize: 11,
            color: 'var(--dsw-alias-label-tertiary)',
            margin: '4px 0 0',
          }}>{`+ ${String(lines.length - MAX_RENDERED_ROWS)} more lines not rendered`}</div>
        )}
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
  /** Host file opener (the native tool rows' channel): resolves against the
   * session cwd and opens in the user's IDE/editor. */
  openFile?: ((path: string) => void) | undefined
  /** Conversation locale seat, present on the `bash` entry only (the one
   * registration declaring `locale:`); other rows render without it. */
  t?: TranslateNS<'conversation'> | undefined
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
function McpDiffRow({ toolName, block, cwd, openFile }: McpDiffRowProps) {
  const native = nativeDiffs(block)
  if (native !== null) {
    const view = viewFromNative(native)
    return <UnifiedDiff path={displayPath(native[0].path, cwd)} openPath={containedOpenPath(native[0].path, undefined, cwd)} openFile={openFile} lines={view.lines} added={view.added} removed={view.removed} state={rowState(block)} />
  }
  const serverText = toolName.endsWith('edit_file') ? resultTextOf(block) : ''
  const view = parseServerDiff(serverText) ?? viewFromArgs(toolName, block)
  if (view === null) {
    return <div style={{ opacity: 0.6, fontSize: 12 }}>{toolName}</div>
  }
  const argsPath = pathOf(block)
  return <UnifiedDiff path={argsPath === null ? null : displayPath(argsPath, cwd)} openPath={argsPath === null ? null : containedOpenPath(argsPath, undefined, cwd)} openFile={openFile} lines={view.lines} added={view.added} removed={view.removed} state={rowState(block)} copyPatch={fencedDiffText(serverText)} />
}

/** The MCP filesystem `move_file` call as an informational card: a rename has
 * no diff lines, so the summary IS the content — `source` in the header under
 * a `move` badge, the destination in the body, both workspace-shortened.
 * Reusing UnifiedDiff buys the family style and the collapse chevron for
 * free. While args stream in (or for a foreign shape) — the same dim toolName
 * row McpDiffRow falls back to. */
function MoveFileRow({ toolName, block, cwd, openFile }: McpDiffRowProps) {
  const args = argsRecordOf(block)
  const source = args !== null && typeof args.source === 'string' ? args.source : null
  const destination = args !== null && typeof args.destination === 'string' ? args.destination : null
  if (source === null || destination === null) {
    return <div style={{ opacity: 0.6, fontSize: 12 }}>{toolName}</div>
  }
  const destOpen = containedOpenPath(destination, undefined, cwd)
  return (
    <UnifiedDiff
      path={displayPath(source, cwd)}
      openPath={containedOpenPath(source, undefined, cwd)}
      openFile={openFile}
      lines={[]}
      added={0}
      removed={0}
      badge="move"
      state={rowState(block)}
    >
      <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '6px 0 2px' }}>
        {'→ '}
        {openFile !== undefined && destOpen !== null
          ? <PathLink path={displayPath(destination, cwd)} onOpen={() => openFile(destOpen)} />
          : displayPath(destination, cwd)}
      </div>
    </UnifiedDiff>
  )
}

/** The MCP filesystem `create_directory` call as an informational card —
 * a directory creation has no diff lines, so the header path IS the content
 * under a `mkdir` badge. Same shape as MoveFileRow: while args stream in
 * (or a foreign shape) — the dim toolName row. */
function CreateDirRow({ toolName, block, cwd, openFile }: McpDiffRowProps) {
  const args = argsRecordOf(block)
  const path = args !== null && typeof args.path === 'string' ? args.path : null
  if (path === null) {
    return <div style={{ opacity: 0.6, fontSize: 12 }}>{toolName}</div>
  }
  return (
    <UnifiedDiff
      path={displayPath(path, cwd)}
      openPath={containedOpenPath(path, undefined, cwd)}
      openFile={openFile}
      lines={[]}
      added={0}
      removed={0}
      badge="mkdir"
      state={rowState(block)}
    />
  )
}

function bashCommandOf(args: Record<string, unknown> | null): string | null {
  return args !== null && typeof args.command === 'string' ? args.command : null
}

function bashDescriptionOf(args: Record<string, unknown> | null): string | null {
  return args !== null && typeof args.description === 'string' ? args.description : null
}

/** The parsed args record, memoized on the raw args string: bash rows
 * re-render on every streaming chunk, and re-parsing identical JSON per
 * render burns the main thread for no new information. */
function useArgs(block: ToolCallBlock): Record<string, unknown> | null {
  const raw = argsRawOf(block)
  return useMemo(() => argsRecordOf(block), [raw])
}

/** Collapsed-row outcome states, mirroring the core's ToolRowState one-to-one
 * for the subset this plugin can derive from the raw block; `neutral` is the
 * background-ack case, where the block honestly carries no command outcome. */
type RowState = 'running' | 'ok' | 'error' | 'stopped' | 'neutral'

/** Derive the collapsed-row outcome from the raw block, the bash-row analogue
 * of ui-tool's toolRowModel: running until a result settles; error when the
 * settled result view carries a failing exit status (non-zero code or a
 * signal), when a view-less result settled isError, or when the call itself
 * failed; stopped when the call was interrupted; neutral for a background
 * ack (the settled block carries a job id, not a command outcome — the run
 * lives on in the jobs panel, so neither green nor red is honest); ok
 * otherwise (a clean exit 0). `kind` in block discriminates running vs
 * settled.
 * @param block - the raw tool-call block off the snapshot.
 * @returns the outcome state for the collapsed row. */
function rowState(block: ToolCallBlock, args?: Record<string, unknown> | null): RowState {
  if (!('kind' in block)) return 'running'
  const error = (block as { error?: { code?: unknown } | undefined }).error
  if (error?.code === 'interrupted') return 'stopped'
  if ((block as { isError?: unknown }).isError === true) return 'error'
  const result = block.resultView != null && block.resultView.card === 'terminal' ? block.resultView : null
  if (result === null && (args ?? argsRecordOf(block))?.run_in_background === true) return 'neutral'
  if (result !== null
    && ((result.exitCode !== undefined && result.exitCode !== 0) || result.signal !== undefined)) {
    return 'error'
  }
  return 'ok'
}

/** The collapsed-row status signal: just the dot, no text. A StateDot in
 * the state's color (ongoing chase while running, solid green on a clean
 * exit, red on a failing exit or an execution error, amber when
 * interrupted). StateDot is aria-hidden, so the wrapper's role=img +
 * aria-label carries the status to screen readers without rendering
 * anything. Neutral (a background ack) shows the terminal icon: no outcome
 * exists to color. */
function StateBadge({ state }: { state: RowState }): ReactNode {
  if (state === 'neutral') return <IconApiOutline14 size={14} />
  const dot = state === 'running' ? <StateDot state="ongoing" />
    : state === 'ok' ? <StateDot state="done" />
      : state === 'error' ? <StateDot state="error" />
        : <StateDot state="warning" />
  const label = state === 'running' ? 'running'
    : state === 'error' ? 'failed'
      : state === 'stopped' ? 'stopped'
        : 'done'
  return <span role="img" aria-label={label}>{dot}</span>
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
  if (edit.ops.length > 0) {
    const kinds = [...new Set(edit.ops.map((o) => o.op))].join('+')
    return `bash ${kinds}`
  }
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
function BashEditCard({ edit, command, block, cwd, openFile, args }: { edit: BashEdit; command: string; block: ToolCallBlock; cwd?: string | undefined; openFile?: ((path: string) => void) | undefined; args?: Record<string, unknown> | null }) {
  const view = bashLines(edit)
  // Open base for the command's file paths: the terminal call's working
  // directory when present (it may be session-relative), else the session
  // workspace itself. containedOpenPath resolves base against the workspace,
  // then gates the result — a path parsed out of command text may only become
  // a link when it stays inside the session workspace. Links are suppressed
  // when a `cd` shifted the base mid-command, and for dynamic targets
  // (`$VAR`, globs): a wrong link is worse than no link.
  const call = block.callView != null && block.callView.card === 'terminal' ? block.callView : null
  const base = call !== null && typeof call.cwd === 'string' && call.cwd !== '' ? call.cwd : undefined
  const toOpen = (file: string): string | null => {
    if (edit.cdShifted || /[$*?`]/.test(file)) return null
    return containedOpenPath(file, base, cwd)
  }
  const out = resultTextOf(block)
  const tail = out === '' ? '' : out.split('\n').slice(-31).join('\n')
  const tailShown = tail.length > 4000 ? `…${tail.slice(-4000)}` : tail
  const flatCommand = command.replace(/\r\n/g, '\n')
  const commandShown = flatCommand.length > 20000 ? `…${flatCommand.slice(-20000)}` : flatCommand
  const state = rowState(block, args)
  const mixedWithOps = edit.ops.length > 0
    && (edit.pairs.length > 0 || edit.writes.length > 0 || edit.seds.length > 0)
  return (
    <UnifiedDiff
      path={edit.files.length > 0 ? displayPath(edit.files[0], cwd) : null}
      openPath={edit.files.length > 0 ? toOpen(edit.files[0]) : null}
      openFile={openFile}
      lines={view.lines}
      added={view.added}
      removed={view.removed}
      badge={bashKindBadge(edit)}
      state={state}
      copyCommand={flatCommand}
    >
      {mixedWithOps && (
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', margin: '6px 0 2px' }}>
          {'also performs: '}
          {edit.ops.map((o) => `${o.op} ${o.args.join(' ')}`).join('; ')}
        </div>
      )}
      {edit.files.length > 1 && (
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', margin: '6px 0 2px' }}>
          {'also touches: '}
          {edit.files.slice(1).map((f, i) => {
            const open = toOpen(f)
            return (
              <span key={f}>
                {i > 0 && ', '}
                {openFile !== undefined && open !== null
                  ? <PathLink path={displayPath(f, cwd)} onOpen={() => openFile(open)} />
                  : displayPath(f, cwd)}
              </span>
            )
          })}
        </div>
      )}
      {state === 'running' && (
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', margin: '6px 0 2px' }}>
          command still running — output will appear when it settles
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', margin: '6px 0 2px' }}>
        intended change parsed from the bash command — not an edit/MCP tool result
      </div>
      <details style={{ marginTop: 2 }}>
        <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>command</summary>
        <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{commandShown}</pre>
      </details>
      {tail !== '' && (
        <details style={{ marginTop: 2 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>output</summary>
          <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{tailShown}</pre>
        </details>
      )}
    </UnifiedDiff>
  )
}

/** Build the TerminalBlock display copy from the conversation locale seat —
 * a local replica of ui-tool's terminalBlockLabels (internal, not importable
 * from a plugin). Without it the primitive's Chinese DEFAULT_LABELS show
 * (复制/已完成) regardless of the GUI language, because the primitive is
 * cordis-free and receives every label through props. The lookup chain
 * consults the shared `common` namespace after `conversation` misses
 * (copy/copied/collapse live there). */
function terminalBlockLabels(t: TranslateNS<'conversation'>): TerminalBlockLabels {
  return {
    signal: signal => t('terminal.signal', { signal }),
    exitCode: code => t('terminal.exitCode', { code }),
    running: t('terminal.running'),
    failed: t('terminal.failed'),
    done: t('terminal.done'),
    copy: t('copy'),
    copied: t('copied'),
    noOutput: t('terminal.noOutput'),
    collapseAria: t('terminal.collapseAria'),
    collapse: t('collapse'),
    expandAria: hidden => t('terminal.expandAria', { n: hidden }),
    expand: hidden => t('terminal.expandRest', { n: hidden }),
  }
}

/** Terminal-card props from the raw block, mirroring the essentials of ui-tool's
 * terminalCardModel (not importable from a plugin): the call side carries the
 * command and its working directory, the result side the output and exit
 * status. Null → not a terminal card (the call should not draw a terminal).
 *
 * Code-dispatch SUB-calls never carry render views — the runtime mints them
 * with `callView: null` and a settled `resultView: null` (only the result
 * `content` survives). A top-level call can settle view-less too (an execution
 * error without terminal material). There the raw block itself still names
 * the command (args) and its output (content text), so the card is assembled
 * from that instead of collapsing to an empty body. */
function terminalCardProps(block: ToolCallBlock, sessionCwd: string | undefined, home: string | undefined, args: Record<string, unknown> | null): TerminalBlockProps | null {
  const call = block.callView != null && block.callView.card === 'terminal' ? block.callView : null
  const cwd = call === null || call.cwd === undefined || call.cwd === ''
    ? sessionCwd
    : sessionCwd === undefined ? call.cwd : resolveWorkspacePath(sessionCwd, call.cwd)
  if (!('kind' in block)) {
    // Running without a call view: a view-less sub-call mid-flight. Keep the
    // terminal shape (command + running) so the row is honest about it.
    return { command: call?.title ?? bashCommandOf(args) ?? '', cwd, home, running: true }
  }
  const result = block.resultView != null && block.resultView.card === 'terminal' ? block.resultView : null
  if (result !== null) {
    return {
      command: result.title ?? call?.title ?? '',
      cwd: call === null ? undefined : cwd,
      home,
      output: result.output,
      exitCode: result.exitCode,
      signal: result.signal,
    }
  }
  // Settled without a terminal view: fall back to the raw material — the
  // command from the call args, the output from the result content text.
  // Empty output is preserved (TerminalBlock draws its own no-output state).
  const output = resultTextOf(block)
  return {
    command: call?.title ?? bashCommandOf(args) ?? '',
    cwd: call === null ? undefined : cwd,
    home,
    output: output === '' ? undefined : output,
  }
}

/** The plain bash row for non-mutating commands — a replica of the core
 * bash-sample row this view shadows: an icon + `Bash · description` summary
 * toggle (red state dot on failure), and the command's own TerminalBlock
 * (prompt, Done/exit pill, Copy, native output handling) inside, plus Inspect.
 * The keyed slot hands us every bash call, so this row must render for all of
 * them; only the chrome around the block is hand-rolled. */
function TerminalCard({ toolName, block, cwd, home, inspect, t }: McpDiffRowProps) {
  const args = useArgs(block)
  const card = terminalCardProps(block, cwd, home, args)
  const command = card?.command ?? bashCommandOf(args) ?? ''
  const description = bashDescriptionOf(args)
  const summary = description ?? (command !== '' ? command.split('\n')[0] : null)
  const state = rowState(block, args)
  return (
    <details data-state={state} style={{
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
        <span style={{ display: 'flex', width: 14, flexShrink: 0, alignSelf: 'center', justifyContent: 'center' }}>
          <StateBadge state={state} />
        </span>
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
        {card !== null && <TerminalBlock {...card} labels={t === undefined ? undefined : terminalBlockLabels(t)} />}
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
  const args = useArgs(props.block)
  const command = bashCommandOf(args)
  // Memoized on the command text: the row re-renders on every streaming chunk
  // of the call, and re-parsing a large command each time would burn the main
  // thread for no new information.
  const edit = useMemo(() => (command === null ? null : parseBashEdit(command)), [command])
  if (edit === null || command === null) return <TerminalCard {...props} />
  // Path ops (mv/cp/mkdir/rm/touch) render through the same card with zero
  // diff lines: the summary names the op, the body lists the paths.
  return <BashEditCard edit={edit} command={command} block={props.block} cwd={props.cwd} openFile={props.openFile} args={args} />
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
    // The summary path as an open-file link: the core ToolRow fileLink look.
    '.dsh-mcp-diff-filelink{margin:0;padding:0;border:none;background:none;font:inherit;color:inherit;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:pre;text-decoration:underline;text-decoration-color:var(--dsw-alias-label-quaternary);text-underline-offset:3px;cursor:pointer}',
    '.dsh-mcp-diff-filelink:hover{color:var(--dsw-alias-label-primary);text-decoration-color:currentColor}',
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
    // move_file: no diff to show — an informational source → destination card.
    yield ctx.slots.register({ name: 'tool.call.toolview', key: MCP_MOVE_FILE_KEY }, MoveFileRow)
    // create_directory: same family — an informational header-path card.
    yield ctx.slots.register({ name: 'tool.call.toolview', key: MCP_CREATE_DIR_KEY }, CreateDirRow)
    for (const key of BUILTIN_TOOL_KEYS) {
      yield ctx.slots.register({ name: 'tool.call.toolview', key, priority: -1 }, McpDiffRow)
    }
    // bash-toolview-sample owns `bash` at priority 0; shadow like edit/write.
    // `locale:` puts the framework-synthesized `t` seat on BashRow props, so
    // the terminal card labels follow the GUI language instead of the
    // primitive's Chinese DEFAULT_LABELS.
    yield ctx.slots.register(
      { name: 'tool.call.toolview', key: 'bash', priority: -1, locale: 'conversation' },
      BashRow,
    )
  })
}
