/**
 * Standalone tsdown config for the dsh-mcp-diff browser bundle.
 *
 * Reproduces the artifact contract the DeepSeek Harness client loader expects,
 * without depending on the monorepo's shared preset (which assumes a
 * packages/*​/* workspace layout). The browser half is emitted as a CJS module
 * wrapped in the `window.__ModuleLoader__.load({ id, factory })` handoff; the
 * factory resolves platform modules through the injected `require` (the loader
 * module table), so those specifiers stay external and everything else inlines.
 * The host half (src/index.ts) is emitted as a plain ESM lib for the Loader.
 */
import type { UserConfig } from 'tsdown'

/** Loader module-table specifiers: resolved by the injected require at runtime,
 * so they must NOT be bundled. Mirrors the harness client platform table. */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

const ID = 'dsh-mcp-diff'

const isExternal = (specifier: string): boolean => EXTERNAL.includes(specifier)

/** Host half: plain ESM library the Loader imports for the composition row. */
const hostConfig: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

/** Browser half: the __ModuleLoader__ closure-factory bundle. */
const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  // Loader module-table specifiers stay imports; everything else inlines.
  external: EXTERNAL,
  noExternal: (specifier: string) => !isExternal(specifier),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [hostConfig, clientConfig]
