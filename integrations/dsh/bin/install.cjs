#!/usr/bin/env node
// @opencues/dsh CLI — install / uninstall / seed-configs.
//
// Unlike every other integration, THIS ONE DOES NOT OWN THE INSTALL.
// dsh has a real plugin system, and `dsh plugin --profile <p> add <pkg>` is
// the supported way in. So this installer is a thin, honest wrapper: it
// builds the bundle from source and then hands off to dsh's own command.
// It deliberately does not write into `$DSH_HOME/profiles/` itself —
// that directory is dsh's to manage (it maintains the profile manifest and
// its pnpm lockfile), and reaching into it would be exactly the kind of
// second install path that later disagrees with the first.
//
// Most users should not need this at all. The published package installs
// with one dsh command and no OpenCues CLI:
//
//   dsh plugin --profile web add @opencues/dsh
//
// This exists for the from-a-clone path: contributors, and anyone who wants
// the bundle built from their working tree rather than from npm.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
const DEFAULT_PROFILE = 'web';

const { command, args, unknown } = parseArgv(process.argv.slice(2));
warnUnknownFlags(unknown);
if (args.help || command === 'help') { printHelp(); process.exit(0); }

printBanner();

const isClone = fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'));
if (!isClone) {
  // Not a failure mode worth engineering around: from a published CLI the
  // right answer is dsh's own command, which needs nothing from us.
  console.error(
    '\nThis path builds the plugin from a repo checkout, and this is not one.\n' +
    'Install the published package directly — it needs no OpenCues CLI:\n' +
    `  dsh plugin --profile ${DEFAULT_PROFILE} add ${pkg.name}\n`,
  );
  process.exit(1);
}

if (command === 'install') doInstall();
else if (command === 'uninstall') doUninstall();
else if (command === 'seed-configs') doSeedConfigs();
else { console.error(`Unknown command: ${command}\n`); printHelp(); process.exit(1); }

// --- INSTALL --------------------------------------------------------------

