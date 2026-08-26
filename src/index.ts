/**
 * dsh-mcp-diff — host half.
 *
 * The behavior is browser-only (a keyed tool-view registration). The host
 * Loader still needs this entry so the package can appear as a `cordis.yml`
 * composition row and its `dsh.client` manifest can join the web boot graph.
 * There is no config schema and no host-side runtime behavior.
 * @module dsh-mcp-diff
 */
import type { Context } from '@deepseek-ai/cordis'

/** Plugin name: matches the package name and the composition row id family. */
export const name = 'dsh-mcp-diff'

/** No host services required. */
export const inject: string[] = []

/**
 * Host-side apply: nothing to install. The browser half (./client) carries the
 * whole plugin; this entry exists for the composition row and manifest.
 * @param _ctx - host root context (unused).
 */
export function apply(_ctx: Context): void {
  // Intentionally empty — see module doc.
}
