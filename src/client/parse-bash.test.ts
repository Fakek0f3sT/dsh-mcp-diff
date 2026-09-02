/**
 * Self-check for the bash-mutation parser. Run with the checkout's tsx loader:
 *   node --import "$DSH_CHECKOUT/node_modules/tsx/dist/loader.mjs" src/client/parse-bash.test.ts
 * Prints `parse-bash self-check ok` and exits 0, or names the failing case.
 */
import { parseBashEdit } from './parse-bash'

let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failed++
    console.error(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

// 1. The real-world shape: python heredoc, three old/new pairs, one file.
const CONTRIBUTING = `cd /home/r2s/projects/github/yarex_presenton && python3 - <<'EOF'
import pathlib

p = pathlib.Path("CONTRIBUTING.md")
s = p.read_text(encoding="utf-8")

old = '''# Current Contribution Scope

The Electron application contains:

- Desktop application
- FastAPI backend

---

# How to Contribute'''
new = '''# Current Contribution Scope

The repository contains:

- FastAPI backend
- Next.js frontend

---

# How to Contribute'''
assert s.count(old) == 1
s = s.replace(old, new)

old = '''Please ensure:

- Changes are **inside electron/**'''
new = '''Please ensure:

- Code runs locally'''
s = s.replace(old, new)

p.write_text(s, encoding="utf-8")
print("CONTRIBUTING.md rewritten")
EOF
grep -n -i "electron" CONTRIBUTING.md; echo "grep exit: $?"`

const contrib = parseBashEdit(CONTRIBUTING)
check('contrib: not null', contrib !== null, true)
check('contrib: file', contrib?.files, ['CONTRIBUTING.md'])
check('contrib: pair count', contrib?.pairs.length, 2)
check('contrib: pair1 old head', contrib?.pairs[0]?.old.slice(0, 28), '# Current Contribution Scope')
check('contrib: pair1 new head', contrib?.pairs[0]?.new.slice(0, 28), '# Current Contribution Scope')
check('contrib: pair2 old', contrib?.pairs[1]?.old, 'Please ensure:\n\n- Changes are **inside electron/**')
check('contrib: pair2 new', contrib?.pairs[1]?.new, 'Please ensure:\n\n- Code runs locally')
check('contrib: no writes', contrib?.writes, [])
check('contrib: no seds', contrib?.seds, [])

// 2. Whole-file write via cat heredoc.
const catWrite = parseBashEdit(`cat > notes.md <<'EOF'
line one
line two
EOF`)
check('cat: file', catWrite?.files, ['notes.md'])
check('cat: body', catWrite?.writes[0]?.body, 'line one\nline two\n')
check('cat: pairs empty', catWrite?.pairs, [])

// 3. tee append with heredoc.
const teeWrite = parseBashEdit(`tee -a log.txt <<EOF
entry
EOF`)
check('tee: file', teeWrite?.writes[0]?.file, 'log.txt')
check('tee: append', teeWrite?.writes[0]?.append, true)

// 4. Bare redirects.
const redir = parseBashEdit(`echo hello > out.txt && echo done 2>/dev/null`)
check('redirect: file', redir?.writes[0]?.file, 'out.txt')
check('redirect: no body', redir?.writes[0]?.body, null)
check('redirect: stderr skipped', redir?.writes.length, 1)

// 5. sed -i with an explicit file; non -i sed is not a mutation.
const sedEdit = parseBashEdit(`sed -i 's/old-name/new-name/' README.md`)
check('sed: file', sedEdit?.seds, ['README.md'])
check('sed: no pairs', sedEdit?.pairs, [])
const sedRead = parseBashEdit(`sed -n 1,5p README.md`)
check('sed read: null', sedRead, null)

// 6. Non-mutations parse as null.
check('ls: null', parseBashEdit(`ls -la`), null)
check('grep: null', parseBashEdit(`grep -rn TODO src/index.ts`), null)
check('git status: null', parseBashEdit(`git status && git diff --stat`), null)
check('print heredoc: null', parseBashEdit(`python3 - <<'EOF'\nprint(1)\nEOF`), null)
check('pairs w/o file: null', parseBashEdit(`python3 - <<'EOF'\nold = '''a'''\nnew = '''b'''\nprint(old, new)\nEOF`), null)
check('pairs w/o replace: null', parseBashEdit(`python3 - <<'EOF'\np = Path("f.md")\nold = '''a'''\nnew = '''b'''\nprint(p)\nEOF`), null)

// 7. Path operations: mv/cp/mkdir/rm/touch with literal path args.
const mvOp = parseBashEdit(`mv old-name.md new-name.md`)
check('mv: op', mvOp?.ops, [{ op: 'mv', args: ['old-name.md', 'new-name.md'] }])
check('mv: files', mvOp?.files, ['old-name.md', 'new-name.md'])
check('mv: no pairs', mvOp?.pairs, [])
check('cp: op', parseBashEdit(`cp src/a.md dist/`)?.ops, [{ op: 'cp', args: ['src/a.md', 'dist/'] }])
check('mkdir: chained ops', parseBashEdit(`mkdir -p src/a && mkdir src/b`)?.ops, [
  { op: 'mkdir', args: ['src/a'] },
  { op: 'mkdir', args: ['src/b'] },
])
check('rm: op', parseBashEdit(`rm -rf build`)?.ops, [{ op: 'rm', args: ['build'] }])
check('touch: op', parseBashEdit(`touch .graphflow-cache/.keep`)?.ops, [{ op: 'touch', args: ['.graphflow-cache/.keep'] }])

// 8. Path-op disqualifiers — anything non-literal keeps the terminal card.
check('mv three args: null', parseBashEdit(`mv a.md b.md c/`), null)
check('mkdir glob: null', parseBashEdit(`mkdir dist-*`), null)
check('rm var: null', parseBashEdit(`rm $TMPDIR/f`), null)
check('cd && mv: null', parseBashEdit(`cd build && mv a b`), null)
check('ls path-like: null', parseBashEdit(`ls src/a.md`), null)
// Mixed command: the write stays the card's subject, the sibling op surfaces.
const mixed = parseBashEdit(`echo hi > out.txt && mv out.txt done.txt`)
check('mixed: write kept', mixed?.writes.length, 1)
check('mixed: op surfaced', mixed?.ops, [{ op: 'mv', args: ['out.txt', 'done.txt'] }])
check('mixed: files', mixed?.files, ['out.txt', 'done.txt'])
check('mixed: cd flag', parseBashEdit(`cd build && cat > out.md <<EOF\nb\nEOF`)?.cdShifted, true)
check('no cd: flag false', parseBashEdit(`cat > out.md <<EOF\nb\nEOF`)?.cdShifted, false)

// 9. Quoted text and comments are not mutations (false-positive class).
check('quoted redirect hint: null', parseBashEdit(`echo "please use cat > file.txt to write files"`), null)
check('quoted two redirects: null', parseBashEdit(`echo "if a > b then echo done > log.txt"`), null)
check('quoted tee hint: null', parseBashEdit(`echo "use tee out.txt to log"`), null)
check('comment redirect: null', parseBashEdit(`echo start # see docs > README.md`), null)
check('hash inside word stays', parseBashEdit(`echo a#b > real.txt`)?.writes[0]?.file, 'real.txt')
check('quoted heredoc target: null', parseBashEdit(`cat > "my file.txt" <<EOF\nbody\nEOF`), null)
// A quoted `<<` must not hide a real redirect on the same line.
check('quoted << hides nothing', parseBashEdit(`echo 'a << b' > f.txt`)?.writes[0]?.file, 'f.txt')

// 10. tee --append and /dev sinks.
check('tee --append', parseBashEdit(`tee --append log.txt <<EOF\nx\nEOF`)?.writes[0]?.append, true)
check('tee -a kept', parseBashEdit(`tee -a log.txt <<EOF\nx\nEOF`)?.writes[0]?.append, true)
check('dev null bare: null', parseBashEdit(`echo x > /dev/null`), null)
check('dev stderr: null', parseBashEdit(`echo x > /dev/stderr`), null)
check('dev fd: null', parseBashEdit(`echo x > /dev/fd/3`), null)
check('dev null heredoc: null', parseBashEdit(`cat > /dev/null <<EOF\nx\nEOF`), null)
check('dev sda stays visible', parseBashEdit(`echo x > /dev/sda`)?.writes[0]?.file, '/dev/sda')
check('sudo tee with dev sink', parseBashEdit(`sudo tee f.txt > /dev/null <<EOF\nx\nEOF`)?.writes[0]?.file, 'f.txt')

// 11. fd-prefixed redirects.
check('stderr write', parseBashEdit(`make build 2> build.err`)?.writes[0]?.file, 'build.err')
check('stdout fd write', parseBashEdit(`echo x 1> out.txt`)?.writes[0]?.file, 'out.txt')
check('fd append', parseBashEdit(`echo x 2>> err.log`)?.writes[0]?.append, true)
check('fd to &1 ignored', parseBashEdit(`make build 2>&1`), null)
check('rm with stderr sink', parseBashEdit(`rm -f old.log 2>/dev/null`)?.ops, [{ op: 'rm', args: ['old.log'] }])

// 12. Two heredocs on one line: both bodies parse, no phantom writes.
const two = parseBashEdit(`cat <<EOF > f.txt && cat <<EOF2 > g.txt\nbody1\nEOF\necho hacked > pwned.txt\nEOF2`)
check('two heredocs: f', two?.writes.find((w) => w.file === 'f.txt')?.body, 'body1\n')
check('two heredocs: g', two?.writes.find((w) => w.file === 'g.txt')?.body, 'echo hacked > pwned.txt\n')
check('two heredocs: no phantom', two?.writes.some((w) => w.file === 'pwned.txt'), false)
// Redirect after the marker on a heredoc line.
check('redirect after marker', parseBashEdit(`cat <<EOF > out.txt\nhello\nEOF`)?.writes[0]?.file, 'out.txt')
// Unrelated redirect later on a heredoc line is not swallowed.
check('sibling redirect on marker line', parseBashEdit(`cat > f.txt <<EOF && echo done > g.txt\nbody\nEOF`)?.writes.some((w) => w.file === 'g.txt'), true)

// 13. sed -i claims only its own segment's files.
check('sed segment sweep', parseBashEdit(`diff old.json new.json; sed -i 's/a/b/' c.json`)?.seds, ['c.json'])
check('sed sibling cp dest', parseBashEdit(`cp a.txt b.txt && sed -i 's/x/y/' a.txt`)?.seds, ['a.txt'])
check('sed -i.bak', parseBashEdit(`sed -i.bak 's/a/b/' README.md`)?.seds, ['README.md'])

// 14. Script literals: written files lead, reads and URLs do not lead.
check('script: write-bound first', parseBashEdit(`python3 - <<'EOF'\nsrc = Path("input.md").read_text()\ndst = Path("output.md")\nold = '''alpha'''\nnew = '''beta'''\ndst.write_text(src.replace(old, new))\nEOF`)?.files, ['output.md'])
check('script: url dropped', parseBashEdit(`python3 - <<'EOF'\np = Path("done.md")\nold = '''a'''\nnew = '''b'''\np.write_text(p.read_text().replace(old, new))\nwebbrowser.open("http://example.com/x.html")\nEOF`)?.files, ['done.md'])
check('script: read-only literal kept', parseBashEdit(`python3 - <<'EOF'\np = pathlib.Path("CONTRIBUTING.md")\nold = '''a'''\nnew = '''b'''\ns = p.read_text(encoding="utf-8")\np.write_text(s.replace(old, new))\nEOF`)?.files, ['CONTRIBUTING.md'])
// A renderer without a read idiom is not a replace-edit.
check('generator: null', parseBashEdit(`python3 - <<'EOF'\nold = '''alpha'''\nnew = '''beta'''\nout = tpl.replace("{{v}}", old + new)\nPath("rendered.md").write_text(out)\nEOF`), null)

// 15. CRLF commands parse without CR residue.
check('crlf heredoc body', parseBashEdit(`cat > f.txt <<'EOF'\r\nline1\r\nEOF\r\n`)?.writes[0]?.body, 'line1\n')

if (failed > 0) {
  console.error(`parse-bash self-check FAILED (${failed})`)
  throw new Error(`parse-bash self-check FAILED (${failed})`) // nonzero exit without Node types
} else {
  console.log('parse-bash self-check ok')
}
