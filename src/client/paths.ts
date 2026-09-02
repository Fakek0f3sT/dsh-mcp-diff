/**
 * paths — safe path handling for the open-file affordance.
 *
 * `openFile` is a host-side action: clicking a rendered path opens a file in
 * the user's IDE. Every path this plugin forwards comes from tool arguments
 * or command text parsed out of LLM output, so a link may only be offered
 * when the path stays inside the session workspace.
 *
 * The host's `resolveWorkspacePath` passes absolute paths through verbatim
 * and concatenates relative ones WITHOUT normalizing `..` — so containment
 * is judged on a lexically normalized form, and the resolution here mirrors
 * the runtime's exactly (a drift would silently widen or narrow the gate;
 * keep the two in sync).
 */

/** Lexical POSIX normalization (the bundle has no `path` module and no
 * filesystem access): collapse `.` and `..` against the leading `/` when
 * present. `/a/b/../c` → `/a/c`; a relative path that climbs past its own
 * root keeps its leading `..` segments. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(segment)
  }
  const joined = out.join('/')
  if (absolute) return `/${joined}`
  return joined === '' ? '.' : joined
}

/** Mirror of the runtime's `resolveWorkspacePath` (see the module doc):
 * absolute or Windows-style paths verbatim, otherwise `cwd`-joined with the
 * leading separators of `raw` and trailing separators of `cwd` trimmed. */
function resolveLikeHost(cwd: string, raw: string): string {
  if (raw.startsWith('/') || /^[A-Za-z]:[/\\]/.test(raw) || raw.startsWith('\\\\')) return raw
  if (cwd === '') return raw
  return `${cwd.replace(/[/\\]+$/, '')}/${raw.replace(/^[/\\]+/, '')}`
}

/** The workspace-contained absolute spelling of `raw` — or null when `raw`
 * must not become an open-file link:
 *   - no session workspace (unusual host setup);
 *   - a `~` path — the host never expands it, the link would be dead;
 *   - an empty path;
 *   - anything that resolves outside the workspace root: an absolute target
 *     parsed out of command text (`> /etc/passwd`), `..` traversal, or a bash
 *     call whose working directory sits outside the workspace.
 * `base` is the working directory `raw` is relative to (a bash call's own
 * cwd, verbatim), resolved against the session workspace first. */
export function containedOpenPath(
  raw: string,
  base: string | undefined,
  cwd: string | undefined,
): string | null {
  if (cwd === undefined || cwd === '' || raw === '' || raw.startsWith('~')) return null
  const anchor = base === undefined || base === '' ? cwd : resolveLikeHost(cwd, base)
  const resolved = normalizePath(resolveLikeHost(anchor, raw))
  const root = normalizePath(cwd)
  const prefix = root.endsWith('/') ? root : `${root}/`
  return resolved === root || resolved.startsWith(prefix) ? resolved : null
}
