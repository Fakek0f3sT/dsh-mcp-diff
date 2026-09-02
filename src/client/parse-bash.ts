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
 *   2. write   — `cat > f <<EOF`, `tee [-a] f <<EOF`, bare `> f` / `>> f`
 *      (fd-prefixed forms like `2> err.log` included); a heredoc body yields
 *      add lines, otherwise only the path is known.
 *   3. in-place — `sed -i` / `perl -pi` with explicit file tokens (path only).
 *   4. path ops — `mkdir`/`mv`/`cp`/`rm`/`touch` with literal path args;
 *      informational (no diff derivable). Alone they render as their own
 *      card; alongside a line mutation they surface as an "also performs"
 *      warning, so a benign-looking write never hides a destructive sibling.
 *
 * Quoted spans and comments are masked before the token/redirect scans, so
 * command text inside quotes (`echo "use cat > f to write"`) never claims a
 * write. Everything else (ls, grep, git status, builds) parses as null on
 * purpose: a missed card beats a wrong one.
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
 * arguments. */
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
  /** Path operations (mv/cp/mkdir/rm/touch). Strict (all-or-nothing) when the
   * command performs no line mutation at all; lax per-segment when mixed with
   * one. */
  ops: BashPathOp[]
  /** A `cd` shifted the working directory mid-command: every path's base is
   * uncertain, so open-file links must be suppressed (paths still display). */
  cdShifted: boolean
}

interface Heredoc {
  body: string
  /** Offset where the body starts (the line after the marker line). */
  start: number
  /** Offset where the body ends (the delimiter line's start). */
  end: number
  /** Offset of the `<<` marker itself (on the line before `start`). */
  marker: number
}

/** Quoted-span ranges (the content BETWEEN the delimiters) of a line;
 * backslash escapes inside quotes are honored. */
function quotedSpans(line: string): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = []
  let quote: string | null = null
  let from = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote === null) {
      if (ch === "'" || ch === '"') {
        quote = ch
        from = i + 1
      }
      continue
    }
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === quote) {
      spans.push({ from, to: i })
      quote = null
    }
  }
  // Unterminated quote: bash would swallow the rest of the line.
  if (quote !== null) spans.push({ from, to: line.length })
  return spans
}

/** Blank the content of quoted spans (delimiters kept), so token and redirect
 * scans never read command text inside quotes. */
function maskQuotes(line: string): string {
  const units = line.split('')
  for (const span of quotedSpans(line)) {
    for (let i = span.from; i < span.to; i++) units[i] = ' '
  }
  return units.join('')
}

/** Extract heredoc bodies (`<<[-]['"]DELIM['"]` … line `DELIM`), with their
 * byte ranges so later scans can mask them out. Unterminated → skipped.
 * Linear and multi-marker: one pass indexes the lines (and, per normalized
 * line content, the offsets where such a line begins), then a state machine
 * walks the lines — each marker's delimiter is a binary search, bodies are
 * consumed in bash order, and several markers on one marker line get their
 * bodies sequentially. Markers inside quoted spans are not heredocs. */
