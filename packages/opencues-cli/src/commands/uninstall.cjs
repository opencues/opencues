// `opencues uninstall <host>` — same shape as install; dispatches to
// per-integration installer with `uninstall` action.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tag, step, bold, dim, banner, cliVersion } = require('../lib/style.cjs');

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
const HOSTS = ['claude-code', 'opencode', 'chrome', 'gemini-cli'];
const HOST_FOLDERS = ['claude-code', 'opencode', 'chrome', 'gemini-cli'];

module.exports = function uninstall(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let target = null;
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') { target = '--all'; continue; }
    if (!a.startsWith('-') && !target) { target = a; continue; }
    passthrough.push(a);
  }

  if (!target) {
    console.error(`opencues uninstall: missing <host>. One of: ${HOSTS.join(', ')}, --all`);
    console.error('Run `opencues uninstall --help` for details.\n');
    process.exit(2);
  }

  const folders = target === '--all'
    ? HOST_FOLDERS
    : [HOST_ALIASES[target]];
  if (folders[0] === undefined) {
    console.error(`opencues uninstall: unknown host "${target}". Known: ${HOSTS.join(', ')}, --all`);
    process.exit(2);
  }

  // chrome-host uninstalls a separate sub-action (the native-messaging
  // host), not the extension itself. Dispatch the matching action.
  const action = target === 'chrome-host' ? 'uninstall-host' : 'uninstall';

  console.log(banner({ version: cliVersion(ctx) }));
  console.log('');

  let exitCode = 0;
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    if (folders.length > 1) {
      console.log('');
      console.log(step(i + 1, folders.length, `uninstalling ${bold('@opencues/' + folder)}`));
      console.log('');
    } else {
      console.log(`${tag('info')} uninstalling ${bold('@opencues/' + folder)}`);
    }
    const installer = path.join(ctx.REPO_ROOT, 'integrations', folder, 'bin', 'install.cjs');
    if (!fs.existsSync(installer)) {
      console.error(`${tag('err')} installer not found for "${folder}" (expected ${installer})`);
      exitCode = 1;
      continue;
    }
    const result = spawnSync('node', [installer, action, ...passthrough], { stdio: 'inherit' });
    const code = result.status ?? 1;
    if (code !== 0) {
      exitCode = code;
      console.log(`${tag('err')} ${folder} ${dim(`(exit ${code})`)}`);
    } else {
      console.log(`${tag('ok')} ${folder}`);
    }
  }
  process.exit(exitCode);
};

function printHelp() {
  console.log('opencues uninstall <host> [options]');
  console.log('');
  console.log('Roll back an installation. Same flags as install (see `opencues install --help`).');
  console.log('Each per-host uninstall is the inverse of its install — see the host\'s installer');
  console.log('docstring for exactly what gets removed.');
  console.log('');
  console.log('Examples:');
  console.log('  opencues uninstall cc');
  console.log('  opencues uninstall cc --target /path/to/cli.js');
  console.log('  opencues uninstall --all --dry-run');
}
