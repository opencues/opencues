#!/usr/bin/env node
// @opencues/apple-notes CLI — install / uninstall.
//
// Self-owned host like shell: no upstream fork to patch. Install builds
// @opencues/{core,runtime} + the daemon, stages the built packages into
// this integration's node_modules, writes the drift-detection version
// marker, and fires the Automation TCC prompt via setup.sh's probe.

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
    '  opencues install apple-notes\n',
  );
  process.exit(1);
}

if (command === 'install') doInstall();
else if (command === 'uninstall') doUninstall();
else if (command === 'seed-configs') doSeedConfigs();
else { console.error(`Unknown command: ${command}\n`); printHelp(); process.exit(1); }

// --- INSTALL --------------------------------------------------------------

function doInstall() {
  if (process.platform !== 'darwin') {
    console.error('\nERROR: the apple-notes integration is macOS-only (Notes.app + osascript).');
    if (!args.dryRun) process.exit(1);
  }

  if (args.dryRun) {
    console.log('\n[dry-run] Would build @opencues/{core,runtime} + the apple-notes daemon.');
    console.log('[dry-run] Would stage runtime + core into:');
    console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues', 'core')}/`);
    console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues', 'runtime')}/`);
    console.log('[dry-run] Would probe the Notes Automation permission (TCC prompt).');
    return;
  }

  // Seed configs first so cues/blanks/OPENCUES.md exist before first run.
  const seedConfigsPath = path.join(REPO_ROOT, 'packages/opencues-cli/src/commands/seed-configs.cjs');
  if (fs.existsSync(seedConfigsPath)) {
    const seedConfigs = require(seedConfigsPath);
    seedConfigs(['--silent'], { REPO_ROOT });
  }

  const setupSh = path.join(PKG_DIR, 'patches', 'setup.sh');
  const result = spawnSync('bash', [setupSh], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('\nInstall failed. To roll back: opencues uninstall apple-notes');
    process.exit(result.status || 1);
  }

  // Version marker for drift detection — same location convention as
  // shell (self-owned host, marker beside the staged runtime).
  try {
    const { writeMarker } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
    writeMarker('apple-notes', path.join(PKG_DIR, 'node_modules', '@opencues'), { pkg, REPO_ROOT });
  } catch { /* non-fatal */ }

  printLaunchSummary();
}

function printLaunchSummary() {
  const dim = process.stdout.isTTY ? '\x1b[2m' : '';
  const reset = process.stdout.isTTY ? '\x1b[22m' : '';
  console.log('');
  console.log(`Launch:   ${'opencues run apple-notes'.padEnd(26)} ${dim}# watches every unlocked note for cues${reset}`);
  console.log(`Try it:   type ${dim}what is the capital of france _${reset} in any note`);
  console.log(`Logs:     tail -f /tmp/opencues.log | grep '\\[apple-notes\\]'`);
  console.log('');
  console.log('Notes with attachments are skipped (a fill would destroy them);');
  console.log('password-locked notes are invisible to the daemon.');
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  const stagedCore = path.join(PKG_DIR, 'node_modules', '@opencues', 'core');
  const stagedRt = path.join(PKG_DIR, 'node_modules', '@opencues', 'runtime');
  const distDir = path.join(PKG_DIR, 'dist');
  const plan = [stagedCore, stagedRt, distDir].filter(p => fs.existsSync(p));

  console.log('Uninstall plan:');
  if (plan.length === 0) console.log('  (nothing to remove — appears clean)');
  for (const p of plan) console.log(`  rm -rf ${p}`);
  console.log('  NOTE: ~/.cues/ configs are never touched; the macOS Automation');
  console.log('  permission grant persists (revoke in System Settings if desired).');

  if (args.dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }
  for (const p of plan) {
    try { fs.rmSync(p, { recursive: true, force: true }); console.log(`  removed ${p}/`); }
    catch (err) { console.warn(`  WARN: failed to remove ${p}: ${err.message}`); }
  }
  console.log(`\n${pkg.name} uninstall complete.`);
}

// --- SEED CONFIGS ---------------------------------------------------------

function doSeedConfigs() {
  const seedConfigsPath = path.join(REPO_ROOT, 'packages/opencues-cli/src/commands/seed-configs.cjs');
  if (fs.existsSync(seedConfigsPath)) {
    const seedConfigs = require(seedConfigsPath);
    seedConfigs([], { REPO_ROOT });
  } else {
    console.error('seed-configs.cjs not found; cannot run.');
    process.exit(1);
  }
}

// --- helpers --------------------------------------------------------------

function parseArgv(argv) {
  const KNOWN_COMMANDS = new Set(['install', 'uninstall', 'seed-configs', 'help']);
  const out = { command: 'install', args: { help: false, dryRun: false }, unknown: [] };
  let i = 0;
  if (argv[i] && !argv[i].startsWith('-')) {
    if (KNOWN_COMMANDS.has(argv[i])) { out.command = argv[i]; i++; }
    else { out.unknown.push(argv[i]); i++; }
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--help' || a === '-h') out.args.help = true;
    else if (a === '--dry-run') out.args.dryRun = true;
    else out.unknown.push(a);
  }
  return out;
}

function warnUnknownFlags(unknown) {
  if (!unknown.length) return;
  console.warn(`WARNING: ignoring unknown argument(s): ${unknown.join(' ')}`);
  console.warn('Known commands: install, uninstall, seed-configs, help');
  console.warn('Known flags:    --dry-run, --help');
  console.warn('');
}

function printHelp() {
  console.log(`${pkg.name} v${pkg.version}`);
  console.log('');
  console.log('Commands:');
  console.log('  install (default)   Build runtime + daemon, stage @opencues/*, probe Automation permission');
  console.log('  uninstall           Remove staged @opencues/* and the built daemon');
  console.log('  seed-configs        Copy repo defaults to ~/.cues/ (skips files that exist)');
  console.log('  help                Show this message');
  console.log('');
  console.log('Flags:');
  console.log('  --dry-run           Print the plan; do not execute');
  console.log('');
  console.log('Blast radius (self-owned host — no fork, no app patching):');
  console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues')}/`);
  console.log(`  ${path.join(PKG_DIR, 'dist')}/`);
  console.log('  One macOS Automation permission grant (terminal → Notes).');
}
