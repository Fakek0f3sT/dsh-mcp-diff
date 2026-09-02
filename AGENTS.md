# AGENTS.md — repository briefing

`dsh-mcp-diff` is a client plugin for the **DeepSeek Harness Web GUI** that
renders every file mutation in the chat as a unified diff card: MCP filesystem
(`edit_file`/`write_file`), the built-in `edit`/`write`, and file-mutating
**bash** commands (python-heredoc `old`/`new` pairs, `cat >`/`tee`/`>` writes,
`sed -i`).

## How the plugin hooks into DSH

- The `tool.call.toolview` slot is **keyed**: one registration per tool wire
  name (`edit`, `write`, `bash`, `mcp__filesystem__edit_file`, …). Whoever
  owns a key renders EVERY call of that tool; returning `null` from the
  component is an empty string, NOT a fallback. There is no selective
  interception.
- Priorities: ascending, "lowest renders". DSH core keeps
  `bash-toolview-sample` on the `bash` key (priority 0) — our bash view
  registers with `priority: -1`. Same for `edit`/`write`. The MCP keys are
  free — priority 0 there.
- Owner props handed to the view component: `toolName`, `block`, `cwd`
  (session workspace root), `home`, `openFile`, `inspect` (`() => void`).

## Client purity gate (critical)

The client bundle may **value-import platform modules only**: `react`,
`@deepseek-ai/dsh-client-ui-primitives` (TerminalBlock, icons, StateDot),
`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-runtime/client`
(including `resolveWorkspacePath`), `@deepseek-ai/cordis` (types).
`@deepseek-ai/dsh-client-ui-tool` — **type-only import** (slot activation);
ui-tool internals (GenericToolCard, toolRowModel, terminalCardModel, css
modules) must not be imported. Local modules (`./parse-bash`) are fine.

## Files

| Path | What |
|---|---|
| `src/client/index.tsx` | all view components: `UnifiedDiff`, `McpDiffRow`, `MoveFileRow`, `BashRow`, `BashEditCard`, `TerminalCard`, registration in `apply()` |
| `src/client/parse-bash.ts` | pure bash-mutation detector (+ `BashEdit` types) |
| `src/client/parse-bash.test.ts` | detector self-check (imports parse-bash) |
| `src/client/parse-diff.test.ts` | server-diff parser self-check (a mirror of the index.tsx code — keep in sync when the parser changes) |
| `src/client/paths.ts` | workspace-containment gate for openFile links (pure, no platform imports) |
| `src/client/paths.test.ts` | path-containment self-check (imports paths) |
| `src/client/parse-risk.ts` | pure destructive-command risk tagger (annotation only, no mutation claim) |
| `src/client/parse-risk.test.ts` | risk-tagger self-check (imports parse-risk) |
| `cordis.patch.yml` | `tool.call.toolview` declaration + default inject target |
| `tsdown.config.ts` | client bundle build |
| `docs/screenshot.png` | README screenshot |

## Commands

```bash
npm install
npm run build        # tsc -p tsconfig.build.json && tsdown  (lib/client.js)
npm run typecheck    # tsc --noEmit (includes tests)
npm run test         # the self-checks (tsx is now in devDependencies)
```

Self-checks print `… self-check ok` and exit 0, or the names of failing
cases. Tests must NOT use node globals (`process`, `node:assert`) without a
reason — the plugin carries no `@types/node` (the older test is wrapped in
`@ts-nocheck`).

## Live check

`~/.dsh/profiles/web/node_modules/dsh-mcp-diff` is a **symlink to this
repository**: `npm run build` + a GUI page refresh = the live result. **Never
restart `dsh web`** (it would kill the session). The agent has no browser —
the final visual check is done by a human; the agent must get build +
typecheck + the self-checks green before every commit.

## Conventions

- Small, meaningfully split commits: `feat: …`, `fix: …`, `docs: …`, `ci: …`, `chore: …`.
- One task = one branch off a fresh `main`; after green checks — merge
  `--ff-only` into `main` and push.
- Version: only `npm version minor --no-git-tag-version` as one
  `chore: release X.Y.Z` commit at the end of a batch of tasks.
- **Release protocol (never skip)**: a release commit MUST be followed by the
  full release routine, in this exact order:
  1. push the release commit to `main` and wait for green CI on it;
  2. tag the release commit `vX.Y.Z` (annotated) and push the tag;
  3. create the matching GitHub Release from that tag with short release notes
     (conventional-commit highlights since the previous release, in English);
  4. ask the **user** to run `npm publish` (2FA — publishing is theirs, never
     attempt it yourself) and wait for their confirmation;
  5. after publishing, verify `npm view dsh-mcp-diff version` and link the
     release notes to the npm page if the UI allows.
  A release without a tag + GitHub Release + user publish is INCOMPLETE. If
  releases drifted (tag or GitHub Release missing for an already-published
  version), backfill tags/releases first, then proceed.
- Do not rename the package (npm identity + the awesome-dsh catalogue entry).
- Answer in Russian when the context is Russian-speaking.
