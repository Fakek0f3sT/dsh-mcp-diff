/**
 * parse-bash — detect bash commands that mutate file lines.
 *
 * The keyed toolview slot gives us the call block only: `args.command` plus the
 * result text. DSH tracks no "files touched" for bash, so the ONLY source is
 * the command string itself. This module parses it conservatively — it must
 * never claim a mutation it cannot see — and returns null for everything that
 * does not clearly mutate a file, so the row keeps its plain terminal card.
 *
 * Recognized mutation shapes (best-effort by design):
 *   1. replace — a `python - <<'EOF'` (or node) script that reads a file,
 *      `.replace()`s `old`/`new` triple-quoted blocks and writes it back;
 *      the pairs yield real del/add lines and ±counts.
 *   2. write   — `cat > f <<EOF`, `tee [-a] f <<EOF`, bare `> f` / `>> f`;
 *      a heredoc body yields add lines, otherwise only the path is known.
 *   3. in-place — `sed -i` / `perl -pi` with explicit file tokens (path only).
 *   4. path ops — `mkdir`/`mv`/`cp`/`rm`/`touch` with literal path args;
 *      informational (no diff derivable), parsed only when no line mutation
 *      matched, so the two families never mix in one result.
 *
 * Everything else (ls, grep, git status, builds) parses as null on purpose.
 */

/** One `old` → `new` literal block pair from a replace-style script. */
export interface BashEditPair {
  old: string
  new: string
}

/** A whole-file write the command performs. */
export interface BashEditWrite {
  file: string
  /** Heredoc body when the content is spelled out in the command, else null. */
  body: string | null
  append: boolean
}

/** A path operation (no line mutation): mv/cp/mkdir/rm/touch with literal
 * arguments. Never mixed with pairs/writes/seds — see the header. */
export interface BashPathOp {
  op: 'mv' | 'cp' | 'mkdir' | 'rm' | 'touch'
  args: string[]
}

/** A parsed file-mutating bash command. Empty arrays mean "not derivable". */
export interface BashEdit {
  /** Every file the command touches, best guess, deduped, in discovery order. */
  files: string[]
  /** Replace-style block pairs (python/node heredoc scripts). */
  pairs: BashEditPair[]
  /** Whole-file writes with (usually) known content. */
  writes: BashEditWrite[]
  /** Files rewritten in place by sed -i / perl -pi (no diff derivable). */
  seds: string[]
  /** Path operations (mv/cp/mkdir/rm/touch); present only when the command
   * performed no line mutation at all. */
  ops: BashPathOp[]
}

interface Heredoc {
  body: string
  start: number
  end: number
}

/** Extract heredoc bodies (`<<[-]['"]DELIM['"]` … line `DELIM`), with their
 * byte ranges so later scans can mask them out. Unterminated → skipped. */
export function extractHeredocs(cmd: string): Heredoc[] {
  const out: Heredoc[] = []
  const re = /<<-?(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd)) !== null) {
    const delim = m[2]
    const nl = cmd.indexOf('\n', m.index)
    if (nl === -1) break
    let j = nl + 1
    let end = -1
    while (j <= cmd.length) {
      const next = cmd.indexOf('\n', j)
      const line = next === -1 ? cmd.slice(j) : cmd.slice(j, next)
      if (line.replace(/^\t+/, '').trimEnd() === delim) {
        end = j // body ends where the delimiter LINE starts
        break
      }
      if (next === -1) break
      j = next + 1
    }
    if (end === -1) continue // unterminated: not a usable heredoc
    out.push({ body: cmd.slice(nl + 1, end), start: nl + 1, end })
    re.lastIndex = end
  }
  return out
}

/** The command with heredoc bodies blanked (newlines kept), so token and
 * redirect scans never see script content. */
function maskHeredocs(cmd: string, heredocs: Heredoc[]): string {
  const chars = [...cmd]
  for (const h of heredocs) {
    for (let i = h.start; i < h.end; i++) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }
  return chars.join('')
}

/** All `name = '''…'''` / `name = """…"""` literals, in order, one leading
 * newline stripped (the conventional `'''\n…` formatting, not content). */
