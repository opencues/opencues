// `opencues run <host>` — launch the patched host with sensible defaults.
//
// claude-code: exec the patched binary (claude-cues if present, else claude)
// opencode:    cd into fork dir + bun run dev
// chrome:      no-op + remind the user to load unpacked at chrome://extensions

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOST_ALIASES = {
  'claude-code': 'claude-code', 'claudecode': 'claude-code', 'claude': 'claude-code', 'cc': 'claude-code',
  'opencode':    'opencode',    'oc':         'opencode',
  'codex':       'codex',
  'chrome':      'chrome',
};
const HOSTS = ['claude-code', 'opencode', 'codex', 'chrome'];

module.exports = function run(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let target = null;
  const passthrough = [];
  for (const a of argv) {
    if (!a.startsWith('-') && !target) target = a;
    else passthrough.push(a);
  }

  if (!target) {
    console.error(`opencues run: missing <host>. One of: ${HOSTS.join(', ')}`);
    console.error('Run `opencues run --help` for details.\n');
    process.exit(2);
  }

  const folder = HOST_ALIASES[target];
  if (!folder) {
    console.error(`opencues run: unknown host "${target}". Known: ${HOSTS.join(', ')}`);
    process.exit(2);
  }

  if (folder === 'claude-code') return runCC(passthrough);
  if (folder === 'opencode')    return runOC(passthrough, argv);
  if (folder === 'codex')  return runCodex(passthrough, argv);
  if (folder === 'chrome') return runChrome();
};

function runCC(passthrough) {
  // Find a binary to launch. Prefer the patched claude-cues if the user
  // set up that alias; otherwise plain claude. --bin <name> overrides.
  const binFlag = passthrough.indexOf('--bin');
  let binName = (binFlag >= 0 && passthrough[binFlag + 1]) || null;
  if (binName) passthrough.splice(binFlag, 2);

  const candidates = binName ? [binName] : ['claude-cues', 'claude'];
  let resolved = null;
  for (const c of candidates) {
    const which = spawnSync('which', [c], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (which.status === 0) { resolved = which.stdout.toString().trim(); break; }
  }
  if (!resolved) {
    console.error(`opencues run claude-code: no binary found in PATH (tried: ${candidates.join(', ')})`);
    console.error('Install with: opencues install claude-code');
    process.exit(127);
  }
  console.log(`Launching ${resolved}...`);
  const result = spawnSync(resolved, passthrough, { stdio: 'inherit' });
  exitFromSpawn(result, resolved);
}

function runOC(passthrough, fullArgv) {
  const targetIdx = fullArgv.indexOf('--target');
  const fork = (targetIdx >= 0 && fullArgv[targetIdx + 1])
    || process.env.OPENCODE_CUES_DIR
    || path.join(os.homedir(), 'opencode-cues');

  if (!fs.existsSync(path.join(fork, 'packages', 'opencode'))) {
    console.error(`opencues run opencode: ${fork} doesn't look like an opencode checkout.`);
    console.error('Install first: opencues install opencode');
    console.error('Or pass --target /path/to/your/opencode-fork');
    process.exit(1);
  }

  // bun is required to launch the dev server. Pre-flight so the user
  // gets a clear error rather than the spawn silently failing later.
  const bunCheck = spawnSync('which', ['bun'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (bunCheck.status !== 0) {
    console.error('opencues run opencode: bun is not on PATH.');
    console.error('Install bun first: https://bun.sh/');
    console.error(`Then re-run: opencues run opencode${targetIdx >= 0 ? ` --target ${fork}` : ''}`);
    process.exit(127);
  }

  // Drop --target if it was passed; it's ours, not bun's.
  const cleaned = passthrough.filter((a, i, arr) => a !== '--target' && arr[i - 1] !== '--target');

  console.log(`Launching: bun run dev ${cleaned.join(' ')} (cwd: ${fork})`.trim());
  const result = spawnSync('bun', ['run', 'dev', ...cleaned], { cwd: fork, stdio: 'inherit' });
  exitFromSpawn(result, 'bun');
}

function runCodex(passthrough, fullArgv) {
  const targetIdx = fullArgv.indexOf('--target');
  const fork = (targetIdx >= 0 && fullArgv[targetIdx + 1])
    || process.env.CODEX_CUES_DIR
    || path.join(os.homedir(), 'codex-cues');

  const launchHelper = path.join(fork, 'launch.sh');
  if (!fs.existsSync(launchHelper)) {
    console.error(`opencues run codex: launch helper missing at ${launchHelper}`);
    console.error('Install first: opencues install codex');
    console.error('NOTE: codex integration is pre-alpha. The infrastructure is in place,');
    console.error('but TUI patches that wire OpenCues into the chat composer are not yet');
    console.error('implemented. See integrations/codex/HANDOFF.md.');
    process.exit(1);
  }

  // Drop --target if it was passed; it's ours, not codex's.
  const cleaned = passthrough.filter((a, i, arr) => a !== '--target' && arr[i - 1] !== '--target');

  console.log(`Launching ${launchHelper}...`);
  const result = spawnSync(launchHelper, cleaned, { stdio: 'inherit' });
  exitFromSpawn(result, launchHelper);
}

// Translate a spawnSync result into a process exit. spawnSync sets
// `error` (and `status === null`) when the child can't be launched at
// all (ENOENT, EACCES, …). The previous `process.exit(status ?? 0)`
// pattern silently exited 0 in those cases, which let "bun missing" /
// "binary unfindable" failures look like clean runs.
function exitFromSpawn(result, what) {
  if (result.error) {
    console.error(`opencues run: failed to launch ${what}: ${result.error.message}`);
    process.exit(127);
  }
  process.exit(result.status ?? 0);
}

function runChrome() {
  console.log('Chrome extensions are loaded by Chrome itself, not by opencues.');
  console.log('');
  console.log('  1. Open chrome://extensions');
  console.log('  2. Enable Developer mode');
  console.log('  3. Click "Load unpacked"');
  console.log('  4. Select the path printed by `opencues install chrome`');
  console.log('');
  console.log('If already loaded, just reload the page you want OpenCues active on.');
}

function printHelp() {
  console.log('opencues run <host> [options]');
  console.log('');
  console.log('Launch the patched host integration.');
  console.log('');
  console.log('Hosts:');
  console.log('  claude-code   exec the patched CC binary (claude-cues or claude)');
  console.log('  opencode      cd into the fork dir + bun run dev');
  console.log('  codex         exec the codex launch helper (sets OPENCUES_DAEMON_PATH + cargo run)');
  console.log('  chrome        print Chrome reload instructions (no programmatic launch)');
  console.log('');
  console.log('Flags:');
  console.log('  --bin <name>      (claude-code only) override which binary to exec');
  console.log('  --target <path>   (opencode | codex) fork dir (default: $HOME/opencode-cues, $HOME/codex-cues)');
  console.log('');
  console.log('Examples:');
  console.log('  opencues run claude-code');
  console.log('  opencues run claude --bin claude-cues');
  console.log('  opencues run opencode');
  console.log('  opencues run opencode --target /custom/fork');
}
