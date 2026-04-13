import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'fs';

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
const cuesDir = projectRoot + 'cues/';
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

// Load tips JSON from Claude Code patches (same tips file used by both integrations)
const tipsJsonPath = projectRoot + 'integrations/claude-code/patches/claude-code-tips.json';
const defaultTipsJson = readOr(tipsJsonPath, '');

const envDefines = {
  '__GROQ_API_KEY__': JSON.stringify(envVars['GROQ_API_KEY'] || ''),
  '__FINNHUB_API_KEY__': JSON.stringify(envVars['FINNHUB_API_KEY'] || ''),
  '__DEFAULT_CUES_MD__': JSON.stringify(readOr(projectRoot + 'cues.md', '')),
  '__DEFAULT_BLANKS_MD__': JSON.stringify(readOr(projectRoot + 'blanks.md', '')),
  '__DEFAULT_OPENCUES_MD__': JSON.stringify(readOr(projectRoot + 'opencues.md', '')),
  '__DEFAULT_CUE_FOLDERS__': JSON.stringify(cuesFolders),
  '__DEFAULT_TIPS_JSON__': JSON.stringify(defaultTipsJson),
};

const common = {
  bundle: true,
  sourcemap: true,
  target: 'es2020',
  tsconfig: 'tsconfig.json',
  define: envDefines,
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

console.log('Build complete');
