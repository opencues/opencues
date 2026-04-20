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
  'claude-code': 'cc', 'claudecode': 'cc', 'claude': 'cc', 'cc': 'cc',
  'opencode':    'oc', 'oc':         'oc',
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

  if (folder === 'cc')     return runCC(passthrough);
  if (folder === 'oc')     return runOC(passthrough, argv);
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
  process.exit(result.status ?? 0);
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

  // Drop --target if it was passed; it's ours, not bun's.
  const cleaned = passthrough.filter((a, i, arr) => a !== '--target' && arr[i - 1] !== '--target');

  console.log(`cd ${fork} && bun run dev ${cleaned.join(' ')}`.trim());
  const result = spawnSync('bun', ['run', 'dev', ...cleaned], { cwd: fork, stdio: 'inherit' });
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
  console.log('  --target <path>   (opencode only) opencode fork dir (default: $HOME/opencode-cues)');
  console.log('');
  console.log('Examples:');
  console.log('  opencues run claude-code');
  console.log('  opencues run claude --bin claude-cues');
  console.log('  opencues run opencode');
  console.log('  opencues run opencode --target /custom/fork');
}
