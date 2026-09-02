/**
 * Self-check for the open-file containment helpers. Run with tsx:
 *   node --import tsx src/client/paths.test.ts
 * Prints `paths self-check ok` and exits 0, or names the failing case.
 */
import { containedOpenPath, normalizePath } from './paths'

let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failed++
    console.error(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

// normalizePath: lexical only, no filesystem.
check('norm: dot-dot collapse', normalizePath('/a/b/../c'), '/a/c')
check('norm: dot segment', normalizePath('a/./b'), 'a/b')
check('norm: past root', normalizePath('/a/../../b'), '/b')
check('norm: relative climb', normalizePath('../c'), '../c')
check('norm: relative climb beyond', normalizePath('a/../..'), '..')
check('norm: root', normalizePath('/'), '/')
check('norm: empty', normalizePath(''), '.')
check('norm: trailing slash', normalizePath('a/b/'), 'a/b')

const CWD = '/home/u/proj'

// Contained relative paths resolve to their workspace spelling.
check('open: relative', containedOpenPath('src/a.ts', undefined, CWD), '/home/u/proj/src/a.ts')
check('open: dot-relative', containedOpenPath('./notes.md', undefined, CWD), '/home/u/proj/notes.md')
check('open: root itself', containedOpenPath('.', undefined, CWD), CWD)
check('open: call cwd base', containedOpenPath('f.txt', 'sub', CWD), '/home/u/proj/sub/f.txt')
check('open: call cwd nested', containedOpenPath('g.txt', 'a/b/', CWD), '/home/u/proj/a/b/g.txt')

// Escapes and dead links stay plain text (null = no link).
check('open: absolute target', containedOpenPath('/etc/passwd', undefined, CWD), null)
check('open: traversal', containedOpenPath('../x', undefined, CWD), null)
check('open: deep traversal', containedOpenPath('a/../../../etc/shadow', undefined, CWD), null)
check('open: tilde', containedOpenPath('~/.bashrc', undefined, CWD), null)
check('open: empty', containedOpenPath('', undefined, CWD), null)
check('open: no session cwd', containedOpenPath('src/a.ts', undefined, undefined), null)
check('open: empty cwd', containedOpenPath('src/a.ts', undefined, ''), null)
check('open: windows drive', containedOpenPath('C:\\Users\\x\\f', undefined, CWD), null)

// A call working directory outside the workspace taints every path under it.
check('open: outside base', containedOpenPath('passwd', '/etc', CWD), null)
check('open: outside base absolute', containedOpenPath('/etc/passwd', '/etc', CWD), null)

// Trailing-slash cwd and separator normalization.
check('open: cwd trailing slash', containedOpenPath('f.txt', undefined, `${CWD}/`), '/home/u/proj/f.txt')

if (failed > 0) {
  console.error(`paths self-check FAILED (${failed})`)
  throw new Error(`paths self-check FAILED (${failed})`) // nonzero exit without Node types
} else {
  console.log('paths self-check ok')
}
