// Build the Playwright test bundle. Wraps replaceAllText +
// publishTarget so the HTML harness pages can drive them.
//
// Run by playwright.config.ts globalSetup before tests start.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const chromeRoot = resolve(here, '..', '..');

const commonOpts = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome121'],
  sourcemap: 'inline',
  logLevel: 'warning',
  tsconfig: resolve(chromeRoot, 'tsconfig.json'),
  define: {
    __GROQ_API_KEY__: '""',
    __DEFAULT_OPENCUES_MD__: '""',
    __DEFAULT_AUDITORS_MD__: '""',
    __DEFAULT_CUE_FOLDERS__: '{}',
    __DEFAULT_BLANK_FOLDERS__: '{}',
    'process.env.HOME': '"~"',
    'process.env.DEBUG_OPENCUES': '""',
    'process.env.NODE_ENV': '"production"',
    // Draft.js + React 17 CJS code reads `global`; in a browser bundle
    // that's not defined. Alias to `globalThis`.
    global: 'globalThis',
  },
  alias: {
    '@opencues/core/node-http-adapter': resolve(chromeRoot, 'src/stubs/node-http-adapter-stub.ts'),
    // boot-common dynamic-imports node:fs/node:path for a direct-launch
    // advisory that's a no-op in the browser. Production marks them
    // `external` (esbuild.config.mjs); the harness stubs them so the
    // dynamic import resolves cleanly instead of rejecting (a rejection
    // disrupted the Draft.js/React harness init before window.__OC was set).
    'node:fs': resolve(chromeRoot, 'src/stubs/node-builtin-stub.ts'),
    'node:path': resolve(chromeRoot, 'src/stubs/node-builtin-stub.ts'),
    // boot-common grew node:os + node:child_process requires (session-
    // commitments kick) after this stub list was written — the suite is
    // run-on-demand, so the build rot went unnoticed until the glimmer
    // harness was added. Same stub treatment as fs/path.
    'node:os': resolve(chromeRoot, 'src/stubs/node-builtin-stub.ts'),
    'node:child_process': resolve(chromeRoot, 'src/stubs/node-builtin-stub.ts'),
  },
};

await build({
  ...commonOpts,
  entryPoints: [resolve(here, 'test-entry.ts')],
  outfile: resolve(here, 'test-bundle.js'),
});

await build({
  ...commonOpts,
  entryPoints: [resolve(here, 'harness-lexical.ts')],
  outfile: resolve(here, 'harness-lexical-bundle.js'),
});

await build({
  ...commonOpts,
  entryPoints: [resolve(here, 'harness-prosemirror.ts')],
  outfile: resolve(here, 'harness-prosemirror-bundle.js'),
});

await build({
  ...commonOpts,
  entryPoints: [resolve(here, 'harness-draftjs.ts')],
  outfile: resolve(here, 'harness-draftjs-bundle.js'),
  // Draft.js + React read process.env.NODE_ENV at module-load. Already
  // supplied in commonOpts.define; loader settings for React's
  // CommonJS-style require chain are picked up by esbuild's default
  // resolver.
});

await build({
  ...commonOpts,
  entryPoints: [resolve(here, 'harness-glimmer.ts')],
  outfile: resolve(here, 'harness-glimmer-bundle.js'),
});

// eslint-disable-next-line no-console
console.log('[playwright] bundles built');
