// `opencues uninstall <host>` — same shape as install; dispatches to
// per-integration installer with `uninstall` action.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const HOSTS = ['cc', 'oc', 'chrome'];

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
    console.error('opencues uninstall: missing <host>. One of: cc, oc, chrome, --all');
    console.error('Run `opencues uninstall --help` for details.\n');
    process.exit(2);
  }

  const hosts = target === '--all' ? HOSTS : [target];
  for (const h of hosts) {
    if (!HOSTS.includes(h)) {
      console.error(`opencues uninstall: unknown host "${h}". Known: ${HOSTS.join(', ')}, --all`);
      process.exit(2);
    }
  }

  let exitCode = 0;
  for (const h of hosts) {
    if (hosts.length > 1) console.log(`\n=== uninstalling @opencues/${h} ===\n`);
    const installer = path.join(ctx.REPO_ROOT, 'integrations', h, 'bin', 'install.cjs');
    if (!fs.existsSync(installer)) {
      console.error(`opencues uninstall: installer not found for "${h}" (expected ${installer})`);
      exitCode = 1;
      continue;
    }
    const result = spawnSync('node', [installer, 'uninstall', ...passthrough], { stdio: 'inherit' });
    if (result.status !== 0) exitCode = result.status ?? 1;
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
