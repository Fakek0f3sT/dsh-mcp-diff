/**
 * parse-risk — annotate bash commands whose EXECUTION is destructive or
 * risky, without claiming any file mutation.
 *
 * The mutation parser (parse-bash) renders only what it can confidently
 * parse; git state changes, chmod, `curl | sh` and friends keep the plain
 * terminal card. But a reviewer scanning collapsed rows wants exactly those
 * flagged. An annotation claims nothing, so a false positive costs a badge,
 * not a wrong diff — still, the signatures stay strictly unambiguous, and
 * quoted look-alikes may rarely badge (cosmetic, accepted).
 */

/** One risk signature: a short tag for the chip plus an unambiguous regex. */
const RULES: Array<{ tag: string; re: RegExp }> = [
  { tag: 'rm -rf', re: /(?:^|[\s;&|(])rm\s+(?:-\w+\s+)*-(?=[a-z]*r)(?=[a-z]*f)[a-z]+\b/ },
  { tag: 'chmod 777', re: /(?:^|[\s;&|(])chmod\s+(?:-{1,2}[\w-]+\s+)*777\b/ },
  { tag: 'git reset --hard', re: /(?:^|[\s;&|(])git\s+reset\s+[^\n;&|]*--hard\b/ },
  { tag: 'git checkout .', re: /(?:^|[\s;&|(])git\s+checkout\s+(?:--\s+)?\.+(?=\s|$)/ },
  { tag: 'git restore .', re: /(?:^|[\s;&|(])git\s+restore\s+(?:--\s+)?\.+(?=\s|$)/ },
  { tag: 'git clean -f', re: /(?:^|[\s;&|(])git\s+clean\s+[^\n;&|]*-[a-z]*f/ },
  { tag: 'pipe to shell', re: /(?:^|[\s;&|(])(?:curl|wget)\b[^\n;&|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/ },
  { tag: 'mkfs', re: /(?:^|[\s;&|(])mkfs\b/ },
  { tag: 'dd of=', re: /(?:^|[\s;&|(])dd\s+[^\n;&|]*\bof=/ },
  { tag: 'shred', re: /(?:^|[\s;&|(])shred\s+/ },
]

/** The risk tags a command hits, in rule order; empty for ordinary commands
 * (ls, git status, builds, curl -o file — a download is not a risk). */
export function riskTags(command: string): string[] {
  const tags: string[] = []
  for (const rule of RULES) {
    if (rule.re.test(command)) tags.push(rule.tag)
  }
  return tags
}
