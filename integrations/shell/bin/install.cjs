#!/usr/bin/env node
// @opencues/shell CLI — install / uninstall.
//
// Unlike CC / OC / Gemini, the terminal integration ships its own app
// (Bun + OpenTUI). There is no upstream fork to clone or patch —
// install just builds @opencues/{core,runtime}, stages them into the
// integration's local node_modules, runs `bun install` for OpenTUI,
// and optionally symlinks `oc-shell` into a PATH location.

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
    '  opencues install shell\n',
  );
  process.exit(1);
}

if (command === 'install') doInstall();
else if (command === 'uninstall') doUninstall();
else if (command === 'seed-configs') doSeedConfigs();
else { console.error(`Unknown command: ${command}\n`); printHelp(); process.exit(1); }

// --- INSTALL --------------------------------------------------------------

function doInstall() {
  const bunCheck = spawnSync('which', ['bun'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (bunCheck.status !== 0) {
    const msg = args.dryRun
      ? '\nWARNING: bun is not on PATH. A real install would fail here — the terminal app is a Bun app.'
      : '\nERROR: bun is not on PATH. The terminal app is a Bun + OpenTUI app, so install cannot proceed.';
    console.error(msg);
    console.error('Install bun: curl -fsSL https://bun.sh/install | bash  (or https://bun.sh/)');
    console.error('Then re-run: opencues install shell');
    if (!args.dryRun) process.exit(127);
  }

  if (args.dryRun) {
    console.log('\n[dry-run] Would build @opencues/{core,runtime}.');
    console.log('[dry-run] Would run `bun install` in:');
    console.log(`  ${PKG_DIR}`);
    console.log('[dry-run] Would stage runtime + core into:');
    console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues', 'core')}/`);
    console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues', 'runtime')}/`);
    if (args.link) {
      // oc-edit and other internal helpers are intentionally NOT
      // symlinked — they're spawned by `oc-shell` via its own PATH
      // adjustment. The user-facing surface is `oc-shell` plus the two
      // one-time setup commands (oc-install-tmux,
      // oc-install-shell-integration).
      for (const b of ['oc-shell', 'oc-install-tmux', 'oc-install-shell-integration']) {
        console.log(`[dry-run] Would symlink: ${args.link}/${b} → ${path.join(PKG_DIR, 'bin', b)}`);
      }
    }
    return;
  }

  // Seed configs first so cues/blanks/OPENCUES.md are present before
  // the user's first `oc-shell` invocation.
  const seedConfigsPath = path.join(REPO_ROOT, 'packages/opencues-cli/src/commands/seed-configs.cjs');
  if (fs.existsSync(seedConfigsPath)) {
    const seedConfigs = require(seedConfigsPath);
    seedConfigs(['--silent'], { REPO_ROOT });
  }

  const setupSh = path.join(PKG_DIR, 'patches', 'setup.sh');
  const setupArgs = args.link ? ['--link', args.link] : [];
  const result = spawnSync('bash', [setupSh, ...setupArgs], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nInstall failed. To roll back: opencues uninstall terminal`);
    process.exit(result.status || 1);
  }
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  // The terminal integration is self-owned — blast radius is just the
  // local node_modules + the optional symlink the user passed via --link.
  const stagedCore = path.join(PKG_DIR, 'node_modules', '@opencues', 'core');
  const stagedRt = path.join(PKG_DIR, 'node_modules', '@opencues', 'runtime');
  const linkPaths = args.link
    ? ['oc-shell', 'oc-install-tmux', 'oc-install-shell-integration'].map((b) => path.join(args.link, b))
    : [];

  console.log('Uninstall plan:');
  for (const p of [stagedCore, stagedRt]) {
    if (fs.existsSync(p)) console.log(`  rm -rf ${p}`);
  }
  for (const linkPath of linkPaths) {
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink()) console.log(`  rm ${linkPath}`);
    } catch { /* ignore */ }
  }

  if (args.dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }

  for (const p of [stagedCore, stagedRt]) {
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); console.log(`  removed ${p}/`); }
  }
  for (const linkPath of linkPaths) {
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink()) { fs.unlinkSync(linkPath); console.log(`  removed ${linkPath}`); }
    } catch { /* ignore */ }
  }
  console.log(`\n${pkg.name} uninstall complete.`);
}

// --- SEED CONFIGS ---------------------------------------------------------

function doSeedConfigs() {
  // Delegate to the umbrella seed-configs — terminal has no host-specific
  // seed step (no fork to patch, no host-side bridge).
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
  const out = { command: 'install', args: { help: false, dryRun: false, link: null }, unknown: [] };
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

function printBanner() {
  console.log(`${pkg.name} v${pkg.version}`);
}

function printHelp() {
  printBanner();
  console.log('');
  console.log('Commands:');
  console.log('  install (default)   Build runtime, stage @opencues/* into local node_modules, run bun install');
  console.log('  uninstall           Remove the staged @opencues/* and optional `oc-shell` symlink');
  console.log('  seed-configs        Copy repo defaults to ~/.cues/ (skips files that exist)');
  console.log('  help                Show this message');
  console.log('');
  console.log('Flags:');
  console.log('  --link <dir>        Symlink bin/oc-shell + oc-install-tmux + oc-install-shell-integration into <dir>');
  console.log('                        (typically ~/.local/bin). oc-edit and other helpers are internal —');
  console.log('                        `oc-shell` adds the bin/ dir to PATH for its own children only.');
  console.log('  --dry-run           Print the plan; do not execute');
  console.log('  --help              Show this message');
  console.log('');
  console.log('Blast radius (much smaller than the patching hosts — no fork to clone):');
  console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues', 'core')}/`);
  console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues', 'runtime')}/`);
  console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opentui')}/        (and other Bun-resolved deps)`);
  console.log(`  --link target (optional symlink only)`);
  console.log('  Repo state (no host pollution):');
  console.log('    packages/*/dist/  (build cache, gitignored)');
}
