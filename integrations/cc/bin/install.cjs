#!/usr/bin/env node
// @opencues/cc CLI — install / uninstall.
//
// Usage:
//   opencues-cc                         # install (default)
//   opencues-cc install                 # explicit
//   opencues-cc uninstall               # roll back to pre-install state
//
// Common flags:
//   --target <path>   Path to claude-code's cli.js (default: auto-detect)
//   --dry-run         Print the plan, don't execute
//   --clean           Install: wipe ~/.claude/node_modules/@opencues/ first
//                     Uninstall: implied
//   --help            Show usage
//
// Today this runs from a clone via `pnpm --filter @opencues/cc dev-install`.
// Post-publish (Stage 8) the same script becomes the bin entry for
// `npx @opencues/cc`.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
// Single-dir install root. Everything @opencues/cc owns lives here, so
// uninstall is "rm -rf $INSTALL_ROOT + tweakcc revert". tweakcc's own
// config + cli.js.backup are redirected here too via TWEAKCC_CONFIG_DIR.
const INSTALL_ROOT = path.join(CLAUDE_DIR, 'opencues');
const TWEAKCC_CONFIG_DIR = path.join(INSTALL_ROOT, 'tweakcc-state');

// Single source of truth for blast radius. Install creates these,
// uninstall removes these, dry-run prints these.
const INSTALLED_PATHS = {
  // The whole install dir is what gets removed. Listed inside it for
  // visibility (dry-run prints these).
  root: INSTALL_ROOT,
  inside: [
    'core/',
    'runtime/',
    'tips.json',
    'statusline.sh',
    'actions/',
    'tweakcc-state/  (tweakcc config + cli.js.backup)',
  ],
  // Legacy paths from prior install layouts — removed on every install
  // and uninstall regardless of whether this install created them.
  legacy: [
    path.join(CLAUDE_DIR, 'node_modules', 'cues-core'),
    path.join(CLAUDE_DIR, 'node_modules', 'opencues-runtime'),
    path.join(CLAUDE_DIR, 'node_modules', '@opencues', 'core'),
    path.join(CLAUDE_DIR, 'node_modules', '@opencues', 'runtime'),
    path.join(CLAUDE_DIR, 'claude-code-tips.json'),
    path.join(CLAUDE_DIR, 'highlight-statusline.sh'),
    // Action files we know we shipped (only these basenames removed
    // from the shared ~/.claude/actions/ dir; user files left alone).
    ...listActionFileBasenames().map(f => path.join(CLAUDE_DIR, 'actions', f)),
  ],
};

const { command, args, unknown } = parseArgv(process.argv.slice(2));
warnUnknownFlags(unknown);
if (args.help || command === 'help') { printHelp(); process.exit(0); }

printBanner();

const isClone = fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'));
if (!isClone) {
  console.error(
    '\nPublished-package install path is not implemented yet (Stage 8 ships it).\n' +
    'For now, install from a clone:\n' +
    '  git clone https://github.com/opencues/opencues\n' +
    '  pnpm install\n' +
    '  pnpm --filter @opencues/cc dev-install\n',
  );
  process.exit(1);
}

if (command === 'install') {
  doInstall();
} else if (command === 'uninstall') {
  doUninstall();
} else {
  console.error(`Unknown command: ${command}\n`);
  printHelp();
  process.exit(1);
}

// --- INSTALL --------------------------------------------------------------

