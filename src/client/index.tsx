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
 * The bundle may only value-import the platform module table (react,
 * ui-primitives, ui-slots, runtime/client); ui-tool internals are off-limits by
 * the client purity gate, so the diff card is a small local component styled
 * with the same theme tokens the native DiffBlock uses. The ui-tool import stays
 * type-only (it activates the `tool.call.toolview` SlotMap augmentation).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: activates the `tool.call.toolview` slot declaration on SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'

/** Wire tool names this plugin owns. Change the `filesystem` segment here if
 * your MCP filesystem server is mounted under a different `serverName`. */
const TOOL_KEYS = ['mcp__filesystem__edit_file', 'mcp__filesystem__write_file'] as const

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

/** A colorized unified-diff card (context lines + `@@` headers preserved). */
function UnifiedDiff({ path, lines, added, removed }: {
  path: string | null
  lines: DiffLine[]
  added: number
  removed: number
}) {
  return (
    <div style={{
      margin: '16px 0',
      background: 'var(--dsw-alias-markdown-code-block)',
      borderRadius: 12,
      color: 'var(--dsw-alias-label-primary)',
    }}>
      <div style={{
        padding: '12px 14px',
        font: 'var(--dsw-font-markdown-code-block)',
        overflowX: 'auto',
        overflowY: 'hidden',
      }}>
        {path !== null && (
          <div style={{ fontWeight: 600, whiteSpace: 'pre', minHeight: 22 }}>{path}</div>
        )}
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
      </div>
      <div style={{
        padding: '0 14px 12px',
        font: 'var(--dsw-font-markdown-code-block)',
        color: 'var(--dsw-alias-label-tertiary)',
      }}>
        {`└ +${String(added)} -${String(removed)}`}
      </div>
    </div>
  )
}

/** The composed props the keyed slot hands each atomic tool view. Typed
 * loosely here (the fields this row reads) to avoid a value dependency on
 * ui-tool's contract types. */
interface McpDiffRowProps {
  toolName: string
  block: ToolCallBlock
}

/** Diff row for an MCP filesystem mutation, rendered as one unified-diff card
 * regardless of tool or lifecycle: the settled server diff for `edit_file`
 * (context + `@@` headers), else an args-derived view (running edit, or any
 * write). A non-diffable payload shows a short note so the row is never blank. */
function McpDiffRow({ toolName, block }: McpDiffRowProps) {
  const view = (toolName.endsWith('edit_file') ? parseServerDiff(resultTextOf(block)) : null)
    ?? viewFromArgs(toolName, block)
  if (view === null) {
    return <div style={{ opacity: 0.6, fontSize: 12 }}>{toolName}</div>
  }
  return <UnifiedDiff path={pathOf(block)} lines={view.lines} added={view.added} removed={view.removed} />
}

/** Services this browser half reads; activation waits on the slot service. */
export const inject = ['slots']

/** Plugin name: matches the package name and the composition row id family. */
export const name = 'dsh-mcp-diff'

/**
 * Register the diff row into the Tool-owned keyed view slot under each MCP
 * filesystem mutation name. `slots.inject` defers the registration until the
 * slot declaration is live and re-runs it across the owner's HMR lifetime.
 * @param ctx - client root context (disposal rides ctx.effect inside register).
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of TOOL_KEYS) {
      yield ctx.slots.register({ name: 'tool.call.toolview', key }, McpDiffRow)
    }
  })
}
