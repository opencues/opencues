#!/usr/bin/env node
// @opencues/mac CLI — install / uninstall.
//
// Self-owned host (no upstream fork to patch). Install builds
// @opencues/{core,runtime}, stages them into this integration's local
// node_modules (real copies — same staging pattern as shell and
// apple-notes, full-recursive cp, no hard-coded subdir lists), builds
// the daemon (tsc) + the Swift AX bridge (swiftc), writes the
// drift-detection version marker, and fires the Accessibility TCC
// prompt at INSTALL time via `ax-bridge probe`.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

const { command, args, unknown } = parseArgv(process.argv.slice(2));
warnUnknownFlags(unknown);
if (args.help || command === 'help') { printHelp(); process.exit(0); }

console.log(`${pkg.name} v${pkg.version}`);

const isClone = fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'));
if (!isClone) {
  console.error(
    '\nPublished-package install path is not implemented yet.\n' +
    'For now, install from a clone:\n' +
    '  git clone https://github.com/opencues/opencues\n' +
    '  pnpm install\n' +
    '  opencues install mac\n',
  );
  process.exit(1);
}

if (command === 'install') doInstall();
else if (command === 'uninstall') doUninstall();
else { console.error(`Unknown command: ${command}\n`); printHelp(); process.exit(1); }

// --- INSTALL ----------------------------------------------------------------

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: REPO_ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`\nInstall failed at: ${cmd} ${argv.join(' ')}`);
    console.error('To roll back: opencues uninstall mac');
    process.exit(r.status || 1);
  }
}

function doInstall() {
  if (process.platform !== 'darwin') {
    console.error('\nERROR: the mac integration is macOS-only (Accessibility API).');
    if (!args.dryRun) process.exit(1);
  }
  const hasSwiftc = spawnSync('swiftc', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!hasSwiftc) {
    console.error('\nERROR: swiftc not found — install the Xcode Command Line Tools: xcode-select --install');
    if (!args.dryRun) process.exit(1);
  }

  if (args.dryRun) {
    console.log('\n[dry-run] Would build @opencues/{core,runtime}, stage them into');
    console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues')}/`);
    console.log('[dry-run] Would build the daemon (tsc) + AX bridge (swiftc).');
    console.log('[dry-run] Would probe the Accessibility permission (TCC prompt).');
    return;
  }

  // Seed configs first so cues/blanks/OPENCUES.md exist before first run.
  const seedConfigsPath = path.join(REPO_ROOT, 'packages/opencues-cli/src/commands/seed-configs.cjs');
  if (fs.existsSync(seedConfigsPath)) {
    const seedConfigs = require(seedConfigsPath);
    seedConfigs(['--silent'], { REPO_ROOT });
  }

  console.log('  ▸ building @opencues/core + @opencues/runtime');
  run('pnpm', ['--filter', '@opencues/core', '--filter', '@opencues/runtime', 'build']);

  // Stage REAL copies (not workspace symlinks) so the version marker's
  // drift detection has a stable install target.
  console.log('  ▸ staging @opencues/core + @opencues/runtime into local node_modules');
  for (const name of ['core', 'runtime']) {
    const src = path.join(REPO_ROOT, 'packages', `opencues-${name}`);
    const dest = path.join(PKG_DIR, 'node_modules', '@opencues', name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(path.join(src, 'dist'), path.join(dest, 'dist'), { recursive: true });
    fs.copyFileSync(path.join(src, 'package.json'), path.join(dest, 'package.json'));
    // node-http-adapter.js lives at the core package ROOT, not dist/ —
    // see adapters/oc/REPAIR.md § LF-7.
    const adapter = path.join(src, 'node-http-adapter.js');
    if (fs.existsSync(adapter)) fs.copyFileSync(adapter, path.join(dest, 'node-http-adapter.js'));
  }

  // The staged copies are dist-only, so @opencues/runtime's own deps
  // (acorn / acorn-walk, lazy-required by the JS user-blank loader) are
  // unresolvable from here — every JS user blank would fail to register
  // with a warn and nothing else. Shared with apple-notes + shell.
  const { stageRuntimeDeps, vendorUserBlankRunner } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/stage-runtime-deps.cjs'));
  stageRuntimeDeps({
    REPO_ROOT,
    destNodeModules: path.join(PKG_DIR, 'node_modules'),
    log: (m) => console.log(m),
  });
  // The subprocess fallback runs from ~/.opencues/vendor with its own
  // NODE_PATH, so it needs its own isolated-vm — staging above doesn't
  // reach a child process rooted elsewhere.
  vendorUserBlankRunner({ REPO_ROOT, log: (m) => console.log(m) });

  // Daemon build AFTER staging: tsc resolves @opencues/{core,runtime}
  // types from the staged copies (building first would typecheck
  // against the previous install's runtime).
  console.log('  ▸ building the mac daemon (tsc) + AX bridge (swiftc)');
  run('pnpm', ['--filter', '@opencues/mac', 'build']);

  try {
    const { writeMarker } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
    writeMarker('mac', path.join(PKG_DIR, 'node_modules', '@opencues'), { pkg, REPO_ROOT });
  } catch { /* non-fatal */ }

  // Accessibility probe — fires the system prompt when not yet granted.
  console.log('  ▸ probing the Accessibility permission');
  const probe = spawnSync(path.join(PKG_DIR, 'dist', 'ax-bridge'), ['probe'], { encoding: 'utf8' });
  if ((probe.stdout || '').trim() === 'trusted') {
    console.log('    ✓ Accessibility permission granted');
  } else {
    console.log('    ⚠ Accessibility permission NOT granted yet.');
    console.log('      Grant it: System Settings → Privacy & Security → Accessibility');
    console.log('      → enable your terminal (or whatever launches the daemon), then re-run:');
    console.log('      opencues run mac');
  }

  console.log('\n✓ installed. Start it with: opencues run mac');
  console.log('  Then type a blank in any app, e.g.:  distance to the moon in km _');
}

// --- UNINSTALL ----------------------------------------------------------------

function doUninstall() {
  const lock = '/tmp/opencues-mac.lock';
  try {
    const pid = parseInt(fs.readFileSync(lock, 'utf8'), 10);
    if (Number.isFinite(pid)) { process.kill(pid); console.log(`  ▸ stopped daemon (pid ${pid})`); }
  } catch { /* not running */ }
  fs.rmSync(lock, { force: true });
  fs.rmSync(path.join(PKG_DIR, 'node_modules', '@opencues'), { recursive: true, force: true });
  fs.rmSync(path.join(PKG_DIR, 'dist'), { recursive: true, force: true });
  console.log('✓ uninstalled (staged runtime + built daemon removed; source tree untouched).');
  console.log('  The Accessibility grant persists — remove it in System Settings if desired.');
}

// --- plumbing ----------------------------------------------------------------

function parseArgv(argv) {
  const args = { help: false, dryRun: false };
  const unknown = [];
  let command = 'install';
  const positional = [];
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('-')) unknown.push(a);
    else positional.push(a);
  }
  if (positional.length > 0) command = positional[0];
  return { command, args, unknown };
}

function warnUnknownFlags(unknown) {
  for (const f of unknown) console.error(`warning: ignoring unknown flag ${f}`);
}

function printHelp() {
  console.log(`
@opencues/mac — universal macOS host (Accessibility API)

Usage:
  install.cjs [install] [--dry-run]   build + stage + permission probe
  install.cjs uninstall               stop daemon, remove staged artifacts

Normally invoked via the opencues CLI:
  opencues install mac
  opencues run mac
`);
}
