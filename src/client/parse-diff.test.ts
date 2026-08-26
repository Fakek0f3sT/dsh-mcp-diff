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

function parseServerDiff(text: string): { lines: DiffLine[]; added: number; removed: number } | null {
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

// write_file result carries no hunk → null (row falls back to args DiffBlock).
assert.equal(parseServerDiff('Successfully wrote to /tmp/f.txt'), null, 'no-hunk text → null')
assert.equal(parseServerDiff(''), null, 'empty → null')

console.log('parse-diff self-check ok')