export function extractHeredocs(cmd: string): Heredoc[] {
  const out: Heredoc[] = []
  const lineStarts: number[] = []
  const candidates = new Map<string, number[]>()
  for (let i = 0; i <= cmd.length; ) {
    lineStarts.push(i)
    const nl = cmd.indexOf('\n', i)
    const line = nl === -1 ? cmd.slice(i) : cmd.slice(i, nl)
    const key = line.replace(/^\t+/, '').trimEnd()
    let list = candidates.get(key)
    if (list === undefined) candidates.set(key, (list = []))
    list.push(i)
    if (nl === -1) break
    i = nl + 1
  }
  const lineEnd = (li: number): number =>
    li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : cmd.length
  const lineIndexOf = (offset: number): number => {
    let lo = 0
    let hi = lineStarts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lineStarts[mid] <= offset) lo = mid + 1
      else hi = mid
    }
    return lo - 1
  }
  const re = /<<-?(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g
  let li = 0
  while (li < lineStarts.length) {
    const lineText = cmd.slice(lineStarts[li], lineEnd(li))
    const spans = quotedSpans(lineText)
    re.lastIndex = 0
    const markers: Array<{ pos: number; delim: string }> = []
    let m: RegExpExecArray | null
    while ((m = re.exec(lineText)) !== null) {
      const pos = lineStarts[li] + m.index
      if (spans.some((s) => m !== null && m.index >= s.from && m.index < s.to)) continue
      markers.push({ pos, delim: m[2] })
    }
    if (markers.length === 0) {
      li++
      continue
    }
    let bodyLine = li + 1
    let consumed = false
    for (const marker of markers) {
      if (bodyLine >= lineStarts.length) break // no line left to start a body
      const list = candidates.get(marker.delim)
      let end = -1
      if (list !== undefined) {
        // First delimiter line starting at/after the body (the body is
        // strictly the lines after the marker line).
        let lo = 0
        let hi = list.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (list[mid] < lineStarts[bodyLine]) lo = mid + 1
          else hi = mid
        }
        if (lo < list.length) end = list[lo]
      }
      if (end === -1) continue // unterminated: not a usable heredoc
      const start = lineStarts[bodyLine]
      out.push({ body: cmd.slice(start, end), start, end, marker: marker.pos })
      consumed = true
      bodyLine = lineIndexOf(end) + 1
    }
    // Resume after the consumed bodies (their lines are literal); the
    // delimiter line itself holds no markers.
    li = consumed ? bodyLine : li + 1
  }
  return out
}

/** The command with heredoc bodies blanked (newlines kept), so token and
 * redirect scans never see script content. The body slice IS the masked
 * segment: blank everything but its newlines — index-exact (code-unit) by
 * construction, unlike a code-point spread. */
