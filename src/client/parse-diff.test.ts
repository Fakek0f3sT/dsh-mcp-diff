/**
 * Self-check for parseServerDiff — the one non-trivial branch in this plugin.
 * Runs the parser against a real `edit_file` server diff and asserts the
 * classified lines. No framework: `node --import tsx/esm src/client/parse-diff.test.ts`.
 *
 * parseServerDiff is defined inside index.tsx (browser bundle, no test export),
 * so this check reproduces it verbatim. If you change the parser in index.tsx,
 * mirror it here — the copy is what keeps this a zero-import, one-file check.
 *
 * @ts-nocheck: the plugin targets the browser and carries no Node types; the
 * node:assert import below is runtime-valid under the tsx loader only.
 */
// @ts-nocheck
import assert from 'node:assert/strict'

type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx'
interface DiffLine { kind: DiffLineKind; text: string }
interface DiffView { lines: DiffLine[]; added: number; removed: number }

function parseServerDiff(text: string): DiffView | null {
  if (text === '') return null
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let seenHunk = false
  for (const raw of text.split('\n')) {
    if (raw.startsWith('```')) { if (seenHunk) break; continue }
    if (raw.startsWith('@@')) { seenHunk = true; lines.push({ kind: 'hunk', text: raw }); continue }
    if (!seenHunk) continue
    if (raw.startsWith('\\')) continue
    if (raw.startsWith('+')) { lines.push({ kind: 'add', text: raw.slice(1) }); added++ }
    else if (raw.startsWith('-')) { lines.push({ kind: 'del', text: raw.slice(1) }); removed++ }
    else lines.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw })
  }
  return seenHunk ? { lines, added, removed } : null
}

// A real edit_file result: fenced, git-style, with preamble + context lines.
const editDiff = [
  '```diff',
  'Index: /tmp/f.txt',
  '===================================================================',
  '--- /tmp/f.txt\toriginal',
  '+++ /tmp/f.txt\tmodified',
  '@@ -1,3 +1,4 @@',
  ' line one',
  '-line two',
  '+line two (edited)',
  '+line two-and-a-half',
  ' line three',
  '```',
  '',
].join('\n')

const r = parseServerDiff(editDiff)
if (r === null) throw new Error('edit diff must parse') // narrows for tsc regardless of assert typings
assert.equal(r.added, 2, 'two added lines')
assert.equal(r.removed, 1, 'one removed line')
assert.deepEqual(r.lines.map(l => l.kind), ['hunk', 'ctx', 'del', 'add', 'add', 'ctx'])
assert.equal(r.lines[1].text, 'line one', 'context sign stripped')
assert.equal(r.lines[2].text, 'line two', 'del sign stripped')

// write_file result carries no hunk → null (row falls back to args view).
assert.equal(parseServerDiff('Successfully wrote to /tmp/f.txt'), null, 'no-hunk text → null')
assert.equal(parseServerDiff(''), null, 'empty → null')

// --- viewFromArgs: the fallback source (write_file, or a running edit) -------
// Mirrors index.tsx; keep in sync. Only the branches this check exercises.
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}
function viewFromArgs(toolName: string, record: Record<string, unknown>): DiffView | null {
  if (typeof record.path !== 'string') return null
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  const push = (oldText: string | null, newText: string) => {
    if (oldText !== null) for (const t of contentLines(oldText)) { lines.push({ kind: 'del', text: t }); removed++ }
    for (const t of contentLines(newText)) { lines.push({ kind: 'add', text: t }); added++ }
  }
  if (toolName.endsWith('write_file')) {
    if (typeof record.content !== 'string') return null
    push(null, record.content)
    return { lines, added, removed }
  }
  const edits = Array.isArray(record.edits) ? record.edits : undefined
  if (edits === undefined || edits.length === 0) return null
  for (const edit of edits) {
    const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown }
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null
    push(oldText, newText)
  }
  return { lines, added, removed }
}

