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

// Also load folder-based cue configs (cues/*.md)
const cuesFolders = {};
const cuesDir = projectRoot + 'defaults/cues/';
try {
  const dirs = readdirSync(cuesDir, { withFileTypes: true });
  for (const d of dirs) {
    if (d.isDirectory()) {
      const cueMd = readOr(cuesDir + d.name + '/cue.md', '');
      if (cueMd) cuesFolders[d.name] = cueMd;
    }
  }
  if (Object.keys(cuesFolders).length > 0) {
    console.log('Loaded cue folders:', Object.keys(cuesFolders).join(', '));
  }
} catch { /* no cues/ dir */ }

// Also load folder-based control configs (controls/*.md)
const controlFolders = {};
const controlsDir = projectRoot + 'defaults/controls/';
try {
  const dirs = readdirSync(controlsDir, { withFileTypes: true });
  for (const d of dirs) {
    if (d.isDirectory()) {
      const cueMd = readOr(controlsDir + d.name + '/cue.md', '');
      if (cueMd) controlFolders[d.name] = cueMd;
    }
  }
  if (Object.keys(controlFolders).length > 0) {
    console.log('Loaded control folders:', Object.keys(controlFolders).join(', '));
  }
} catch { /* no controls/ dir */ }

// Tips ship inside defaults/cues.md's `## Tips` block — no separate
// JSON file. The runtime's ConfigLoader extracts them from the parsed
// cues.md just like every other section.

const envDefines = {
  '__GROQ_API_KEY__': JSON.stringify(envVars['GROQ_API_KEY'] || ''),
  '__FINNHUB_API_KEY__': JSON.stringify(envVars['FINNHUB_API_KEY'] || ''),
  '__DEFAULT_CUES_MD__': JSON.stringify(readOr(projectRoot + 'defaults/cues.md', '')),
  '__DEFAULT_BLANKS_MD__': JSON.stringify(readOr(projectRoot + 'defaults/blanks.md', '')),
  '__DEFAULT_OPENCUES_MD__': JSON.stringify(readOr(projectRoot + 'defaults/opencues.md', '')),
  '__DEFAULT_CUE_FOLDERS__': JSON.stringify(cuesFolders),
  '__DEFAULT_CONTROL_FOLDERS__': JSON.stringify(controlFolders),
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

// Ship sentinel configs/.version + configs/index.json so the version
// poller and index fetcher always get a 200 on a fresh install (no
// sync run yet). Without these, every 2.5s poll fires a
// net::ERR_FILE_NOT_FOUND that Chrome logs to devtools — noisy and
// scary even though the runtime falls back cleanly. `opencues sync
// chrome` overwrites both files with real content when it runs.
mkdirSync('dist/configs', { recursive: true });
if (!existsSync('dist/configs/.version')) {
  writeFileSync('dist/configs/.version', 'unsynced\n');
}
if (!existsSync('dist/configs/index.json')) {
  writeFileSync('dist/configs/index.json', JSON.stringify({ schema: 1, files: [] }, null, 2));
}

console.log('Build complete');
