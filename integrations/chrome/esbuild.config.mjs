import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'fs';

// Load .env file if it exists (for dev API keys — .env is gitignored)
const envVars = {};
const envPath = new URL('.env', import.meta.url).pathname;
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) {
      envVars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  console.log('Loaded .env:', Object.keys(envVars).join(', '));
}

// Load project config files as defaults
const projectRoot = new URL('../../', import.meta.url).pathname;
const readOr = (path, fallback) => { try { return readFileSync(path, 'utf8'); } catch { return fallback; } };

// Load word-cue sources from defaults/cues/. Folder-only shape:
// each subdir has a CUE.md. Source name = folder name.
const cuesFolders = {};
const cuesDir = projectRoot + 'defaults/cues/';
try {
  for (const d of readdirSync(cuesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const cueMd = readOr(cuesDir + d.name + '/CUE.md', '');
    if (cueMd) cuesFolders[d.name] = cueMd;
  }
  if (Object.keys(cuesFolders).length > 0) {
    console.log('Loaded word cues:', Object.keys(cuesFolders).join(', '));
  }
} catch { /* no cues/ dir */ }

// Load blank sources from defaults/blanks/. Folder-only shape:
// each subdir has a BLANK.md. Source name = folder name.
const blankFolders = {};
const blanksDir = projectRoot + 'defaults/blanks/';
try {
  for (const d of readdirSync(blanksDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const blankMd = readOr(blanksDir + d.name + '/BLANK.md', '');
    if (blankMd) blankFolders[d.name] = blankMd;
  }
  if (Object.keys(blankFolders).length > 0) {
    console.log('Loaded blanks:', Object.keys(blankFolders).join(', '));
  }
} catch { /* no blanks/ dir */ }

const envDefines = {
  '__GROQ_API_KEY__': JSON.stringify(envVars['GROQ_API_KEY'] || ''),
  '__FINNHUB_API_KEY__': JSON.stringify(envVars['FINNHUB_API_KEY'] || ''),
  '__DEFAULT_OPENCUES_MD__': JSON.stringify(readOr(projectRoot + 'defaults/OPENCUES.md', '')),
  '__DEFAULT_CUE_FOLDERS__': JSON.stringify(cuesFolders),
  '__DEFAULT_BLANK_FOLDERS__': JSON.stringify(blankFolders),
  // Stub Node globals the runtime modules reference. Content scripts
  // have no `process`; these defines replace the lookups at bundle
  // time so the bundled code reads literal '~' / '' / undefined.
  'process.env.HOME': JSON.stringify('~'),
  'process.env.DEBUG_OPENCUES': JSON.stringify(''),
};

const common = {
  bundle: true,
  sourcemap: true,
  target: 'es2020',
  tsconfig: 'tsconfig.json',
  define: envDefines,
  // The runtime's Resolver lazily requires @opencues/core/node-http-adapter.
  // That module uses node:https — unresolvable in a browser bundle.
  // Alias to a stub that throws so the runtime's existing try/catch
  // falls through to the host-supplied httpAdapter (FetchHttpAdapter).
  alias: {
    '@opencues/core/node-http-adapter': new URL('./src/stubs/node-http-adapter-stub.ts', import.meta.url).pathname,
  },
};

// Content script — IIFE (injected into page context)
const contentBuild = esbuild.build({
  ...common,
  entryPoints: ['src/content.ts'],
  outfile: 'dist/content.js',
  format: 'iife',
});

// Background service worker — ESM
const backgroundBuild = esbuild.build({
  ...common,
  entryPoints: ['src/background.ts'],
  outfile: 'dist/background.js',
  format: 'esm',
});

// Popup — IIFE
const popupBuild = esbuild.build({
  ...common,
  entryPoints: ['src/popup/popup.ts'],
  outfile: 'dist/popup/popup.js',
  format: 'iife',
});

await Promise.all([contentBuild, backgroundBuild, popupBuild]);

// Copy static files
mkdirSync('dist/popup', { recursive: true });
copyFileSync('src/popup/popup.html', 'dist/popup/popup.html');
copyFileSync('src/popup/popup.css', 'dist/popup/popup.css');
copyFileSync('src/content.css', 'dist/content.css');

// Ship a sentinel configs/index.json so the bake-time bundle fetch
// in `getBundleIndex()` always gets a 200 on a fresh install (no
// `opencues sync chrome` has run yet). Without it the bootstrap logs
// a 404 — harmless (it falls back to bake-time __DEFAULT_*__
// constants) but noisy in devtools. `opencues sync chrome`
// overwrites this with the real bundle index when invoked.
mkdirSync('dist/configs', { recursive: true });
if (!existsSync('dist/configs/index.json')) {
  writeFileSync('dist/configs/index.json', JSON.stringify({ schema: 1, files: [] }, null, 2));
}

console.log('Build complete');
