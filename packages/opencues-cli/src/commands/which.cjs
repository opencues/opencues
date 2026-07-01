// `opencues which` — print every relevant path so the user has a
// one-stop "where does X live?" answer. No actions; pure inspection.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { fileLink, bold, dim, green, G } = require('../lib/style.cjs');

module.exports = function which(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  const HOME = os.homedir();
  const sections = [
    ['Configuration search paths (in priority order)', [
      ['$OPENCUES_HOME (env)',      process.env.OPENCUES_HOME || '(unset)'],
      ['Project-level',              path.join(process.cwd(), '.cues')],
      ['User-level',                 path.join(HOME, '.cues')],
      ['Shipped defaults (seed source, NOT a runtime search path)',
                                     path.join(ctx.REPO_ROOT, 'defaults')],
    ]],
    ['CC install state (compact footprint — everything inside the fork)', [
      ['Fork dir',                   path.join(HOME, 'claude-code-cues')],
      ['Patched cli.js',             path.join(HOME, 'claude-code-cues', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')],
      ['Built core',                 path.join(HOME, 'claude-code-cues', 'node_modules', '@opencues', 'core')],
      ['Built runtime',              path.join(HOME, 'claude-code-cues', 'node_modules', '@opencues', 'runtime')],
      ['Statusline script',          path.join(HOME, 'claude-code-cues', '.opencues', 'statusline.sh')],
      ['tweakcc clone',              path.join(HOME, 'claude-code-cues', '.opencues', 'tweakcc')],
      ['tweakcc state + cli backup', path.join(HOME, 'claude-code-cues', '.opencues', 'patch-state')],
    ]],
    ['Shared user-level (used by CC + OC + Gemini CLI)', [
      ['TTS script',                 path.join(HOME, '.cues', 'scripts', 'speak.sh')],
      ['TTS helper (compiled)',      path.join(HOME, '.cues', 'scripts', 'SpeakCtl.exe')],
      ['Brightness blank dir',       path.join(HOME, '.cues', 'blanks', 'brightness')],
      ['Volume blank dir',           path.join(HOME, '.cues', 'blanks', 'volume')],
      ['Runtime settings (voice-mode, llm-provider, ...)', path.join(HOME, '.cues', 'OPENCUES.md')],
      ['Cue master (frontmatter only — ignore list, project meta)',  path.join(HOME, '.cues', 'CUES.md')],
    ]],
    ['OC install state (per fork)', [
      ['Default fork dir',           path.join(HOME, 'opencode-cues')],
      ['(actual fork install lives at <fork>/node_modules/@opencues/{core,runtime}/ + 3 patched .tsx files)', ''],
    ]],
    ['Chrome state', [
      ['Repo build output',          path.join(ctx.REPO_ROOT, 'integrations', 'chrome', 'dist')],
      ['Manifest',                   path.join(ctx.REPO_ROOT, 'integrations', 'chrome', 'manifest.json')],
      ...wslChromeDeployRows(),
      ['(other deploy targets are wherever you passed --target; chrome reload state lives in Chrome itself)', ''],
    ]],
    ['Gemini CLI install state (per fork)', [
      ['Default fork dir',           path.join(HOME, 'gemini-cli-cues')],
      ['Built core',                 path.join(HOME, 'gemini-cli-cues', 'node_modules', '@opencues', 'core')],
      ['Built runtime',              path.join(HOME, 'gemini-cli-cues', 'node_modules', '@opencues', 'runtime')],
      ['Bootstrap (copied)',         path.join(HOME, 'gemini-cli-cues', 'packages', 'cli', 'src', 'ui', 'opencues.ts')],
      ['(also: 4 patched source files in packages/cli/src/ui/ — AppContainer.tsx, components/InputPrompt.tsx, components/Footer.tsx, esbuild.config.js)', ''],
    ]],
    ['Runtime IPC files (created when CC/OC/Gemini actually runs)', [
      ['Debug log',                  '/tmp/opencues.log'],
      ['Statusline IPC',             '/tmp/opencues-status-<pid>.json'],
      ['Cursor state IPC',           '/tmp/opencues-cursor-state-<pid>.json'],
    ]],
  ];

  // Each row leads with a status ring: green ● = path present, gray ● = not
  // present, no ring for informational (non-path) rows.
  const LABEL_W = 34;
  for (const [title, rows] of sections) {
    console.log('');
    console.log(bold(title));
    for (const [label, p] of rows) {
      const isPath = p && p !== '(unset)' && !p.startsWith('(');
      const exists = isPath ? statSafe(p) : null;
      const value = isPath ? fileLink(p, p) : (p ? dim(p) : '');
      const ring = exists === null ? '  ' : (exists ? green(G.ringOn) : dim(G.ringOn)) + ' ';
      console.log(`  ${ring}${label.padEnd(LABEL_W)}  ${value}`);
    }
  }
  console.log('');
  console.log(dim(`Legend: ${green(G.ringOn)} present  ${dim(G.ringOn)} not present`));
};

function statSafe(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// On WSL, surface the conventional Windows-side deploy path used by
// `opencues install chrome --wsl`. Returns a row only if the deploy
// exists OR if we're under WSL (so the user knows the slot exists).
function wslChromeDeployRows() {
  if (!isWsl()) return [];
  const probe = spawnSync('cmd.exe', ['/c', 'echo %USERNAME%'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (probe.status !== 0) return [];
  const winUser = String(probe.stdout).trim().replace(/\r$/, '');
  if (!winUser) return [];
  const wslPath = `/mnt/c/Users/${winUser}/AppData/Local/opencues-chrome`;
  return [['WSL deploy (--wsl)', wslPath]];
}

function isWsl() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
  } catch { return false; }
}

function printHelp() {
  console.log('opencues which');
  console.log('');
  console.log('Print every path OpenCues touches: configuration search paths, install dirs');
  console.log('per host, runtime IPC files, build artefacts. Each path shows ✓ if present,');
  console.log('- if not. Useful for "is this thing actually installed?" diagnostics.');
}