function doInstall() {
  const target = args.target || tryAutoDetectCli();
  if (target) {
    checkCompat(target);
    console.log(`Target cli.js: ${target}`);
  } else {
    console.log('Target cli.js: (auto-detect; setup.sh will look under ~/.claude/)');
  }

  if (args.dryRun) {
    console.log(`\n[dry-run] Would install everything under one dir:`);
    console.log(`  ${INSTALLED_PATHS.root}/`);
    for (const p of INSTALLED_PATHS.inside) console.log(`    ${p}`);
    console.log(`\n[dry-run] Would remove legacy paths if present:`);
    for (const p of INSTALLED_PATHS.legacy) console.log(`  ${p}`);
    if (target) console.log(`\n[dry-run] Would patch in place: ${target}`);
    console.log(`[dry-run] cli.js backup will be at: ${TWEAKCC_CONFIG_DIR}/cli.js.backup`);
    return;
  }

  // Delegate to setup.sh — it handles the full pipeline (build core +
  // runtime, install, build tweakcc, apply patches if cli.js auto-found).
  const setupSh = path.join(PKG_DIR, 'patches', 'setup.sh');
  const tweakccDir = path.join(PKG_DIR, 'tweakcc');
  const setupArgs = [];
  if (fs.existsSync(tweakccDir)) setupArgs.push(tweakccDir);
  if (args.clean) setupArgs.push('--clean');
  // setup.sh sets TWEAKCC_CONFIG_DIR itself, but pass it through too so
  // any tweakcc invocation we do later in this script picks it up.
  const env = { ...process.env, TWEAKCC_CONFIG_DIR };
  const result = spawnSync(setupSh, setupArgs, { stdio: 'inherit', env });

  // setup.sh exits non-zero when it can't auto-detect cli.js. If --target
  // was passed, fall through to apply patches directly via tweakcc.
  if (result.status !== 0 && !target) {
    console.error(`\n${pkg.name} install failed (setup.sh exited ${result.status}).`);
    console.error('If your claude-code install is at a non-standard path, re-run with:');
    console.error('  pnpm --filter @opencues/cc dev-install -- --target /path/to/cli.js');
    process.exit(result.status || 1);
  }

  if (target) {
    if (!fs.existsSync(target)) {
      console.error(`\n--target path not found: ${target}`);
      process.exit(1);
    }
    console.log(`\nApplying patches to ${target}...`);
    const tweakccBin = path.join(tweakccDir, 'dist', 'index.mjs');
    if (!fs.existsSync(tweakccBin)) {
      console.error(`tweakcc not built (expected ${tweakccBin}). Run setup.sh once first.`);
      process.exit(1);
    }
    const apply = spawnSync('node', [tweakccBin, '--apply'], {
      cwd: tweakccDir,
      env: { ...process.env, TWEAKCC_CC_INSTALLATION_PATH: target, TWEAKCC_CONFIG_DIR },
      stdio: 'inherit',
    });
    if (apply.status !== 0) {
      console.error(`\ntweakcc apply failed (exit ${apply.status}).`);
      process.exit(apply.status || 1);
    }
  }

  console.log(`\n${pkg.name} install complete.`);
  console.log('Restart claude-cues to pick up the patched cli.js.');
  console.log('To roll back: pnpm --filter @opencues/cc dev-uninstall');
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  const target = args.target || tryAutoDetectCli();
  const tweakccDir = path.join(PKG_DIR, 'tweakcc');
  const tweakccBin = path.join(tweakccDir, 'dist', 'index.mjs');
  // Backup lives inside the install root because TWEAKCC_CONFIG_DIR
  // redirected it there. Falls back to the legacy ~/.tweakcc/ location
  // for users uninstalling an old install.
  const newBackup = path.join(TWEAKCC_CONFIG_DIR, 'cli.js.backup');
  const legacyBackup = path.join(HOME, '.tweakcc', 'cli.js.backup');
  const backup = fs.existsSync(newBackup) ? newBackup : (fs.existsSync(legacyBackup) ? legacyBackup : null);

  const rootExists = fs.existsSync(INSTALLED_PATHS.root);
  const legacyToRemove = INSTALLED_PATHS.legacy.filter(p => fs.existsSync(p));

  console.log('Uninstall plan:');
  if (target && fs.existsSync(tweakccBin) && backup) {
    console.log(`  tweakcc --revert against ${target}  (backup: ${backup})`);
  } else if (target && backup) {
    console.log(`  cp ${backup} → ${target}`);
  } else if (target) {
    console.log(`  (no tweakcc backup found — manual cli.js restore needed)`);
  } else {
    console.log(`  (no --target given — skipping cli.js restore; pass --target to revert it)`);
  }
  if (rootExists) console.log(`  rm -rf ${INSTALLED_PATHS.root}/`);
  for (const p of legacyToRemove) console.log(`  rm -rf ${p}  (legacy)`);
  if (!rootExists && !legacyToRemove.length) {
    console.log('  (no installed paths found — appears clean)');
  }

  if (args.dryRun) {
    console.log('\n[dry-run] Nothing executed.');
    return;
  }

  console.log('');
  // 1. Revert the cli.js patch BEFORE removing the install dir
  //    (otherwise we'd nuke the backup that tweakcc reads from).
  if (target && fs.existsSync(tweakccBin) && backup) {
    console.log(`Reverting cli.js patches via tweakcc...`);
    const rev = spawnSync('node', [tweakccBin, '--revert'], {
      cwd: tweakccDir,
      env: { ...process.env, TWEAKCC_CC_INSTALLATION_PATH: target, TWEAKCC_CONFIG_DIR },
      stdio: 'inherit',
    });
    if (rev.status !== 0) {
      console.warn(`  tweakcc --revert exited ${rev.status}; continuing with file removal.`);
    }
  } else if (target && backup) {
    fs.copyFileSync(backup, target);
    console.log(`  restored ${target} from ${backup}`);
  }

  // 2. Remove the entire install root.
  if (rootExists) {
    fs.rmSync(INSTALLED_PATHS.root, { recursive: true, force: true });
    console.log(`  removed ${INSTALLED_PATHS.root}/`);
  }
  // 3. Remove any legacy paths from prior layouts.
  for (const p of legacyToRemove) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`  removed ${p}`);
  }
  rmdirIfEmpty(path.join(CLAUDE_DIR, 'node_modules', '@opencues'));

  console.log(`\n${pkg.name} uninstall complete.`);
  console.log('To fully remove the cloned repo: rm -rf <opencues-clone-dir>');
}

