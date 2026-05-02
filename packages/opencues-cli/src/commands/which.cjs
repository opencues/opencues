// `opencues which` — print every relevant path so the user has a
// one-stop "where does X live?" answer. No actions; pure inspection.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

module.exports = function which(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  const HOME = os.homedir();
  const sections = [
    ['Configuration search paths (in priority order)', [
      ['$OPENCUES_HOME (env)',      process.env.OPENCUES_HOME || '(unset)'],
      ['Project-level',              path.join(process.cwd(), '.opencues')],
      ['User-level',                 path.join(HOME, '.opencues')],
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
    ['Shared user-level (used by CC + OC + Codex)', [
      ['TTS script',                 path.join(HOME, '.opencues', 'scripts', 'speak.sh')],
      ['TTS helper (compiled)',      path.join(HOME, '.opencues', 'scripts', 'SpeakCtl.exe')],
      ['Brightness blank dir',       path.join(HOME, '.opencues', 'blanks', 'brightness')],
      ['Volume blank dir',           path.join(HOME, '.opencues', 'blanks', 'volume')],
      ['Master config (settings + ignore + project metadata)', path.join(HOME, '.opencues', 'cues.md')],
    ]],
    ['OC install state (per fork)', [
      ['Default fork dir',           path.join(HOME, 'opencode-cues')],
      ['(actual fork install lives at <fork>/node_modules/@opencues/{core,runtime}/ + 3 patched .tsx files)', ''],
    ]],
    ['Codex install state (per fork)', [
      ['Default fork dir',           path.join(HOME, 'codex-cues')],
      ['Bridge crate',               path.join(HOME, 'codex-cues', 'codex-rs', 'opencues-bridge')],
      ['Launch helper',              path.join(HOME, 'codex-cues', 'launch.sh')],
      ['Daemon source',              path.join(ctx.REPO_ROOT, 'packages/opencues-runtime/dist/adapters/codex/v1/daemon.js')],
      ['(TUI patches: pre-alpha — see integrations/codex/HANDOFF.md)', ''],
    ]],
    ['Chrome state', [
      ['Repo build output',          path.join(ctx.REPO_ROOT, 'integrations', 'chrome', 'dist')],
      ['Manifest',                   path.join(ctx.REPO_ROOT, 'integrations', 'chrome', 'manifest.json')],
      ...wslChromeDeployRows(),
      ['(other deploy targets are wherever you passed --target; chrome reload state lives in Chrome itself)', ''],
    ]],
    ['Runtime IPC files (created when CC/OC actually runs)', [
      ['Debug log',                  '/tmp/opencues.log'],
      ['Statusline IPC',             '/tmp/opencues-highlight-state-<pid>.json'],
      ['Cursor state IPC',           '/tmp/opencues-cursor-state.json'],
    ]],
  ];

  for (const [title, rows] of sections) {
    console.log(`\n${title}:`);
    for (const [label, p] of rows) {
      const exists = p && p !== '(unset)' && !p.startsWith('(') ? statSafe(p) : null;
      const marker = exists === null ? '' : (exists ? '  ✓' : '  -');
      const padded = label.padEnd(34, ' ');
      console.log(`  ${padded} ${p}${marker}`);
    }
  }
  console.log('');
  console.log('Legend: ✓ exists, - not present.');
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
