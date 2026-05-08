#!/usr/bin/env node
// @opencues/claude-code CLI — install / uninstall.
//
// Usage:
//   opencues-claude-code                         # install (default)
//   opencues-claude-code install                 # explicit
//   opencues-claude-code uninstall               # roll back to pre-install state
//
// Common flags:
//   --target <path>   Path to claude-code's cli.js (default: auto-detect)
//   --dry-run         Print the plan, don't execute
//   --clean           Install: wipe ~/.claude/node_modules/@opencues/ first
//                     Uninstall: implied
//   --help            Show usage
//
// Today this runs from a clone via `pnpm --filter @opencues/claude-code dev-install`.
// Post-publish (Stage 8) the same script becomes the bin entry for
// `npx @opencues/claude-code`.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { targetExistsWithContent } = require('./seed-helpers.cjs');

const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

// Compact-footprint install layout (mirrors OpenCode):
//   <CC_FORK>/                        e.g. ~/claude-code-cues/
//     ├── node_modules/
//     │   ├── @anthropic-ai/claude-code/cli.js   ← patched in place
//     │   └── @opencues/{core,runtime}/          ← runtime install
//     └── .cues/                              ← all support files
//         ├── statusline.sh
//         ├── scripts/                            ← speak.sh + WSL .exe shims
//         └── patch-state/                        ← tweakcc backup + config
//
// Uninstall = `rm -rf <CC_FORK>` (or tweakcc --revert + `rm -rf .cues`
// if the user wants to keep the CC binary itself).
//
// We don't know <CC_FORK> until we've located cli.js, so the install root
// is computed inside doInstall/doUninstall, not at module load.

function computeInstallRoot(cliJsPath) {
  if (!cliJsPath) return null;
  // cli.js sits at <fork>/node_modules/@anthropic-ai/claude-code/cli.js.
  // Walk up 4 levels to get the fork dir.
  return path.join(path.resolve(path.dirname(cliJsPath), '..', '..', '..'), '.cues');
}

// Legacy paths from prior install layouts — removed on every install
// and uninstall regardless of whether this install created them.
// Pre-compact-footprint installs put everything under ~/.claude/opencues/.
function legacyPaths() {
  return [
    path.join(CLAUDE_DIR, 'node_modules', 'opencues-core'),
    path.join(CLAUDE_DIR, 'node_modules', 'opencues-runtime'),
    path.join(CLAUDE_DIR, 'node_modules', '@opencues', 'core'),
    path.join(CLAUDE_DIR, 'node_modules', '@opencues', 'runtime'),
    path.join(CLAUDE_DIR, 'claude-code-tips.json'),
    path.join(CLAUDE_DIR, 'highlight-statusline.sh'),
    // Pre-compact-footprint location (now inside the fork).
    path.join(CLAUDE_DIR, 'opencues'),
    // Action files we know we shipped (only these basenames removed
    // from the shared ~/.claude/actions/ dir; user files left alone).
    ...listActionFileBasenames().map(f => path.join(CLAUDE_DIR, 'actions', f)),
  ];
}

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
    '  pnpm --filter @opencues/claude-code dev-install\n',
  );
  process.exit(1);
}

if (command === 'install') {
  doInstall();
} else if (command === 'uninstall') {
  doUninstall();
} else if (command === 'seed-configs') {
  doSeedConfigs();
} else {
  console.error(`Unknown command: ${command}\n`);
  printHelp();
  process.exit(1);
}

// --- INSTALL --------------------------------------------------------------

