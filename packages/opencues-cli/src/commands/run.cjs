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
  'chrome':      'chrome',
};
const HOSTS = ['claude-code', 'opencode', 'chrome'];

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
  if (folder === 'chrome') return runChrome();
};

function runCC(passthrough) {
  // First choice: the patched cli.js at the known install location
  // (~/claude-code-cues/...). This is what `opencues install claude-code`
  // produces — the binary is `node <that-cli.js>`. Going direct skips
  // PATH/shell-alias resolution entirely (which used to fall back to
  // the native unpatched `claude` binary, leaving cues + highlights
  // silently broken because the runtime never loaded — claude-cues was
  // a shell alias and `which` couldn't see it).
  const binFlag = passthrough.indexOf('--bin');
  if (binFlag >= 0 && passthrough[binFlag + 1]) {
    const explicit = passthrough[binFlag + 1];
    passthrough.splice(binFlag, 2);
    console.log(`Launching ${explicit} (--bin override)...`);
    exitFromSpawn(spawnSync(explicit, passthrough, { stdio: 'inherit' }), explicit);
    return;
  }

  const patchedCli = path.join(os.homedir(), 'claude-code-cues', 'node_modules',
    '@anthropic-ai', 'claude-code', 'cli.js');
  if (fs.existsSync(patchedCli)) {
    console.log(`Launching patched claude-code at ${patchedCli}...`);
    const result = spawnSync('node', [patchedCli, ...passthrough], { stdio: 'inherit' });
    exitFromSpawn(result, patchedCli);
    return;
  }

  // Fallback: PATH-based lookup. `claude-cues` shell alias won't
  // resolve via `which` — only a real binary on PATH works.
  console.warn('opencues run claude-code: patched install not found at ~/claude-code-cues.');
  console.warn('Install with: opencues install claude-code');
  console.warn('Falling back to PATH lookup (likely UNPATCHED — cues will not work):');
  for (const c of ['claude-cues', 'claude']) {
    const which = spawnSync('which', [c], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (which.status === 0) {
      const resolved = which.stdout.toString().trim();
      console.log(`Launching ${resolved}...`);
      exitFromSpawn(spawnSync(resolved, passthrough, { stdio: 'inherit' }), resolved);
      return;
    }
  }
  console.error('opencues run claude-code: no binary found.');
  process.exit(127);
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

  // Force the DB path to ~/.local/share/opencode/opencode.db. Without
  // this, OpenCode's channel-aware path resolver writes to
  // opencode-local.db (because Installation.isLocal() is true for our
  // dev checkout), but its migration marker check in src/index.ts is
  // hard-coded to opencode.db — they never match, so the "one time"
  // migration runs on EVERY launch. Setting OPENCODE_DISABLE_CHANNEL_DB
  // collapses both paths onto opencode.db and the marker check works.
  // See packages/opencode/src/storage/db.ts:30 (getChannelPath).
  const env = { ...process.env, OPENCODE_DISABLE_CHANNEL_DB: '1' };

  console.log(`Launching: bun run dev ${cleaned.join(' ')} (cwd: ${fork})`.trim());
  const result = spawnSync('bun', ['run', 'dev', ...cleaned], { cwd: fork, stdio: 'inherit', env });
  exitFromSpawn(result, 'bun');
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
  console.log('  chrome        print Chrome reload instructions (no programmatic launch)');
  console.log('');
  console.log('Flags:');
  console.log('  --bin <name>      (claude-code only) override which binary to exec');
  console.log('  --target <path>   (opencode only) fork dir (default: $HOME/opencode-cues)');
  console.log('');
  console.log('Examples:');
  console.log('  opencues run claude-code');
  console.log('  opencues run claude --bin claude-cues');
  console.log('  opencues run opencode');
  console.log('  opencues run opencode --target /custom/fork');
}
