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

if (failed > 0) {
  console.error(`parse-bash self-check FAILED (${failed})`)
  process.exitCode = 1
} else {
  console.log('parse-bash self-check ok')
}
