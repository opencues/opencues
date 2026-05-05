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

// Load word-cue sources from defaults/words/. Both flat <name>.md
// and folder <name>/CUE.md are accepted.
const cuesFolders = {};
const wordsDir = projectRoot + 'defaults/words/';
try {
  const entries = readdirSync(wordsDir, { withFileTypes: true });
  for (const d of entries) {
    if (d.isDirectory()) {
      const cueMd = readOr(wordsDir + d.name + '/CUE.md', '');
      if (cueMd) cuesFolders[d.name] = cueMd;
    } else if (d.name.endsWith('.md')) {
      const cueMd = readOr(wordsDir + d.name, '');
      if (cueMd) cuesFolders[d.name.slice(0, -3)] = cueMd;
    }
  }
  if (Object.keys(cuesFolders).length > 0) {
    console.log('Loaded word cues:', Object.keys(cuesFolders).join(', '));
  }
} catch { /* no words/ dir */ }

// Load blank sources from defaults/blanks/. Both flat and folder shapes.
// Folder shape uses BLANK.md per the open standard.
const blankFolders = {};
const blanksDir = projectRoot + 'defaults/blanks/';
try {
  const entries = readdirSync(blanksDir, { withFileTypes: true });
  for (const d of entries) {
    if (d.isDirectory()) {
      const blankMd = readOr(blanksDir + d.name + '/BLANK.md', '');
      if (blankMd) blankFolders[d.name] = blankMd;
    } else if (d.name.endsWith('.md')) {
      const blankMd = readOr(blanksDir + d.name, '');
      if (blankMd) blankFolders[d.name.slice(0, -3)] = blankMd;
    }
  }
  if (Object.keys(blankFolders).length > 0) {
    console.log('Loaded blanks:', Object.keys(blankFolders).join(', '));
  }
} catch { /* no blanks/ dir */ }

const envDefines = {
  '__GROQ_API_KEY__': JSON.stringify(envVars['GROQ_API_KEY'] || ''),
  '__FINNHUB_API_KEY__': JSON.stringify(envVars['FINNHUB_API_KEY'] || ''),
  '__DEFAULT_OPENCUESRC__': JSON.stringify(readOr(projectRoot + 'defaults/opencuesrc', '')),
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
