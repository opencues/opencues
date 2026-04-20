// `opencues which` — print every relevant path so the user has a
// one-stop "where does X live?" answer. No actions; pure inspection.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

module.exports = function which(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  const HOME = os.homedir();
  const sections = [
    ['Configuration search paths (in priority order)', [
      ['$OPENCUES_HOME (env)',      process.env.OPENCUES_HOME || '(unset)'],
      ['Project-level',              path.join(process.cwd(), '.opencues')],
      ['User-level',                 path.join(HOME, '.opencues')],
      ['Repo-level (this clone)',    path.join(ctx.REPO_ROOT, '.opencues')],
    ]],
    ['CC install state', [
      ['Install root',               path.join(HOME, '.claude', 'opencues')],
      ['Built core',                 path.join(HOME, '.claude', 'opencues', 'core')],
      ['Built runtime',              path.join(HOME, '.claude', 'opencues', 'runtime')],
      ['Tips JSON',                  path.join(HOME, '.claude', 'opencues', 'tips.json')],
      ['Statusline script',          path.join(HOME, '.claude', 'opencues', 'statusline.sh')],
      ['OS action scripts',          path.join(HOME, '.claude', 'opencues', 'actions')],
      ['tweakcc state + cli backup', path.join(HOME, '.claude', 'opencues', 'tweakcc-state')],
      ['tweakcc clone (in repo)',    path.join(ctx.REPO_ROOT, 'integrations', 'claude-code', 'tweakcc')],
    ]],
    ['OC install state (per fork)', [
      ['Default fork dir',           path.join(HOME, 'opencode-cues')],
      ['(actual fork install lives at <fork>/node_modules/@opencues/{core,runtime}/ + 3 patched .tsx files)', ''],
    ]],
    ['Codex install state (per fork)', [
      ['Default fork dir',           path.join(HOME, 'codex-cues')],
      ['Bridge crate',               path.join(HOME, 'codex-cues', 'codex-rs', 'opencues-bridge')],
      ['Launch helper',              path.join(HOME, 'codex-cues', 'run-codex-cues.sh')],
      ['Daemon source',              path.join(ctx.REPO_ROOT, 'packages/opencues-runtime/dist/adapters/codex/v1/daemon.js')],
      ['(TUI patches: pre-alpha — see integrations/codex/HANDOFF.md)', ''],
    ]],
    ['Chrome state', [
      ['Repo build output',          path.join(ctx.REPO_ROOT, 'integrations', 'chrome', 'dist')],
      ['Manifest',                   path.join(ctx.REPO_ROOT, 'integrations', 'chrome', 'manifest.json')],
      ['(deploy target is whatever you passed to --target; chrome reload state lives in Chrome itself)', ''],
    ]],
    ['Runtime IPC files (created when CC/OC actually runs)', [
      ['Debug log',                  '/tmp/opencues.log'],
      ['Statusline IPC',             '/tmp/claude-highlight-state-<pid>.json'],
      ['Cursor state IPC',           '/tmp/claude-cursor-state.json'],
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

function printHelp() {
  console.log('opencues which');
  console.log('');
  console.log('Print every path OpenCues touches: configuration search paths, install dirs');
  console.log('per host, runtime IPC files, build artefacts. Each path shows ✓ if present,');
  console.log('- if not. Useful for "is this thing actually installed?" diagnostics.');
}
