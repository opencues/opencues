// `opencues run <host>` — launch the patched host with sensible defaults.
//
// claude-code: exec the patched binary (claude-cues if present, else claude)
// opencode:    cd into fork dir + bun run dev
// chrome:      no-op + remind the user to load unpacked at chrome://extensions
// gemini-cli:  node packages/cli/dist/index.js inside ~/gemini-cli-cues fork

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const style = require('../lib/style.cjs');

// Print the brand banner + a host/command/cwd tree, then yield stdio
// to the spawned process. Output mirrors `seed-configs` / `install`
// styling so all CLI surfaces look like one product. The style module
// degrades to plain text when stdout isn't a TTY (NO_COLOR / pipes),
// so this is safe to always call.
function printLaunchBanner(ctx, host, rows) {
  console.log(style.banner({
    version: style.cliVersion(ctx),
    tagline: `launching ${host}`,
  }));
  console.log('');
  console.log(style.tree({ rows }));
  console.log('');
}

const HOST_ALIASES = {
  'claude-code': 'claude-code', 'claudecode': 'claude-code', 'claude': 'claude-code', 'cc': 'claude-code',
  'opencode':    'opencode',    'oc':         'opencode',
  'chrome':      'chrome',
  'gemini-cli':  'gemini-cli',  'geminicli':  'gemini-cli',  'gemini': 'gemini-cli',
};
const HOSTS = ['claude-code', 'opencode', 'chrome', 'gemini-cli'];

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

  if (folder === 'claude-code') return runCC(passthrough, ctx);
  if (folder === 'opencode')    return runOC(passthrough, argv, ctx);
  if (folder === 'chrome') return runChrome(ctx);
  if (folder === 'gemini-cli') return runGemini(passthrough, argv, ctx);
};

function runCC(passthrough, ctx) {
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
    printLaunchBanner(ctx, 'claude-code', [
      ['host',    'claude-code  ' + style.dim('(--bin override)')],
      ['command', `${explicit} ${passthrough.join(' ')}`.trim()],
    ]);
    exitFromSpawn(spawnSync(explicit, passthrough, { stdio: 'inherit' }), explicit);
    return;
  }

  const patchedCli = path.join(os.homedir(), 'claude-code-cues', 'node_modules',
    '@anthropic-ai', 'claude-code', 'cli.js');
  if (fs.existsSync(patchedCli)) {
    printLaunchBanner(ctx, 'claude-code', [
      ['host',    'claude-code  ' + style.dim('(patched)')],
      ['command', `node cli.js ${passthrough.join(' ')}`.trim()],
      ['fork',    style.fileLink(patchedCli, patchedCli)],
    ]);
    const result = spawnSync('node', [patchedCli, ...passthrough], { stdio: 'inherit' });
    exitFromSpawn(result, patchedCli);
    return;
  }

  // Fallback: PATH-based lookup. `claude-cues` shell alias won't
  // resolve via `which` — only a real binary on PATH works.
  console.warn(`${style.tag('warn')} patched install not found at ~/claude-code-cues`);
  console.warn(`     Install with: ${style.bold('opencues install claude-code')}`);
  console.warn(`     Falling back to PATH lookup (likely UNPATCHED — cues will not work):`);
  for (const c of ['claude-cues', 'claude']) {
    const which = spawnSync('which', [c], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (which.status === 0) {
      const resolved = which.stdout.toString().trim();
      printLaunchBanner(ctx, 'claude-code', [
        ['host',    'claude-code  ' + style.yellow('(unpatched fallback)')],
        ['command', `${resolved} ${passthrough.join(' ')}`.trim()],
      ]);
      exitFromSpawn(spawnSync(resolved, passthrough, { stdio: 'inherit' }), resolved);
      return;
    }
  }
  console.error(`${style.tag('err')} no binary found`);
  process.exit(127);
}

