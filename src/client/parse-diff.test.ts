/**
 * Self-check for parseServerDiff — the one non-trivial branch in this plugin.
 * Runs the parser against a real `edit_file` server diff and asserts the
 * classified lines. No framework: `node --import tsx/esm src/client/parse-diff.test.ts`.
 *
 * parseServerDiff is defined inside index.tsx (browser bundle, no test export),
 * so this check reproduces it verbatim. If you change the parser in index.tsx,
 * mirror it here — the copy is what keeps this a zero-import, one-file check.
 */
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
assert.ok(r !== null, 'edit diff must parse')
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
assert.ok(w !== null)
assert.deepEqual(w.lines.map(l => l.kind), ['add', 'add', 'add'], 'write = all additions')
assert.equal(w.added, 3)
assert.equal(w.removed, 0)

const e = viewFromArgs('mcp__filesystem__edit_file', { path: '/f', edits: [{ oldText: 'x', newText: 'y\nz' }] })
assert.ok(e !== null)
assert.deepEqual(e.lines.map(l => l.kind), ['del', 'add', 'add'], 'edit = removals then additions')
assert.equal(e.removed, 1)
assert.equal(e.added, 2)

console.log('parse-diff self-check ok')
