import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, existsSync, readdirSync, writeFileSync, watch as fsWatch } from 'fs';

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

// Load katas from defaults/katas/. Folder-only shape: each subdir has a
// KATA.md. Name = folder name. Bundled so `start kata _` works standalone
// (no chrome-host / sync required for the shipped katas).
const kataFolders = {};
const katasDir = projectRoot + 'defaults/katas/';
try {
  for (const d of readdirSync(katasDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const kataMd = readOr(katasDir + d.name + '/KATA.md', '');
    if (kataMd) kataFolders[d.name] = kataMd;
  }
  if (Object.keys(kataFolders).length > 0) {
    console.log('Loaded katas:', Object.keys(kataFolders).join(', '));
  }
} catch { /* no katas/ dir */ }

const envDefines = {
  // API keys are NOT baked in. The native-messaging host
  // (`opencues install chrome-host`) pushes them on connect from its
  // own process.env so the published JS bundle stays grep-free of
  // secrets. The popup is the secondary source for users who don't
  // install the host. These defines keep the TS declarations valid
  // but always resolve to '' at runtime.
  '__GROQ_API_KEY__': JSON.stringify(''),
  '__DEFAULT_OPENCUES_MD__': JSON.stringify(readOr(projectRoot + 'defaults/OPENCUES.md', '')),
  '__DEFAULT_AUDITORS_MD__': JSON.stringify(readOr(projectRoot + 'defaults/AUDITORS.md', '')),
  '__DEFAULT_CUE_FOLDERS__': JSON.stringify(cuesFolders),
  '__DEFAULT_BLANK_FOLDERS__': JSON.stringify(blankFolders),
  '__DEFAULT_KATA_FOLDERS__': JSON.stringify(kataFolders),
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
  // boot-common's checkRuntimeDrift (PR #47) dynamically imports
  // node:fs + node:path for the direct-launch advisory. Those
  // modules don't exist in the browser, but the function's own
  // try/catch catches the failed import and silent-skips. Marking
  // them external tells esbuild "emit the dynamic import as-is,
  // don't try to bundle" — the import then throws at runtime in
  // chrome and the silent-skip path fires. Without this, the
  // chrome build hard-fails at "node:path wasn't found on the
  // file system but is built into node."
  //
  // node:child_process: core's env-keys/llm-provider lazily require it
  // (~/.cues/.env read + the zero-key subscription-CLI probe). Both are
  // typeof-process-guarded so the require is unreachable in a content
  // script — external for the same emit-as-is reason.
  external: ['node:fs', 'node:path', 'node:child_process'],
};

// The three bundles. content + popup are IIFEs (injected into page
// context); background is an ESM service worker.
const buildTargets = [
  { entryPoints: ['src/content.ts'], outfile: 'dist/content.js', format: 'iife' },
  { entryPoints: ['src/background.ts'], outfile: 'dist/background.js', format: 'esm' },
  { entryPoints: ['src/popup/popup.ts'], outfile: 'dist/popup/popup.js', format: 'iife' },
];

// Copy the static (non-bundled) assets into dist. These are NOT part of
// esbuild's import graph — content.css / popup.css / popup.html are
// referenced directly by the manifest / popup.html, so a plain esbuild
// watch never sees them change. `--watch` mode below re-runs this on
// every static-file edit via a separate fs.watch.
function copyStatic() {
  mkdirSync('dist/popup', { recursive: true });
  copyFileSync('src/popup/popup.html', 'dist/popup/popup.html');
  copyFileSync('src/popup/popup.css', 'dist/popup/popup.css');
  copyFileSync('src/content.css', 'dist/content.css');

  mkdirSync('dist/icons', { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    copyFileSync(`icons/icon-${size}.png`, `dist/icons/icon-${size}.png`);
  }

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
}

const isWatch = process.argv.includes('--watch');

if (isWatch) {
  // Live dev loop. esbuild rebuilds each JS bundle on a source change;
  // a separate fs.watch re-copies the static CSS/HTML the manifest
  // references directly (esbuild's watcher can't see them — they're
  // copied, not imported). Directory-level watches survive editors'
  // atomic (write-temp + rename) saves, which a single-file watch does
  // not.
  const contexts = await Promise.all(
    buildTargets.map((t) => esbuild.context({ ...common, ...t })),
  );
  await Promise.all(contexts.map((c) => c.watch()));
  copyStatic();

  const staticWatch = [
    { dir: 'src', files: ['content.css'] },
    { dir: 'src/popup', files: ['popup.css', 'popup.html'] },
  ];
  for (const { dir, files } of staticWatch) {
    fsWatch(dir, (_evt, fname) => {
      if (fname && files.includes(fname)) {
        copyStatic();
        console.log(`[static] re-copied dist after ${dir}/${fname} change`);
      }
    });
  }

  console.log('Watching for changes (JS bundles + CSS/HTML).');
  console.log('After each save: reload the extension in chrome://extensions, then hard-refresh the page (Cmd+Shift+R).');
  console.log('Ctrl+C to stop.');
} else {
  await Promise.all(buildTargets.map((t) => esbuild.build({ ...common, ...t })));
  copyStatic();
  console.log('Build complete');
}
