#!/usr/bin/env node
// @opencues/windows CLI — install / uninstall / seed-configs.
//
// Self-owned host (like shell): no upstream fork to patch. Install just
// seeds ~/.cues, builds @opencues/{core,runtime}, stages them into this
// integration's node_modules, and (optionally) symlinks `oc-windows`.
// The Windows-native shim (native/OpenCuesWindows.cs) needs no build
// here — it's Add-Type-compiled on Windows at launch.

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

printBanner();

const isClone = fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'));
if (!isClone) {
  console.error(
    '\nPublished-package install path is not implemented yet.\n' +
    'For now, install from a clone:\n' +
    '  git clone https://github.com/opencues/opencues\n' +
    '  pnpm install\n' +
    '  opencues install windows\n',
  );
  process.exit(1);
}

if (command === 'install') doInstall();
else if (command === 'uninstall') doUninstall();
else if (command === 'seed-configs') doSeedConfigs();
else { console.error(`Unknown command: ${command}\n`); printHelp(); process.exit(1); }

// --- INSTALL --------------------------------------------------------------

function doInstall() {
  if (args.dryRun) {
    console.log('\n[dry-run] Would seed ~/.cues (skips existing files).');
    console.log('[dry-run] Would build @opencues/{core,runtime}.');
    console.log('[dry-run] Would stage runtime + core into:');
    console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues', 'core')}/`);
    console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues', 'runtime')}/`);
    if (args.link) console.log(`[dry-run] Would symlink: ${args.link}/oc-windows → ${path.join(PKG_DIR, 'bin', 'oc-windows')}`);
    return;
  }

  // Seed configs first so cues/blanks/OPENCUES.md exist before first run.
  const seedConfigsPath = path.join(REPO_ROOT, 'packages/opencues-cli/src/commands/seed-configs.cjs');
  if (fs.existsSync(seedConfigsPath)) {
    require(seedConfigsPath)(['--silent'], { REPO_ROOT });
  }

  const setupSh = path.join(PKG_DIR, 'patches', 'setup.sh');
  const setupArgs = args.link ? ['--link', args.link] : [];
  const result = spawnSync('bash', [setupSh, ...setupArgs], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nInstall failed. To roll back: opencues uninstall windows`);
    process.exit(result.status || 1);
  }

  // Version marker for drift detection (marker lands in node_modules/
  // @opencues alongside the staged runtime, same as shell).
  try {
    const { writeMarker } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
    writeMarker('windows', path.join(PKG_DIR, 'node_modules', '@opencues'), { pkg, REPO_ROOT });
  } catch { /* non-fatal */ }

  printLaunchSummary();
}

function printLaunchSummary() {
  const dim = process.stdout.isTTY ? '\x1b[2m' : '';
  const reset = process.stdout.isTTY ? '\x1b[22m' : '';
  console.log('');
  console.log(`Launch:  ${'oc-windows'.padEnd(14)} ${dim}# starts the WSL daemon + prints the Windows PowerShell command${reset}`);
  console.log(`         ${''.padEnd(14)} ${dim}# (or: opencues run windows)${reset}`);
  console.log('');
  console.log('Then, on Windows, run the printed:');
  console.log(`  ${dim}powershell -ExecutionPolicy Bypass -File "\\\\wsl.localhost\\<distro>\\...\\OpenCuesWindows.ps1" -Port <port>${reset}`);
  console.log('');
  console.log('Requires: Windows PowerShell 5.1 (built in) + an LLM key in your WSL env (e.g. GROQ_API_KEY).');
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  const stagedCore = path.join(PKG_DIR, 'node_modules', '@opencues', 'core');
  const stagedRt = path.join(PKG_DIR, 'node_modules', '@opencues', 'runtime');
  const linkPath = args.link ? path.join(args.link, 'oc-windows') : null;

  const plan = [];
  for (const p of [stagedCore, stagedRt]) if (fs.existsSync(p)) plan.push({ kind: 'rmdir', path: p });
  if (linkPath) { try { if (fs.lstatSync(linkPath).isSymbolicLink()) plan.push({ kind: 'unlink', path: linkPath }); } catch {} }

  console.log('Uninstall plan:');
  if (!plan.length) console.log('  (nothing to remove — appears clean)');
  else for (const s of plan) console.log(`  ${s.kind === 'rmdir' ? 'rm -rf' : 'rm'} ${s.path}`);
  console.log(`  ${dim('NEVER touches ~/.cues/ — user configs survive uninstall.')}`);

  if (args.dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }

  for (const s of plan) {
    try {
      if (s.kind === 'rmdir') { fs.rmSync(s.path, { recursive: true, force: true }); console.log(`  removed ${s.path}/`); }
      else { fs.unlinkSync(s.path); console.log(`  removed ${s.path}`); }
    } catch (err) { console.warn(`  WARN: failed ${s.kind} ${s.path}: ${err.message}`); }
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
  const out = { command: 'install', args: { help: false, dryRun: false, link: null }, unknown: [] };
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
    else if (a === '--link') out.args.link = argv[++i];
    else out.unknown.push(a);
  }
  return out;
}

function warnUnknownFlags(unknown) {
  if (!unknown.length) return;
  console.warn(`WARNING: ignoring unknown argument(s): ${unknown.join(' ')}`);
  console.warn(`Known commands: install, uninstall, seed-configs, help`);
  console.warn(`Known flags:    --link <dir>, --dry-run, --help`);
  console.warn('');
}

function printBanner() { console.log(`${pkg.name} v${pkg.version}`); }

function printHelp() {
  printBanner();
  console.log('');
  console.log('Commands:');
  console.log('  install (default)   Seed ~/.cues, build runtime, stage @opencues/* into local node_modules');
  console.log('  uninstall           Remove the staged @opencues/* and optional `oc-windows` symlink');
  console.log('  seed-configs        Copy repo defaults to ~/.cues/ (skips files that exist)');
  console.log('  help                Show this message');
  console.log('');
  console.log('Flags:');
  console.log('  --link <dir>        Symlink bin/oc-windows into <dir> (typically ~/.local/bin)');
  console.log('  --dry-run           Print the plan; do not execute');
  console.log('  --help              Show this message');
  console.log('');
  console.log('The Windows-native shim (native/OpenCuesWindows.cs) is compiled on Windows at launch');
  console.log('via Add-Type — no .NET SDK, no build step here.');
}