function tripleQuoted(text: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(?:^|\\n)[ \\t]*${name}[ \\t]*=[ \\t]*('''|\"\"\")`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const close = text.indexOf(m[1], m.index + m[0].length)
    if (close === -1) break
    let value = text.slice(m.index + m[0].length, close)
    if (value.startsWith('\n')) value = value.slice(1)
    out.push(value)
    re.lastIndex = close + 3
  }
  return out
}

/** Literal string paths handed to Path()/open()/writeFileSync() in a script. */
function scriptFileLiterals(text: string): string[] {
  const files: string[] = []
  const re = /\b(?:pathlib\.)?Path\(\s*(['"])([^'"\n]+)\1|\bopen\(\s*(['"])([^'"\n]+)\1|\bwriteFileSync\(\s*(['"])([^'"\n]+)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) files.push(m[2] ?? m[4] ?? m[6])
  return files
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

/** Shell tokens that look like file paths (`name.ext`, `./dir/name.ext`),
 * used only for sed/perl in-place scans. Requires a letter-led extension, so
 * version-like tokens (`1.5`), flags (`-i.bak`) and sed scripts (`s/a/b/`)
 * are excluded. */
function pathLikeTokens(masked: string): string[] {
  const out: string[] = []
  for (const token of masked.split(/\s+/)) {
    if (token.startsWith('-') || token.includes('://')) continue
    if (/^(?:\.?\/)?[\w.@+/-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(token)) out.push(token)
  }
  return out
}

/** Files rewritten by `sed -i` / `perl -pi` in the command. */
function inPlaceFiles(masked: string): string[] {
  const isSed = /(^|[\s;&|(])sed\s[^\n|;&]*-i\b/.test(masked) || /(^|[\s;&|(])sed\s[^\n|;&]*--inline\b/.test(masked)
  const isPerl = /(^|[\s;&|(])perl\s[^\n|;&]*-pi\b/.test(masked)
  if (!isSed && !isPerl) return []
  return dedupe(pathLikeTokens(masked))
}

/** Command segments, split on `&&`, `;`, and newlines — each parsed alone. */
function commandSegments(masked: string): string[] {
  return masked.split(/&&|\n|;/).map((s) => s.trim()).filter((s) => s !== '')
}

/** A literal shell word this parser treats as a path: no quoting, globbing,
 * variable/command expansion, or operators. Anything else disqualifies the
 * whole command (it keeps its plain terminal card — a missed card beats a
 * wrong one). */
const LITERAL_PATH = /^[A-Za-z0-9_@=,.:+/-]+$/

/** Path operations the command performs, one per segment. Any unrecognized
 * word anywhere (including `cd`, which shifts the base every later path
 * resolves against) disqualifies the whole command. */
function pathOps(masked: string): BashPathOp[] {
  const ops: BashPathOp[] = []
  for (const segment of commandSegments(masked)) {
    const words = segment.split(/\s+/)
    const op = words[0] as BashPathOp['op']
    if (op !== 'mv' && op !== 'cp' && op !== 'mkdir' && op !== 'rm' && op !== 'touch') return []
    const args = words.slice(1).filter((w) => !w.startsWith('-'))
    if (args.length === 0 || args.some((a) => !LITERAL_PATH.test(a))) return []
    if ((op === 'mv' || op === 'cp') && args.length !== 2) return []
    ops.push({ op, args })
  }
  return ops
}

/** Parse a bash command into the files it mutates, or null when it is not a
 * recognizable file mutation (the overwhelmingly common case). */
export function parseBashEdit(command: string): BashEdit | null {
  const heredocs = extractHeredocs(command)
  const masked = maskHeredocs(command, heredocs)

  // 1. Replace-style scripts: old/new triple-quoted pairs + a Path()/open()
  //    file + the read-replace-write idiom, inside one heredoc script.
  const pairs: BashEditPair[] = []
  let scriptFiles: string[] = []
  for (const h of heredocs) {
    const olds = tripleQuoted(h.body, 'old')
    const news = tripleQuoted(h.body, 'new')
    const n = Math.min(olds.length, news.length)
    if (n === 0) continue
    if (!/\.replace\(/.test(h.body)) continue
    if (!/write_text\(|\.write\(|writeFileSync\(|writeFile\(/.test(h.body)) continue
    const files = dedupe(scriptFileLiterals(h.body))
    if (files.length === 0) continue
    for (let i = 0; i < n; i++) pairs.push({ old: olds[i], new: news[i] })
    scriptFiles = dedupe([...scriptFiles, ...files])
  }

  // 2. Whole-file writes. Marker lines (`… > f <<EOF`, `tee f <<EOF`) are
  //    handled per heredoc so the body attaches to its file; the remaining
  //    lines get tee/redirect scans with bodies unknown.
  const writes: BashEditWrite[] = []
  for (const h of heredocs) {
    // h.start - 1 is the newline ending the marker line; search before it.
    const lineStart = command.lastIndexOf('\n', h.start - 2) + 1
    const markerLine = command.slice(lineStart, h.start - 1)
    const redir = /(>>?)[ \t]*([^\s;&|<>"']+)[ \t]*<</.exec(markerLine)
    const tee = /\btee[ \t]+((?:-{1,2}[\w-]+[ \t]+)*)([^\s;&|<>"']+)[ \t]*<</.exec(markerLine)
    if (redir !== null) writes.push({ file: redir[2], body: h.body, append: redir[1] === '>>' })
    else if (tee !== null) writes.push({ file: tee[2], body: h.body, append: /(^|\s)-a(\s|$)/.test(tee[1]) })
  }
  for (const line of masked.split('\n')) {
    if (line.includes('<<')) continue // heredoc marker lines are handled above
    const tee = /\btee[ \t]+((?:-{1,2}[\w-]+[ \t]+)*)([^\s;&|<>"']+)/.exec(line)
    if (tee !== null) {
      writes.push({ file: tee[2], body: null, append: /(^|\s)-a(\s|$)/.test(tee[1]) })
      continue
    }
    const redirectRe = /(?:^|[\s;&|(])(>>?)[ \t]*([^\s;&|<>"']+)/g
    let redir: RegExpExecArray | null
    while ((redir = redirectRe.exec(line)) !== null) {
      if (redir[2].startsWith('/dev/')) continue
      writes.push({ file: redir[2], body: null, append: redir[1] === '>>' })
    }
  }
  const seenWrite = new Set<string>()
  const uniqueWrites = writes.filter((w) => {
    const key = `${w.file}\u0000${String(w.append)}\u0000${w.body ?? ''}`
    if (seenWrite.has(key)) return false
    seenWrite.add(key)
    return true
  })

  // 3. In-place rewrites via sed -i / perl -pi.
  const seds = inPlaceFiles(masked)

  // 4. Path operations — informational only, and only when nothing above
  //    matched, so a line edit never renders as a path-op card.
  if (pairs.length === 0 && uniqueWrites.length === 0 && seds.length === 0) {
    const ops = pathOps(masked)
    if (ops.length === 0) return null
    return { files: dedupe(ops.flatMap((o) => o.args)), pairs, writes: uniqueWrites, seds, ops }
  }
  const files = dedupe([...scriptFiles, ...uniqueWrites.map((w) => w.file), ...seds])
  return { files, pairs, writes: uniqueWrites, seds, ops: [] }
}
