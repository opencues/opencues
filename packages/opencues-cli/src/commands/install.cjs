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

const HOSTS = ['cc', 'oc', 'chrome'];

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
    console.error('opencues install: missing <host>. One of: cc, oc, chrome, --all');
    console.error('Run `opencues install --help` for details.\n');
    process.exit(2);
  }

  const hosts = target === '--all' ? HOSTS : [target];
  for (const h of hosts) {
    if (!HOSTS.includes(h)) {
      console.error(`opencues install: unknown host "${h}". Known: ${HOSTS.join(', ')}, --all`);
      process.exit(2);
    }
  }

  let exitCode = 0;
  for (const h of hosts) {
    if (hosts.length > 1) console.log(`\n=== installing @opencues/${h} ===\n`);
    const code = runHostInstaller(h, 'install', passthrough, ctx);
    if (code !== 0) exitCode = code;
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
  console.log('  cc            Claude Code — patches cli.js via tweakcc');
  console.log('  oc            OpenCode — patches an OpenCode 1.4.x fork');
  console.log('  chrome        Chrome MV3 extension');
  console.log('  --all         Install all three');
  console.log('');
  console.log('Common flags (passed through to the per-host installer):');
  console.log('  --target <path>   Host install path (cli.js for cc, fork dir for oc, etc.)');
  console.log('  --dry-run         Print plan, do not execute');
  console.log('  --clean           (cc only) wipe install dir before reinstalling');
  console.log('  --no-build        (chrome only) skip build, use existing dist/');
  console.log('');
  console.log('Examples:');
  console.log('  opencues install cc');
  console.log('  opencues install cc --target ~/local-claude-code/.../cli.js');
  console.log('  opencues install --all --dry-run');
}