function doInstall() {
  const profile = args.profile || DEFAULT_PROFILE;

  if (args.dryRun) {
    console.log(`\n[dry-run] Would seed ~/.cues (skips existing files).`);
    console.log(`[dry-run] Would build @opencues/{core,runtime}, then bundle the browser half.`);
    console.log(`[dry-run] Would run: dsh plugin --profile ${profile} add ${PKG_DIR}`);
    return;
  }

  // Seed ~/.cues first, matching every other host. Note this is a
  // convenience, NOT a requirement: the bundle carries the shipped
  // defaults, so the plugin works with no ~/.cues at all.
  const seedConfigsPath = path.join(REPO_ROOT, 'packages/opencues-cli/src/commands/seed-configs.cjs');
  if (fs.existsSync(seedConfigsPath)) {
    require(seedConfigsPath)(['--silent'], { REPO_ROOT });
  }

  // The browser half inlines @opencues/{core,runtime} at bundle time, so
  // those have to be BUILT before esbuild runs or it inlines stale dist.
  for (const filter of ['@opencues/core', '@opencues/runtime']) {
    const built = spawnSync('pnpm', ['--filter', filter, 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    if (built.status !== 0) {
      console.error(`\nFailed to build ${filter}. Install aborted.`);
      process.exit(built.status || 1);
    }
  }

  const bundled = spawnSync('node', [path.join(PKG_DIR, 'build.mjs')], { cwd: PKG_DIR, stdio: 'inherit' });
  if (bundled.status !== 0) {
    console.error('\nFailed to bundle the browser half. Install aborted.');
    process.exit(bundled.status || 1);
  }

  // Drift marker, written HERE — as soon as the bundle exists, before the
  // handoff. It records which @opencues/{core,runtime} the built artifact
  // carries, which is now true regardless of whether dsh is on this machine's
  // PATH. Writing it after the handoff instead meant a developer without the
  // dsh CLI got a permanently stale `doctor` row for a bundle that was in fact
  // current, and no amount of re-running the installer cleared it.
  //
  // Lives beside the built artifact rather than in dsh's profile dir, for the
  // same reason the install hands off: that directory is dsh's.
  try {
    const { writeMarker } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
    writeMarker('dsh', path.join(PKG_DIR, 'node_modules', '@opencues'), { pkg, REPO_ROOT });
  } catch { /* non-fatal — drift detection degrades, the install is fine */ }

  // Hand off to dsh. `dsh` on PATH is the one hard requirement, and the
  // message says so rather than letting spawnSync's ENOENT surface raw.
  const added = spawnSync('dsh', ['plugin', '--profile', profile, 'add', PKG_DIR], { stdio: 'inherit' });
  if (added.error && added.error.code === 'ENOENT') {
    console.error(
      '\n`dsh` is not on PATH, so the plugin could not be registered.\n' +
      'The bundle IS built. Install dsh, then either re-run this or do it directly:\n' +
      `  dsh plugin --profile ${profile} add ${PKG_DIR}\n`,
    );
    process.exit(1);
  }
  if (added.status !== 0) {
    console.error(`\n\`dsh plugin add\` failed (exit ${added.status}). To roll back: opencues uninstall dsh`);
    process.exit(added.status || 1);
  }

  printLaunchSummary(profile);
}

function printLaunchSummary(profile) {
  console.log('');
  console.log(`Launch:  dsh --profile ${profile}      ${dim('# then RELOAD the browser tab')}`);
  console.log('');
  console.log(`${dim('Plugin bundles are served per page load, so a reload is how a rebuild takes effect.')}`);
  console.log(`${dim('Settings live at Settings > Plugins > OpenCues (model routing + every feature scalar).')}`);
  console.log('');
  console.log(`${dim('No API key needed: by default OpenCues routes through the model dsh is already using.')}`);
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  const profile = args.profile || DEFAULT_PROFILE;
  const artifacts = [
    path.join(PKG_DIR, 'client.js'),
    path.join(PKG_DIR, 'default-opencues.md'),
  ].filter(p => fs.existsSync(p));

  console.log('Uninstall plan:');
  console.log(`  dsh plugin --profile ${profile} remove ${pkg.name}   ${dim('(removes the dependency AND the bundle layer)')}`);
  for (const p of artifacts) console.log(`  rm ${p}`);
  if (!artifacts.length) console.log(`  ${dim('(no local build artifacts to remove)')}`);
  console.log(`  ${dim('NEVER touches ~/.cues/ — user configs survive uninstall.')}`);

  if (args.dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }

  const removed = spawnSync('dsh', ['plugin', '--profile', profile, 'remove', pkg.name], { stdio: 'inherit' });
  if (removed.error && removed.error.code === 'ENOENT') {
    console.warn('\nWARN: `dsh` not on PATH — the bundle layer is still registered in the profile.');
    console.warn(`      Run this once dsh is available: dsh plugin --profile ${profile} remove ${pkg.name}`);
  } else if (removed.status !== 0) {
    console.warn(`\nWARN: \`dsh plugin remove\` exited ${removed.status}; the profile may still list ${pkg.name}.`);
  }

  for (const p of artifacts) {
    try { fs.unlinkSync(p); console.log(`  removed ${p}`); }
    catch (err) { console.warn(`  WARN: failed rm ${p}: ${err.message}`); }
  }
  console.log(`\n${pkg.name} uninstall complete.`);
}

function doSeedConfigs() {
  const seedConfigsPath = path.join(REPO_ROOT, 'packages/opencues-cli/src/commands/seed-configs.cjs');
  if (fs.existsSync(seedConfigsPath)) require(seedConfigsPath)([], { REPO_ROOT });
  else { console.error('seed-configs.cjs not found; cannot run.'); process.exit(1); }
}

// --- helpers --------------------------------------------------------------

function dim(s) { return `\x1b[2m${s}\x1b[22m`; }

function parseArgv(argv) {
  const KNOWN = new Set(['install', 'uninstall', 'seed-configs', 'help']);
  const out = { command: 'install', args: { help: false, dryRun: false, profile: null }, unknown: [] };
  let i = 0;
  if (argv[i] && !argv[i].startsWith('-')) {
    if (KNOWN.has(argv[i])) { out.command = argv[i]; i++; }
    else { out.unknown.push(argv[i]); i++; }
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--help' || a === '-h') out.args.help = true;
    else if (a === '--dry-run') out.args.dryRun = true;
    else if (a === '--profile') out.args.profile = argv[++i];
    // The shared installer contract passes these through to every host;
    // they are meaningful elsewhere and simply have nothing to do here.
    else if (a === '--no-prompts' || a === '--yes' || a === '--silent') continue;
    else out.unknown.push(a);
  }
  return out;
}

function warnUnknownFlags(unknown) {
  if (!unknown.length) return;
  console.warn(`WARNING: ignoring unknown argument(s): ${unknown.join(' ')}`);
  console.warn(`Known commands: install, uninstall, seed-configs, help`);
  console.warn(`Known flags:    --profile <name>, --dry-run, --help`);
  console.warn('');
}

function printBanner() { console.log(`${pkg.name} v${pkg.version}`); }

function printHelp() {
  printBanner();
  console.log('');
  console.log('Most users want dsh\'s own command instead of this — it needs no OpenCues CLI:');
  console.log(`  dsh plugin --profile ${DEFAULT_PROFILE} add ${pkg.name}`);
  console.log('');
  console.log('This wrapper builds the bundle from a repo checkout and then hands off to that.');
  console.log('');
  console.log('Commands:');
  console.log('  install (default)   Seed ~/.cues, build core+runtime, bundle, then `dsh plugin add`');
  console.log('  uninstall           `dsh plugin remove`, then delete local build artifacts');
  console.log('  seed-configs        Copy repo defaults to ~/.cues/ (skips files that exist)');
  console.log('  help                Show this message');
  console.log('');
  console.log('Flags:');
  console.log(`  --profile <name>    dsh profile to install into (default: ${DEFAULT_PROFILE})`);
  console.log('  --dry-run           Print the plan; do not execute');
  console.log('  --help              Show this message');
  console.log('');
  console.log('Requires `dsh` on PATH. Reload the browser tab after installing.');
}