function runOC(passthrough, fullArgv, ctx) {
  const targetIdx = fullArgv.indexOf('--target');
  const fork = (targetIdx >= 0 && fullArgv[targetIdx + 1])
    || process.env.OPENCODE_CUES_DIR
    || path.join(os.homedir(), 'opencode-cues');

  if (!fs.existsSync(path.join(fork, 'packages', 'opencode'))) {
    console.error(`${style.tag('err')} ${fork} doesn't look like an opencode checkout.`);
    console.error(`     Install first: ${style.bold('opencues install opencode')}`);
    console.error('     Or pass --target /path/to/your/opencode-fork');
    process.exit(1);
  }

  // bun is required to launch the dev server. Pre-flight so the user
  // gets a clear error rather than the spawn silently failing later.
  const bunCheck = spawnSync('which', ['bun'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (bunCheck.status !== 0) {
    console.error(`${style.tag('err')} bun is not on PATH`);
    console.error(`     Install bun first: ${style.link('https://bun.sh/', 'https://bun.sh/')}`);
    console.error(`     Then re-run: opencues run opencode${targetIdx >= 0 ? ` --target ${fork}` : ''}`);
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

  printLaunchBanner(ctx, 'opencode', [
    ['host',    'opencode  ' + style.dim('(patched fork)')],
    ['command', `bun run dev ${cleaned.join(' ')}`.trim()],
    ['cwd',     style.fileLink(fork, fork)],
  ]);
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

function runGemini(passthrough, fullArgv, ctx) {
  const targetIdx = fullArgv.indexOf('--target');
  const fork = (targetIdx >= 0 && fullArgv[targetIdx + 1])
    || process.env.GEMINI_CLI_CUES_DIR
    || path.join(os.homedir(), 'gemini-cli-cues');

  if (!fs.existsSync(path.join(fork, 'packages', 'cli'))) {
    console.error(`${style.tag('err')} ${fork} doesn't look like a gemini-cli checkout.`);
    console.error(`     Install first: ${style.bold('opencues install gemini-cli')}`);
    console.error('     Or pass --target /path/to/your/gemini-cli-fork');
    process.exit(1);
  }

  const builtCli = path.join(fork, 'packages', 'cli', 'dist', 'index.js');
  if (!fs.existsSync(builtCli)) {
    console.error(`${style.tag('err')} built CLI not found at ${builtCli}`);
    console.error(`     Run setup again: ${style.bold('opencues install gemini-cli')}`);
    process.exit(1);
  }

  // Drop --target if it was passed; it's ours, not gemini's.
  const cleaned = passthrough.filter((a, i, arr) => a !== '--target' && arr[i - 1] !== '--target');

  // Launch from the user's cwd, not the fork dir. The fork ships its
  // own .gemini/settings.json (devtools + experimental flags) which
  // Gemini picks up cwd-locally and renders the input box with a
  // blue background. Running from the user's cwd uses their own
  // settings.json (or none).
  printLaunchBanner(ctx, 'gemini-cli', [
    ['host',    'gemini-cli  ' + style.dim('(patched fork)')],
    ['command', `node packages/cli/dist/index.js ${cleaned.join(' ')}`.trim()],
    ['fork',    style.fileLink(fork, fork)],
    ['cwd',     style.fileLink(process.cwd(), process.cwd())],
  ]);
  const result = spawnSync('node', [builtCli, ...cleaned], { stdio: 'inherit' });
  exitFromSpawn(result, 'node');
}

function runChrome(ctx) {
  printLaunchBanner(ctx, 'chrome', [
    ['host', 'chrome  ' + style.dim('(extensions are loaded by chrome itself)')],
  ]);
  console.log(style.bold('Load the extension in chrome://extensions:'));
  console.log('');
  console.log(`  ${style.dim('1.')} Open ${style.cyan('chrome://extensions')}`);
  console.log(`  ${style.dim('2.')} Enable ${style.bold('Developer mode')}`);
  console.log(`  ${style.dim('3.')} Click ${style.bold('Load unpacked')}`);
  console.log(`  ${style.dim('4.')} Select the path printed by ${style.bold('opencues install chrome')}`);
  console.log('');
  console.log(style.dim('If already loaded, reload the page you want OpenCues active on.'));
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
  console.log('  gemini-cli    node packages/cli/dist/index.js inside the fork (default: $HOME/gemini-cli-cues)');
  console.log('');
  console.log('Flags:');
  console.log('  --bin <name>      (claude-code only) override which binary to exec');
  console.log('  --target <path>   (opencode/gemini-cli) fork dir (defaults: $HOME/opencode-cues, $HOME/gemini-cli-cues)');
  console.log('');
  console.log('Examples:');
  console.log('  opencues run claude-code');
  console.log('  opencues run claude --bin claude-cues');
  console.log('  opencues run opencode');
  console.log('  opencues run opencode --target /custom/fork');
}
