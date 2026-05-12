// `opencues install <host>` — dispatch to per-integration installer.
//
// This is a thin shell-out — the actual install logic lives in
// integrations/<host>/bin/install.cjs (which already supports
// install/uninstall/seed-configs/--dry-run/--target/etc.). Cross-cutting
// flags like `--all` are handled here.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tag, step, bold, dim, banner } = require('../lib/style.cjs');

// Map every recognised host name to its folder under integrations/.
// Descriptive forms are the canonical folder names now; short codes
// ('cc', 'oc') remain as accepted aliases for power users / typing speed.
const HOST_ALIASES = {
  'claude-code': 'claude-code',
  'claudecode':  'claude-code',
  'claude':      'claude-code',
  'cc':          'claude-code',
  'opencode':    'opencode',
  'oc':          'opencode',
  'chrome':      'chrome',
  'chrome-host': 'chrome',          // native-messaging host (separate sub-action)
  'gemini-cli':  'gemini-cli',
  'geminicli':   'gemini-cli',
  'gemini':      'gemini-cli',
};
const HOSTS = ['claude-code', 'opencode', 'chrome', 'gemini-cli'];     // canonical names
const HOST_FOLDERS = ['claude-code', 'opencode', 'chrome', 'gemini-cli']; // resolved folders for --all

module.exports = function install(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp(ctx);

  // Parse: first non-flag positional is the host. `--all` is a special
  // pseudo-host. Everything else flows through to the per-host installer.
  let target = null;
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') { target = '--all'; continue; }
    if (!a.startsWith('-') && !target) { target = a; continue; }
    passthrough.push(a);
  }

  if (!target) {
    console.error(`opencues install: missing <host>. One of: ${HOSTS.join(', ')}, --all`);
    console.error('Run `opencues install --help` for details.\n');
    process.exit(2);
  }

  // Resolve descriptive name → folder code; --all expands to all folders.
  const folders = target === '--all'
    ? HOST_FOLDERS
    : [HOST_ALIASES[target]];
  if (folders[0] === undefined) {
    console.error(`opencues install: unknown host "${target}". Known: ${HOSTS.join(', ')}, --all`);
    process.exit(2);
  }

  // The chrome-host installer is a separate sub-action — it installs
  // the local native-messaging host that pushes ~/.cues/ into the
  // running extension. It does NOT need seed-configs (no writes to
  // ~/.cues/) and shares no install steps with the extension itself.
  const isChromeHost = target === 'chrome-host';
  const action = isChromeHost ? 'install-host' : 'install';

  // Run seed-configs FIRST so the user-level ~/.cues/ tree is current
  // before any host installer runs. seed-configs handles all shared writes:
  // first-time copy, library-script sync, OPENCUES.md self-heal, .cs compile.
  // Per-host installers then do strictly host-specific work (patches, etc.).
  // --dry-run flows through; --silent keeps the output focused on host steps.
  if (!isChromeHost && !passthrough.includes('--dry-run')) {
    const seedConfigs = require('./seed-configs.cjs');
    seedConfigs(['--silent'], ctx);
  }

  console.log(banner({ version: ctx.pkg.version }));
  console.log('');

  let exitCode = 0;
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    if (folders.length > 1) {
      console.log('');
      console.log(step(i + 1, folders.length, `installing ${bold('@opencues/' + folder)}`));
      console.log('');
    } else {
      console.log(`${tag('info')} installing ${bold('@opencues/' + folder)}`);
    }
    const code = runHostInstaller(folder, action, passthrough, ctx);
    if (code !== 0) {
      exitCode = code;
      console.log(`${tag('err')} ${folder} ${dim(`(exit ${code})`)}`);
    } else {
      console.log(`${tag('ok')} ${folder}`);
    }
  }
  process.exit(exitCode);
};

function runHostInstaller(host, action, extraArgs, ctx) {
  const installer = path.join(ctx.REPO_ROOT, 'integrations', host, 'bin', 'install.cjs');
  if (!fs.existsSync(installer)) {
    console.error(`opencues install: installer not found for "${host}" (expected ${installer})`);
    return 1;
  }
  const result = spawnSync('node', [installer, action, ...extraArgs], { stdio: 'inherit' });
  return result.status ?? 1;
}

function printHelp(ctx) {
  console.log(`opencues install <host> [options]`);
  console.log('');
  console.log('Install a host integration. Each host has the same flags + behaviour as');
  console.log('its per-integration installer (see integrations/<host>/bin/install.cjs).');
  console.log('');
  console.log('Hosts:');
  console.log('  claude-code   Patches Claude Code\'s cli.js via tweakcc       (aliases: claudecode, claude, cc)');
  console.log('  opencode      Patches an OpenCode 1.4.x fork                 (alias: oc)');
  console.log('  chrome        Chrome MV3 extension');
  console.log('  gemini-cli    Patches a Gemini CLI 0.41.x fork               (aliases: geminicli, gemini)');
  console.log('  --all         Install all four');
  console.log('');
  console.log('Common flags (passed through to the per-host installer):');
  console.log('  --target <path>   Host install path (cli.js for claude-code, fork dir for opencode/gemini-cli)');
  console.log('  --dry-run         Print plan, do not execute');
  console.log('  --clean           (claude-code) wipe install dir before reinstalling; (gemini-cli) accepted as no-op alias');
  console.log('  --no-build        (chrome only) skip build, use existing dist/');
  console.log('');
  console.log('Examples:');
  console.log('  opencues install claude-code');
  console.log('  opencues install claude-code --target ~/claude-code-cues/.../cli.js');
  console.log('  opencues install --all --dry-run');
}