const w = viewFromArgs('mcp__filesystem__write_file', { path: '/f', content: 'a\nb\nc\n' })
if (w === null) throw new Error('write view: null') // narrows for tsc regardless of assert typings
assert.deepEqual(w.lines.map(l => l.kind), ['add', 'add', 'add'], 'write = all additions')
assert.equal(w.added, 3)
assert.equal(w.removed, 0)

const e = viewFromArgs('mcp__filesystem__edit_file', { path: '/f', edits: [{ oldText: 'x', newText: 'y\nz' }] })
if (e === null) throw new Error('edit view: null')
assert.deepEqual(e.lines.map(l => l.kind), ['del', 'add', 'add'], 'edit = removals then additions')
assert.equal(e.removed, 1)
assert.equal(e.added, 2)

// --- lcsLines: the built-in edit/write path (context lines dedup) ------------
// Mirrors index.tsx; keep in sync.
function lcsLines(oldText: string, newText: string): DiffView {
  const a = contentLines(oldText)
  const b = contentLines(newText)
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
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

// A contextual hunk (built-in edit bakes context into both sides): only the
// changed middle line differs, the surrounding lines must read as one ctx each.
const l = lcsLines('ctx1\nold\nctx2', 'ctx1\nnew\nctx2')
assert.deepEqual(l.lines.map(x => x.kind), ['ctx', 'del', 'add', 'ctx'], 'context deduped to one row each')
assert.equal(l.removed, 1)
assert.equal(l.added, 1)
assert.equal(l.lines[0].text, 'ctx1')
assert.equal(l.lines[3].text, 'ctx2')

// --- rowState: the collapsed-row outcome (bash status dot) -------------------
// Mirrors index.tsx; keep in sync. `kind` discriminates running vs settled;
// interrupted → stopped; isError or a failing terminal exit → error;
// background ack → neutral (the block carries a job id, not an outcome);
// else ok. Fixtures pass parsed `args` directly — index.tsx reads the same
// record through argsRawOf/argsRecordOf, which the raw-string fixtures would
// only exercise through JSON.parse (covered by parse-bash cases).
function rowState(block) {
  if (!('kind' in block)) return 'running'
  const error = block.error
  if (error?.code === 'interrupted') return 'stopped'
  if (block.isError === true) return 'error'
  const result = block.resultView !== null && block.resultView.card === 'terminal' ? block.resultView : null
  if (result === null && block.args?.run_in_background === true) return 'neutral'
  if (result !== null
    && ((result.exitCode !== undefined && result.exitCode !== 0) || result.signal !== undefined)) {
    return 'error'
  }
  return 'ok'
}

assert.equal(rowState({ callView: null }), 'running', 'no kind → running')
assert.equal(rowState({ kind: 'x', resultView: null, error: { code: 'interrupted' } }), 'stopped', 'interrupted → stopped')
assert.equal(rowState({ kind: 'x', resultView: null, isError: true }), 'error', 'viewless isError → error')
assert.equal(rowState({ kind: 'x', resultView: { card: 'terminal', exitCode: 0 } }), 'ok', 'exit 0 → ok')
assert.equal(rowState({ kind: 'x', resultView: { card: 'terminal', exitCode: 1 } }), 'error', 'exit 1 → error')
assert.equal(rowState({ kind: 'x', resultView: { card: 'terminal', exitCode: 0, signal: 'SIGKILL' } }), 'error', 'signal → error')
assert.equal(rowState({ kind: 'x', resultView: { card: 'generic' }, args: { run_in_background: true } }), 'neutral', 'background ack → neutral')
assert.equal(rowState({ kind: 'x', resultView: { card: 'generic' } }), 'ok', 'generic view without background ack → ok')
assert.equal(rowState({ kind: 'x', resultView: { card: 'terminal', exitCode: 0 }, args: { run_in_background: true } }), 'ok', 'foreground terminal result wins over ack-shaped args')

console.log('parse-diff self-check ok')
