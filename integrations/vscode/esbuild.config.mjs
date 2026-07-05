// OpenCues VS Code extension bundle.
//
// Bundles the extension glue + the STAGED @opencues/{core,runtime}
// dist (setup.sh copies them into this package's node_modules — same
// staging model as integrations/shell; see its package.json note on
// avoiding workspace-resolution drift). A stale packages/*/dist
// silently ships old code — always build core/runtime first (setup.sh
// does; `npm run build` here does not).
//
// Unlike chrome's config there is no node-http-adapter stub and no
// `__DEFAULT_*__` config bakes: the extension host is real Node, so
// NodeHttpAdapter and filesystem config loading work directly.
// The only external is the `vscode` module VS Code injects at runtime.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, 'src', 'extension.ts')],
  outfile: path.join(here, 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
});