function doInstall() {
  const target = args.target || tryAutoDetectCli();
  if (target) checkCompat(target);
  console.log(`Target cli.js: ${target || '(auto-detecting under ~/.claude/)'}`);

  const installRoot = computeInstallRoot(target);
  const tweakccConfigDir = installRoot ? path.join(installRoot, 'patch-state') : null;
  const legacy = legacyPaths();

  if (args.dryRun) {
    console.log(`\n[dry-run] Would install everything inside the CC fork dir:`);
    console.log(`  ${installRoot || '(unknown — pass --target to compute)'}/`);
    for (const p of ['statusline.sh', 'scripts/', 'patch-state/  (patcher config + cli.js.backup)']) {
      console.log(`    ${p}`);
    }
    console.log(`  ${target ? path.join(path.dirname(target), '..', '..', '@opencues') : '<fork>/node_modules/@opencues'}/`);
    console.log(`    core/`);
    console.log(`    runtime/`);
    console.log(`\n[dry-run] Would remove legacy paths if present:`);
    for (const p of legacy) console.log(`  ${p}`);
    if (target) console.log(`\n[dry-run] Would patch in place: ${target}`);
    console.log(`[dry-run] cli.js backup will be at: ${tweakccConfigDir || '<install-root>'}/cli.js.backup`);
    return;
  }

  // Delegate to setup.sh — strictly CC-specific work now (cli.js patching,
  // statusline install, tweakcc build/apply, settings.json fixup). All the
  // shared ~/.cues/ + ~/.cues/OPENCUES.md writes (blank library scripts, settings
  // self-heal, .cs compilation, TTS speak.sh) live in `opencues seed-configs`,
  // which the top-level `opencues install` invokes BEFORE this script runs.
  //
  // tweakcc clones into <CC_FORK>/.opencues/tweakcc by default — no need
  // to pass an override unless the user is hacking on a side checkout.
  // Pass through --keep-state for dev iteration; otherwise default to
  // from-scratch.
  const setupSh = path.join(PKG_DIR, 'patches', 'setup.sh');
  const setupArgs = [];
  if (args.keepState) setupArgs.push('--keep-state');
  const env = { ...process.env };
  if (target) env.OPENCUES_CC_TARGET = target;
  const result = spawnSync(setupSh, setupArgs, { stdio: 'inherit', env });

  // exit 2 from setup.sh = "everything built, but no cli.js to patch
  // and no target was given." Print a single actionable hint and bail.
  if (result.status === 2) {
    console.error('\nRe-run with --target /path/to/cli.js once Claude Code is installed.');
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`\nInstall failed. To roll back: ${launchCommand()} uninstall claude-code`);
    process.exit(result.status || 1);
  }
  // Success — setup.sh already printed "Done. Restart Claude Code to
  // activate." We stay silent.
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  const target = args.target || tryAutoDetectCli();
  const tweakccDir = path.join(PKG_DIR, 'tweakcc');
  const tweakccBin = path.join(tweakccDir, 'dist', 'index.mjs');

  const installRoot = computeInstallRoot(target);
  const tweakccConfigDir = installRoot ? path.join(installRoot, 'patch-state') : null;

  // Backup may live inside the new install root, the pre-compact-footprint
  // location, or the very-old ~/.tweakcc/ default. Try in that order.
  const candidates = [
    tweakccConfigDir && path.join(tweakccConfigDir, 'cli.js.backup'),
    path.join(CLAUDE_DIR, 'opencues', 'patch-state', 'cli.js.backup'),
    path.join(CLAUDE_DIR, 'opencues', 'tweakcc-state', 'cli.js.backup'),
    path.join(HOME, '.tweakcc', 'cli.js.backup'),
  ].filter(Boolean);
  const backup = candidates.find(p => fs.existsSync(p)) || null;

  const rootExists = installRoot && fs.existsSync(installRoot);
  const inForkNodeModules = target ? path.join(path.dirname(target), '..', '..', '@opencues') : null;
  const inForkExists = inForkNodeModules && fs.existsSync(inForkNodeModules);
  const legacy = legacyPaths();
  const legacyToRemove = legacy.filter(p => fs.existsSync(p));

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
  if (rootExists) console.log(`  rm -rf ${installRoot}/`);
  if (inForkExists) console.log(`  rm -rf ${inForkNodeModules}/  (runtime)`);
  for (const p of legacyToRemove) console.log(`  rm -rf ${p}  (legacy)`);
  if (!rootExists && !inForkExists && !legacyToRemove.length) {
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
    const revEnv = { ...process.env, TWEAKCC_CC_INSTALLATION_PATH: target };
    if (tweakccConfigDir) revEnv.TWEAKCC_CONFIG_DIR = tweakccConfigDir;
    const rev = spawnSync('node', [tweakccBin, '--revert'], {
      cwd: tweakccDir,
      env: revEnv,
      stdio: 'inherit',
    });
    if (rev.status !== 0) {
      console.warn(`  tweakcc --revert exited ${rev.status}; continuing with file removal.`);
    }
  } else if (target && backup) {
    fs.copyFileSync(backup, target);
    console.log(`  restored ${target} from ${backup}`);
  }

  // 2. Remove the in-fork install root + the @opencues runtime install.
  if (rootExists) {
    fs.rmSync(installRoot, { recursive: true, force: true });
    console.log(`  removed ${installRoot}/`);
  }
  if (inForkExists) {
    fs.rmSync(inForkNodeModules, { recursive: true, force: true });
    console.log(`  removed ${inForkNodeModules}/`);
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

// --- SEED CONFIGS ---------------------------------------------------------

// Thin wrapper that delegates to the canonical `opencues seed-configs`.
// User-level seeding (~/.cues/ + ~/.cues/OPENCUES.md) is shared across every
// native host — owning it here would drift from OC.
function doSeedConfigs() {
  const seedScript = path.join(REPO_ROOT, 'packages/opencues-cli/src/commands/seed-configs.cjs');
  const seedConfigs = require(seedScript);
  const argv = [];
  if (args.dryRun) argv.push('--dry-run');
  seedConfigs(argv, { REPO_ROOT });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
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
  // defaults/blanks/*/*.cs — compiled to ~/.claude/opencues/actions/<basename>.exe
  // by setup.sh's WSL .exe block (e.g. defaults/blanks/volume/VolCtl.cs → VolCtl.exe).
  const blanksDir = path.resolve(REPO_ROOT, 'defaults', 'blanks');
  if (fs.existsSync(blanksDir)) {
    for (const sub of fs.readdirSync(blanksDir)) {
      const subDir = path.join(blanksDir, sub);
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
    path.join(HOME, 'claude-code-cues', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
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
  const KNOWN_FLAGS = new Set(['--help', '-h', '--target', '--dry-run', '--clean', '--keep-state']);
  const VALUE_FLAGS = new Set(['--target']);
  const KNOWN_COMMANDS = new Set(['install', 'uninstall', 'seed-configs', 'help']);
  const out = { command: 'install', args: { help: false, dryRun: false, clean: false, keepState: false }, unknown: [] };
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
    else if (a === '--keep-state') out.args.keepState = true;
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
  console.log(`${pkg.name} v${pkg.version}`);
}

function printHelp() {
  printBanner();
  console.log('');
  console.log('Commands:');
  console.log('  install (default)   Build, install runtime + support files into the CC fork, patch cli.js');
  console.log('  uninstall           Revert cli.js + remove all installed paths');
  console.log('  seed-configs        Copy repo defaults to ~/.cues/ + ~/.cues/OPENCUES.md (skips files with content)');
  console.log('  help                Show this message');
  console.log('');
  console.log('Flags:');
  console.log('  --target <path>     Path to cli.js (auto-detected if omitted)');
  console.log('  --dry-run           Print the plan; do not execute');
  console.log('  --clean             Install: wipe runtime + core dirs first');
  console.log('  --help              Show this message');
  console.log('');
  console.log('Blast radius (compact footprint — everything inside the CC fork dir):');
  console.log('    <CC_FORK>/                e.g. ~/claude-code-cues/');
  console.log('      ├── node_modules/');
  console.log('      │   ├── @anthropic-ai/claude-code/cli.js   (patched in place,');
  console.log('      │   │                                       revertable via uninstall)');
  console.log('      │   └── @opencues/');
  console.log('      │       ├── core/        built @opencues/core');
  console.log('      │       └── runtime/     built @opencues/runtime');
  console.log('      └── .cues/');
  console.log('          ├── statusline.sh    wire via /statusline in CC');
  console.log('          ├── scripts/         OS-bound shell scripts + WSL .exe shims');
  console.log('          └── patch-state/     tweakcc config + cli.js.backup');
  console.log('                               (TWEAKCC_CONFIG_DIR override)');
  console.log('  Repo state (gitignored, lives only inside the clone):');
  console.log('    integrations/claude-code/tweakcc/   vendored upstream tool');
  console.log('    packages/*/dist/, .turbo/  build cache');
  console.log('  Runtime state (NOT created by install — appears when CC runs):');
  console.log('    /tmp/opencues.log');
  console.log('    /tmp/opencues-highlight-state-<pid>.json');
  console.log('    /tmp/opencues-cursor-state.json');
}

// Prefer the short "opencues" form when the binary is on PATH; fall back
// to the always-works-from-a-clone form. Used in user-facing hint messages.
function launchCommand() {
  const probe = spawnSync('command', ['-v', 'opencues'], { stdio: ['ignore', 'pipe', 'ignore'], shell: true });
  return probe.status === 0 ? 'opencues' : 'pnpm exec opencues';
}