function maskHeredocs(cmd: string, heredocs: Heredoc[]): string {
  let out = ''
  let pos = 0
  for (const h of heredocs) {
    out += cmd.slice(pos, h.start) + h.body.replace(/[^\n]/g, ' ')
    pos = h.end
  }
  return out + cmd.slice(pos)
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

/** Literal string paths in a heredoc script, written-before-read: literals
 * bound to a write call (`Path(…).write_*`, `open(…, 'w')`, `writeFile*`,
 * `appendFile*`) lead — the card header must name what the script WRITES,
 * not what it reads. Path literals bound straight to a `.read*` call are
 * dropped, and `://` tokens (URLs) are never files. */
function scriptFileLiterals(text: string): string[] {
  const written: string[] = []
  const bare: string[] = []
  const readBound: string[] = []
  const scan = (re: RegExp, list: string[]) => {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const value = m[2]
      if (value === undefined || value.includes('://')) continue
      list.push(value)
    }
  }
  scan(/Path\(\s*(['"])([^'"\n]+)\1\s*\)\s*\.\s*write_(?:text|bytes|json|lines)\(/g, written)
  scan(/open\(\s*(['"])([^'"\n]+)\1\s*,\s*['"][wa]/g, written)
  scan(/\b(?:writeFileSync|writeFile|appendFileSync|appendFile)\(\s*(['"])([^'"\n]+)\1/g, written)
  scan(/Path\(\s*(['"])([^'"\n]+)\1\s*\)\s*\.\s*(?:read_\w+|read(?:lines|line)?\()/g, readBound)
  scan(/(?:pathlib\.)?Path\(\s*(['"])([^'"\n]+)\1/g, bare)
  scan(/\bopen\(\s*(['"])([^'"\n]+)\1/g, bare)
  const excluded = new Set(readBound)
  const files = [...written]
  if (written.length > 0) return dedupe(files)
  for (const value of bare) {
    if (!excluded.has(value)) files.push(value)
  }
  return dedupe(files)
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

/** Shell tokens that look like file paths (`name.ext`, `./dir/name.ext`),
 * used only for sed/perl in-place scans. Requires a letter-led extension, so
 * version-like tokens (`1.5`), flags (`-i.bak`) and sed scripts (`s/a/b/`)
 * are excluded. */
function pathLikeTokens(text: string): string[] {
  const out: string[] = []
  for (const token of text.split(/\s+/)) {
    if (token.startsWith('-') || token.includes('://')) continue
    if (/^(?:\.?\/)?[\w.@+/-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(token)) out.push(token)
  }
  return out
}

/** Files rewritten by `sed -i` / `perl -pi`: only path-like tokens of the
 * segments that THEMSELVES run the in-place rewrite — a `diff a b` or `cp a b`
 * sibling segment must not be declared sed-rewritten. */
function inPlaceFiles(masked: string): string[] {
  const files: string[] = []
  for (const segment of commandSegments(masked)) {
    if (/(^|\s)sed\s[^|;&]*-i\b/.test(segment) || /(^|\s)sed\s[^|;&]*--inline\b/.test(segment) || /(^|\s)perl\s[^|;&]*-pi\b/.test(segment)) {
      files.push(...pathLikeTokens(segment))
    }
  }
  return dedupe(files)
}

/** Command segments, split on `&&`, `;`, and newlines — each parsed alone. */
function commandSegments(masked: string): string[] {
  return masked.split(/&&|\n|;/).map((s) => s.trim()).filter((s) => s !== '')
}

/** A literal shell word this parser treats as a path: no quoting, globbing,
 * variable/command expansion, or operators. Anything else disqualifies the
 * segment (conservative: a missed card beats a wrong one). */
const LITERAL_PATH = /^[A-Za-z0-9_@=,.:+/-]+$/

/** One segment's path op, when the segment is exactly `op [-flags] literal…`
 * with a sane argument count; null otherwise. fd-redirect tokens
 * (`2>/dev/null`) are not arguments and do not disqualify. */
function segmentPathOp(segment: string): BashPathOp | null {
  const words = segment.split(/\s+/)
  const op = words[0] as BashPathOp['op']
  if (op !== 'mv' && op !== 'cp' && op !== 'mkdir' && op !== 'rm' && op !== 'touch') return null
  const args = words.slice(1).filter((w) => !w.startsWith('-') && !/^\d+[<>]/.test(w))
  if (args.length === 0 || args.some((a) => !LITERAL_PATH.test(a))) return null
  if ((op === 'mv' || op === 'cp') && args.length !== 2) return null
  return { op, args }
}

/** Path operations the command performs, one per segment. Any unrecognized
 * word anywhere (including `cd`, which shifts the base every later path
 * resolves against) disqualifies the whole command — the strict shape used
 * when the command performs no line mutation (ops-only card). */
function pathOps(masked: string): BashPathOp[] {
  const ops: BashPathOp[] = []
  for (const segment of commandSegments(masked)) {
    const op = segmentPathOp(segment)
    if (op === null) return []
    ops.push(op)
  }
  return ops
}

/** Lax per-segment ops for MIXED commands: segments that are not a clean
 * literal-args path op are ignored (the line mutation is the card's
 * subject), but recognized ops are still surfaced — a benign-looking write
 * must not hide a destructive sibling segment. */
function laxPathOps(masked: string): BashPathOp[] {
  const ops: BashPathOp[] = []
  for (const segment of commandSegments(masked)) {
    const op = segmentPathOp(segment)
    if (op !== null) ops.push(op)
  }
  return ops
}

/** Redirect targets that never mutate user data, only vanish into the
 * process's own streams — the ONLY `/dev/` targets worth skipping (`/dev/sda`
 * and friends stay visible writes). */
const NON_MUTATING_DEV = /^\/dev\/(?:null|stdin|stdout|stderr|fd\/\d+)$/

/** Segment ranges of one line, with offsets (claims need positions). */
function segmentSlices(line: string): Array<{ start: number; end: number }> {
  const slices: Array<{ start: number; end: number }> = []
  let start = 0
  const re = /&&|;/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    slices.push({ start, end: m.index })
    start = m.index + m[0].length
  }
  slices.push({ start, end: line.length })
  return slices
}

/** Parse a bash command into the files it mutates, or null when it is not a
 * recognizable file mutation (the overwhelmingly common case). */
export function parseBashEdit(rawCommand: string): BashEdit | null {
  // CRLF flattens here: bodies, pairs and line scans must not carry a CR
  // residue (it would leak into rendered diff rows as a phantom glyph).
  const command = rawCommand.replace(/\r\n/g, '\n')
  const heredocs = extractHeredocs(command)
  const masked = maskHeredocs(command, heredocs)

  // 1. Replace-style scripts: old/new triple-quoted pairs + a read-replace-
  //    write idiom over a real file literal, inside one heredoc script. The
  //    read idiom is required so template RENDERERS (replace on a constant,
  //    write the result) do not masquerade as replace-edits.
  const pairs: BashEditPair[] = []
  let scriptFiles: string[] = []
  for (const h of heredocs) {
    const olds = tripleQuoted(h.body, 'old')
    const news = tripleQuoted(h.body, 'new')
    const n = Math.min(olds.length, news.length)
    if (n === 0) continue
    if (!/\.replace\(/.test(h.body)) continue
    if (!/write_text\(|\.write\(|writeFileSync\(|writeFile\(/.test(h.body)) continue
    if (!/read_text\(|\.read\(|readFileSync\(|readFile\(/.test(h.body)) continue
    const files = scriptFileLiterals(h.body)
    if (files.length === 0) continue
    for (let i = 0; i < n; i++) pairs.push({ old: olds[i], new: news[i] })
    scriptFiles = dedupe([...scriptFiles, ...files])
  }

  // 2. Whole-file writes. Marker lines attach bodies to targets through a
  //    claim pass (tee before redirect, nearest marker, `/dev/` sinks
  //    dropped); every other line gets tee/redirect scans on the quote- and
  //    comment-masked text, so command text in quotes or comments never
  //    claims a write.
  const writes: BashEditWrite[] = []

  // Offsets of `masked`'s lines (masked is length-preserving, so the offsets
  // index `command` too), and the lines that carry a consumed heredoc marker.
  const lineStarts: number[] = []
  for (let i = 0; i <= masked.length; ) {
    lineStarts.push(i)
    const nl = masked.indexOf('\n', i)
    if (nl === -1) break
    i = nl + 1
  }
  const lineIndexOf = (offset: number): number => {
    let lo = 0
    let hi = lineStarts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lineStarts[mid] <= offset) lo = mid + 1
      else hi = mid
    }
    return lo - 1
  }

  const teeRe = /\btee[ \t]+((?:-{1,2}[\w-]+[ \t]+)*)([^\s;&|<>"']+)/g
  const redirRe = /(?:^|[\s;&|(])(\d+)?(>>?)[ \t]*([^\s;&|<>"']+)/g

  for (const li of new Set(heredocs.map((h) => lineIndexOf(h.marker)))) {
    const lineStart = lineStarts[li]
    const lineEnd = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : masked.length
    const quoted = maskQuotes(masked.slice(lineStart, lineEnd))
    // Consumed markers on this line (absolute offsets), nearest first.
    const markerPositions = heredocs
      .filter((h) => h.marker >= lineStart && h.marker < lineEnd)
      .map((h) => h.marker)
      .sort((a, b) => a - b)
    const targetOfMarker = new Map<number, { file: string; append: boolean }>()
    for (const slice of segmentSlices(quoted)) {
      const base = lineStart + slice.start
      const text = quoted.slice(slice.start, slice.end)
      const sliceMarkers = markerPositions.filter((p) => p >= base && p < base + text.length)
      const takeMarker = (pred: (p: number) => boolean): number | null => {
        let best: number | null = null
        for (const p of sliceMarkers) {
          if (targetOfMarker.has(p) || !pred(p)) continue
          if (best === null || p < best) best = p
        }
        return best
      }
      const teeFlagsOf = (flags: string): boolean => /(^|\s)(-a|--append)(\s|$)/.test(flags)
      // tee first (the specific writer), nearest marker at-or-after; then a
      // marker the tee precedes; leftovers fall through as bodyless writes.
      teeRe.lastIndex = 0
      let tm: RegExpExecArray | null
      while ((tm = teeRe.exec(text)) !== null) {
        const pos = base + tm.index
        const target = { file: tm[2], append: teeFlagsOf(tm[1]) }
        let claimed = takeMarker((p) => p >= pos)
        if (claimed === null) claimed = takeMarker((p) => p < pos)
        if (claimed !== null) targetOfMarker.set(claimed, target)
        else writes.push({ file: target.file, body: null, append: target.append })
      }
      redirRe.lastIndex = 0
      let rm: RegExpExecArray | null
      while ((rm = redirRe.exec(text)) !== null) {
        if (NON_MUTATING_DEV.test(rm[3])) continue
        const pos = base + rm.index
        const target = { file: rm[3], append: rm[2] === '>>' }
        let claimed = takeMarker((p) => p >= pos)
        if (claimed === null) claimed = takeMarker((p) => p < pos)
        if (claimed !== null) targetOfMarker.set(claimed, target)
        else writes.push({ file: target.file, body: null, append: target.append })
      }
    }
    for (const h of heredocs) {
      const target = targetOfMarker.get(h.marker)
      if (target !== undefined) writes.push({ file: target.file, body: h.body, append: target.append })
    }
  }

  for (let li = 0; li < lineStarts.length; li++) {
    const lineEnd = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : masked.length
    const line = masked.slice(lineStarts[li], lineEnd)
    const quoted = maskQuotes(line)
    if (quoted.includes('<<')) continue // heredoc markers are handled above
    const noComment = quoted.replace(/(^|\s)#.*$/, '')
    teeRe.lastIndex = 0
    let tm: RegExpExecArray | null
    while ((tm = teeRe.exec(noComment)) !== null) {
      writes.push({ file: tm[2], body: null, append: /(^|\s)(-a|--append)(\s|$)/.test(tm[1]) })
    }
    redirRe.lastIndex = 0
    let rm: RegExpExecArray | null
    while ((rm = redirRe.exec(noComment)) !== null) {
      if (NON_MUTATING_DEV.test(rm[3])) continue
      writes.push({ file: rm[3], body: null, append: rm[2] === '>>' })
    }
  }
  const filteredWrites = writes.filter((w) => !NON_MUTATING_DEV.test(w.file))
  const seenWrite = new Set<string>()
  const uniqueWrites = filteredWrites.filter((w) => {
    const key = `${w.file}\u0000${String(w.append)}\u0000${w.body ?? ''}`
    if (seenWrite.has(key)) return false
    seenWrite.add(key)
    return true
  })

  // 3. In-place rewrites via sed -i / perl -pi.
  const seds = inPlaceFiles(masked)

  // 4. Path operations. When nothing above matched, the strict all-or-nothing
  //    parse decides between an ops-only card and null (a `cd` anywhere
  //    shifts every later path's base — never guess). Alongside a line
  //    mutation, lax per-segment ops surface destructive siblings of a
  //    benign-looking write instead of hiding them.
  const cdShifted = commandSegments(masked).some((s) => s === 'cd' || s.startsWith('cd '))
  if (pairs.length === 0 && uniqueWrites.length === 0 && seds.length === 0) {
    const ops = pathOps(masked)
    if (ops.length === 0) return null
    return { files: dedupe(ops.flatMap((o) => o.args)), pairs, writes: uniqueWrites, seds, ops, cdShifted }
  }
  const ops = laxPathOps(masked)
  const files = dedupe([...scriptFiles, ...uniqueWrites.map((w) => w.file), ...seds, ...ops.flatMap((o) => o.args)])
  return { files, pairs, writes: uniqueWrites, seds, ops, cdShifted }
}
