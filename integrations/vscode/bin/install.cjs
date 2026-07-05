#!/usr/bin/env node
// opencues-vscode CLI — install / uninstall.
//
// Self-owned host (like shell): there is no upstream fork to clone or
// patch. Install = build @opencues/{core,runtime}, stage them into this
// package's node_modules, esbuild the extension bundle, write the drift
// marker, and symlink the extension folder into every detected VS Code
// extensions dir so `Developer: Reload Window` picks up rebuilds
// without a reinstall.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
const EXT_LINK_BASENAME = 'opencues.opencues-vscode';

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
    '  opencues install vscode\n',
  );
  process.exit(1);
}

if (command === 'install') doInstall();
else if (command === 'uninstall') doUninstall();
else if (command === 'seed-configs') doSeedConfigs();
else { console.error(`Unknown command: ${command}\n`); printHelp(); process.exit(1); }

// --- extensions-dir detection ----------------------------------------------

// Every VS Code flavour keeps user extensions in a well-known dir. On a
// WSL/SSH remote the extension MUST land in ~/.vscode-server/extensions
// (it's extensionKind "workspace" — it runs remote-side, where ~/.cues
// and Node live).
function detectExtensionsDirs() {
  const HOME = os.homedir();
  const candidates = [
    path.join(HOME, '.vscode', 'extensions'),
    path.join(HOME, '.vscode-server', 'extensions'),
    path.join(HOME, '.vscode-insiders', 'extensions'),
    path.join(HOME, '.vscode-server-insiders', 'extensions'),
  ];
  return candidates.filter(d => fs.existsSync(d));
}

// --- INSTALL --------------------------------------------------------------

function doInstall() {
  const extDirs = args.extensionsDir ? [args.extensionsDir] : detectExtensionsDirs();

  if (args.dryRun) {
    console.log('\n[dry-run] Would build @opencues/{core,runtime}.');
    console.log('[dry-run] Would stage runtime + core into:');
    console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues', 'core')}/`);
    console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues', 'runtime')}/`);
    console.log('[dry-run] Would bundle src/extension.ts → dist/extension.js.');
    if (extDirs.length === 0) {
      console.log('[dry-run] No VS Code extensions dir detected — would print manual-load instructions.');
    }
    for (const d of extDirs) {
      console.log(`[dry-run] Would symlink: ${path.join(d, EXT_LINK_BASENAME)} → ${PKG_DIR}`);
    }
    return;
  }

  // Seed configs first so cues/blanks/OPENCUES.md exist before first boot.
  const seedConfigsPath = path.join(REPO_ROOT, 'packages/opencues-cli/src/commands/seed-configs.cjs');
  if (fs.existsSync(seedConfigsPath)) {
    const seedConfigs = require(seedConfigsPath);
    seedConfigs(['--silent'], { REPO_ROOT });
  }

  const setupSh = path.join(PKG_DIR, 'patches', 'setup.sh');
  const result = spawnSync('bash', [setupSh], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('\nInstall failed. To roll back: opencues uninstall vscode');
    process.exit(result.status || 1);
  }

  // Symlink the extension folder into every detected extensions dir.
  // A symlink (not a copy) keeps rebuild → reload as the whole dev loop.
  let linked = 0;
  for (const d of extDirs) {
    try {
      const linkName = path.join(d, EXT_LINK_BASENAME);
      try { fs.rmSync(linkName, { recursive: true, force: true }); } catch { /* fresh */ }
      fs.symlinkSync(PKG_DIR, linkName, 'dir');
      console.log(`  ▸ linked extension → ${linkName}`);
      linked++;
    } catch (err) {
      console.warn(`  WARN: could not link into ${d}: ${err.message}`);
    }
  }

  // Version marker for drift detection (self-owned — marker lands in
  // node_modules/@opencues alongside the staged runtime, shell's model).
  try {
    const { writeMarker } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
    writeMarker('vscode', path.join(PKG_DIR, 'node_modules', '@opencues'), { pkg, REPO_ROOT });
  } catch { /* non-fatal */ }

  console.log('');
  if (linked > 0) {
    console.log('Activate:  reload VS Code windows (Developer: Reload Window), then open a');
    console.log('           markdown / plaintext / commit-message file.');
  } else {
    console.log('No VS Code extensions dir detected. Load manually with either:');
    console.log(`  code --extensionDevelopmentPath=${PKG_DIR}`);
    console.log(`  ln -s ${PKG_DIR} <your-extensions-dir>/${EXT_LINK_BASENAME}`);
  }
  console.log('Keys:      export GROQ_API_KEY=... (or `opencues set-key`) if not already set.');
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  // Everything we own: staged @opencues packages, the dist bundle, and
  // the extensions-dir symlinks. NEVER touch ~/.cues/ — user configs
  // survive every uninstall, by design.
  const stagedCore = path.join(PKG_DIR, 'node_modules', '@opencues', 'core');
  const stagedRt = path.join(PKG_DIR, 'node_modules', '@opencues', 'runtime');
  const distDir = path.join(PKG_DIR, 'dist');
  const extDirs = args.extensionsDir ? [args.extensionsDir] : detectExtensionsDirs();

  const plan = [];
  for (const p of [stagedCore, stagedRt, distDir]) {
    if (fs.existsSync(p)) plan.push({ kind: 'rmdir', path: p });
  }
  for (const d of extDirs) {
    const linkName = path.join(d, EXT_LINK_BASENAME);
    try { if (fs.lstatSync(linkName).isSymbolicLink()) plan.push({ kind: 'unlink', path: linkName }); }
    catch { /* not present */ }
  }

  console.log('Uninstall plan:');
  if (plan.length === 0) console.log('  (nothing to remove — appears clean)');
  for (const step of plan) {
    console.log(`  ${step.kind === 'unlink' ? 'rm' : 'rm -rf'} ${step.path}`);
  }
  if (args.dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }

  for (const step of plan) {
    try {
      if (step.kind === 'rmdir') fs.rmSync(step.path, { recursive: true, force: true });
      else fs.unlinkSync(step.path);
      console.log(`  removed ${step.path}`);
    } catch (err) {
      console.warn(`  WARN: failed ${step.kind} ${step.path}: ${err.message}`);
    }
  }
  console.log(`\n${pkg.name} uninstall complete. Reload VS Code windows to deactivate.`);
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
  const out = { command: 'install', args: { help: false, dryRun: false, extensionsDir: null }, unknown: [] };
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
    else if (a === '--extensions-dir') out.args.extensionsDir = argv[++i];
    else out.unknown.push(a);
  }
  return out;
}