// --- helpers --------------------------------------------------------------

function listActionFileBasenames() {
  const out = [];
  // patches/actions/* — copied verbatim into ~/.claude/actions/.
  const actionsDir = path.join(PKG_DIR, 'patches', 'actions');
  if (fs.existsSync(actionsDir)) {
    for (const f of fs.readdirSync(actionsDir)) {
      out.push(f);
      // .cs files compile to .exe under WSL — track the .exe too.
      if (f.endsWith('.cs')) out.push(f.replace(/\.cs$/, '.exe'));
    }
  }
  // controls/*/*.cs — also compiled to ~/.claude/actions/<basename>.exe
  // by setup.sh's WSL .exe block (e.g. controls/volume/VolCtl.cs → VolCtl.exe).
  const controlsDir = path.resolve(REPO_ROOT, 'controls');
  if (fs.existsSync(controlsDir)) {
    for (const sub of fs.readdirSync(controlsDir)) {
      const subDir = path.join(controlsDir, sub);
      if (!fs.statSync(subDir).isDirectory()) continue;
      for (const f of fs.readdirSync(subDir)) {
        if (f.endsWith('.cs')) out.push(f.replace(/\.cs$/, '.exe'));
      }
    }
  }
  return [...new Set(out)];
}

function tryAutoDetectCli() {
  // Common locations. Order: standard npm install → claude-cues local install.
  const candidates = [
    path.join(CLAUDE_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(HOME, 'local-claude-code', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function checkCompat(cliJsPath) {
  // Try to read the host package's version from <cli.js>/../package.json.
  try {
    const hostPkgPath = path.resolve(path.dirname(cliJsPath), 'package.json');
    if (!fs.existsSync(hostPkgPath)) return;
    const hostPkg = JSON.parse(fs.readFileSync(hostPkgPath, 'utf8'));
    const hostVer = hostPkg.version;
    const range = pkg.compatibility && pkg.compatibility['claude-code'];
    if (!range || !hostVer) return;
    if (!matchesRange(hostVer, range)) {
      console.warn(`\nWARNING: detected ${hostPkg.name || 'host'} v${hostVer}, ` +
        `but ${pkg.name} declares compatibility with claude-code ${range}.`);
      console.warn('Patches may fail to apply. Continuing anyway.\n');
    }
  } catch { /* best effort — silent on error */ }
}

// Tiny semver-ish range matcher. Handles "X.Y.Z", "X.Y.x", "X.Y.x - X.Y.x".
function matchesRange(version, range) {
  const trimmed = range.replace(/\s+/g, '');
  if (trimmed.includes('-')) {
    const parts = trimmed.split('-');
    return parts.some(p => matchesAtom(version, p));
  }
  return matchesAtom(version, trimmed);
}
function matchesAtom(version, atom) {
  if (atom.endsWith('.x')) return version.startsWith(atom.slice(0, -1));
  return version === atom;
}

function rmdirIfEmpty(dir) {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* ignore */ }
}

function parseArgv(argv) {
  // First non-flag positional = command. Default 'install'.
  const KNOWN_FLAGS = new Set(['--help', '-h', '--target', '--dry-run', '--clean']);
  const VALUE_FLAGS = new Set(['--target']);
  const KNOWN_COMMANDS = new Set(['install', 'uninstall', 'help']);
  const out = { command: 'install', args: { help: false, dryRun: false, clean: false }, unknown: [] };
  let i = 0;
  if (argv[i] && !argv[i].startsWith('-')) {
    if (KNOWN_COMMANDS.has(argv[i])) {
      out.command = argv[i];
      i++;
    } else {
      out.unknown.push(argv[i]);
      i++;
    }
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue; // pnpm/npm separator — skip silently
    if (a === '--help' || a === '-h') out.args.help = true;
    else if (a === '--dry-run') out.args.dryRun = true;
    else if (a === '--clean') out.args.clean = true;
    else if (a === '--target') out.args.target = argv[++i];
    else out.unknown.push(a);
  }
  return out;
}

function warnUnknownFlags(unknown) {
  if (!unknown.length) return;
  console.warn(`WARNING: ignoring unknown argument(s): ${unknown.join(' ')}`);
  console.warn(`Known commands: install, uninstall, help`);
  console.warn(`Known flags:    --target <path>, --dry-run, --clean, --help`);
  console.warn('');
}

function printBanner() {
  console.log(`${pkg.name} v${pkg.version} — ${pkg.description}`);
  if (pkg.compatibility) {
    const compatStr = Object.entries(pkg.compatibility).map(([h, v]) => `${h} ${v}`).join(', ');
    console.log(`Compatible with: ${compatStr}`);
  }
}

function printHelp() {
  printBanner();
  console.log('');
  console.log('Commands:');
  console.log('  install (default)   Build, install runtime to ~/.claude/node_modules/, patch cli.js');
  console.log('  uninstall           Revert cli.js + remove all installed paths');
  console.log('  help                Show this message');
  console.log('');
  console.log('Flags:');
  console.log('  --target <path>     Path to cli.js (auto-detected if omitted)');
  console.log('  --dry-run           Print the plan; do not execute');
  console.log('  --clean             Install: wipe ~/.claude/node_modules/@opencues/ first');
  console.log('  --help              Show this message');
  console.log('');
  console.log('Blast radius:');
  console.log('  Everything installs under ONE dir:');
  console.log('    ~/.claude/opencues/');
  console.log('      ├── core/                built @opencues/core');
  console.log('      ├── runtime/             built @opencues/runtime');
  console.log('      ├── tips.json            pre-computed word tips');
  console.log('      ├── statusline.sh        wire via /statusline in CC');
  console.log('      ├── actions/             OS-bound shell scripts + WSL .exe shims');
  console.log('      └── tweakcc-state/       tweakcc config + cli.js.backup');
  console.log('                               (TWEAKCC_CONFIG_DIR override)');
  console.log('  Modified in place:');
  console.log('    <cli.js>                   (revertable via uninstall — backup');
  console.log('                                stored inside ~/.claude/opencues/)');
  console.log('  Repo state (gitignored, lives only inside the clone):');
  console.log('    integrations/cc/tweakcc/   vendored upstream tool');
  console.log('    packages/*/dist/, .turbo/  build cache');
  console.log('  Runtime state (NOT created by install — appears when CC runs):');
  console.log('    /tmp/opencues.log');
  console.log('    /tmp/claude-highlight-state-<pid>.json');
  console.log('    /tmp/claude-cursor-state.json');
}