function warnUnknownFlags(unknown) {
  if (!unknown.length) return;
  console.warn(`WARNING: ignoring unknown argument(s): ${unknown.join(' ')}`);
  console.warn('Known commands: install, uninstall, seed-configs, help');
  console.warn('Known flags:    --extensions-dir <dir>, --dry-run, --help');
  console.warn('');
}

function printBanner() {
  console.log(`${pkg.name} v${pkg.version}`);
}

function printHelp() {
  printBanner();
  console.log('');
  console.log('Commands:');
  console.log('  install (default)   Build runtime, stage @opencues/*, bundle the extension, link into VS Code');
  console.log('  uninstall           Remove staged @opencues/*, dist/, and the extensions-dir symlinks');
  console.log('  seed-configs        Copy repo defaults to ~/.cues/ (skips files that exist)');
  console.log('  help                Show this message');
  console.log('');
  console.log('Flags:');
  console.log('  --extensions-dir <dir>  Link into <dir> instead of auto-detecting');
  console.log('                          (~/.vscode/extensions, ~/.vscode-server/extensions, insiders variants)');
  console.log('  --dry-run               Print the plan; do not execute');
  console.log('  --help                  Show this message');
  console.log('');
  console.log('Blast radius (self-owned — no fork, no host files patched):');
  console.log(`  ${path.join(PKG_DIR, 'node_modules', '@opencues')}/   (staged runtime + core + drift marker)`);
  console.log(`  ${path.join(PKG_DIR, 'dist')}/                        (extension bundle)`);
  console.log(`  <extensions-dir>/${EXT_LINK_BASENAME}   (symlink only)`);
  console.log('  ~/.cues/ is seeded but NEVER removed by uninstall.');
}
