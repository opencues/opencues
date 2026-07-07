#!/usr/bin/env node
// @opencues/gemini-cli CLI — install / uninstall.
//
// Usage:
//   opencues-gemini-cli                      # install (default; clones fork if missing)
//   opencues-gemini-cli install
//   opencues-gemini-cli uninstall            # roll back to pre-install state
//
// Common flags:
//   --target <path>   Path to gemini-cli fork dir (default: $HOME/gemini-cli-cues)
//   --dry-run         Print the plan, don't execute
//   --help            Show usage
//
// Today this runs from a clone via `pnpm --filter @opencues/gemini-cli dev-install`.
// Post-publish (Stage 8) it becomes the bin entry for `npx @opencues/gemini-cli`.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

const HOME = os.homedir();
const DEFAULT_FORK = path.join(HOME, 'gemini-cli-cues');

// All paths relative to the gemini-cli fork dir. Single source of truth
// for blast radius — install + uninstall + dry-run all read from here.
function pathsForFork(fork) {
  const uiDir = path.join(fork, 'packages', 'cli', 'src', 'ui');
  return {
    // Whole-directory removals on uninstall.
    dirs: [
      path.join(fork, 'node_modules', '@opencues', 'core'),
      path.join(fork, 'node_modules', '@opencues', 'runtime'),
    ],
    // Files we copied in (single removal).
    files: [path.join(uiDir, 'opencues.ts')],
    // Files we patched in place (uninstall reverts via `git checkout --`
    // since the fork is a git repo).
    patched: [
      path.join(uiDir, 'AppContainer.tsx'),
      path.join(uiDir, 'components', 'InputPrompt.tsx'),
      path.join(uiDir, 'components', 'Footer.tsx'),
    ],
  };
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
    '  pnpm --filter @opencues/gemini-cli dev-install\n',
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
  const fork = args.target || DEFAULT_FORK;
  const paths = pathsForFork(fork);

  if (args.dryRun) {
    console.log('\n[dry-run] Would clone google-gemini/gemini-cli (if missing) at pinned SHA into target.');
    console.log('[dry-run] Would build @opencues/{core,runtime} via turbo.');
    console.log('[dry-run] Would install to:');
    for (const p of paths.dirs) console.log(`  ${p}/`);
    console.log('[dry-run] Would copy bootstrap to:');
    for (const p of paths.files) console.log(`  ${p}`);
    console.log('[dry-run] Would patch in place:');
    for (const p of paths.patched) console.log(`  ${p}`);
    return;
  }

  // Delegate to setup.sh. It owns its own progress output (▸/● lines)
  // + the final "Done. Launch with…" message.
  const setupSh = path.join(PKG_DIR, 'patches', 'setup.sh');
  const setupArgs = [fork];
  if (args.clean) setupArgs.push('--clean');
  const result = spawnSync(setupSh, setupArgs, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nInstall failed. To roll back: ${launchCommand()} uninstall gemini-cli`);
    process.exit(result.status || 1);
  }
  // Version marker for drift detection — non-fatal on write failure.
  try {
    const { writeMarker } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
    writeMarker('gemini-cli', path.join(fork, '.opencues'), { pkg, REPO_ROOT });
  } catch { /* non-fatal */ }
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  const fork = args.target || DEFAULT_FORK;
  if (!fs.existsSync(fork)) {
    console.log(`No gemini-cli fork at ${fork} — nothing to uninstall.`);
    return;
  }
  const paths = pathsForFork(fork);

  // Check the fork is a git repo (so we can revert patched files).
  const isGitRepo = fs.existsSync(path.join(fork, '.git'));

  const plan = {
    revert: paths.patched.filter(p => fs.existsSync(p)),
    rmFiles: paths.files.filter(p => fs.existsSync(p)),
    rmDirs: paths.dirs.filter(p => fs.existsSync(p)),
  };

  console.log(`Target gemini-cli fork: ${fork}`);
  console.log('Uninstall plan:');
  if (isGitRepo) {
    for (const p of plan.revert) console.log(`  git checkout -- ${path.relative(fork, p)}`);
  } else {
    console.log(`  WARNING: ${fork} is not a git repo — cannot revert patched files`);
    console.log(`           you'll need to restore them manually:`);
    for (const p of plan.revert) console.log(`             ${p}`);
  }
  for (const p of plan.rmFiles) console.log(`  rm ${p}`);
  for (const p of plan.rmDirs) console.log(`  rm -rf ${p}`);
  if (!plan.revert.length && !plan.rmFiles.length && !plan.rmDirs.length) {
    console.log('  (no installed paths found — appears clean)');
  }
  console.log(`\nNote: this leaves the gemini-cli fork itself in place. To remove it entirely:`);
  console.log(`  rm -rf ${fork}`);

  if (args.dryRun) {
    console.log('\n[dry-run] Nothing executed.');
    return;
  }

  console.log('');
  // 1. git checkout the patched files.
  if (isGitRepo) {
    for (const p of plan.revert) {
      const rel = path.relative(fork, p);
      const r = spawnSync('git', ['checkout', '--', rel], { cwd: fork, stdio: 'inherit' });
      if (r.status === 0) console.log(`  reverted ${rel}`);
      else console.warn(`  git checkout failed for ${rel} (exit ${r.status}); skipping`);
    }
  }
  // 2. Remove the bootstrap copy.
  for (const p of plan.rmFiles) {
    fs.rmSync(p, { force: true });
    console.log(`  removed ${p}`);
  }
  // 3. Remove our node_modules entries.
  for (const p of plan.rmDirs) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`  removed ${p}/`);
  }
  rmdirIfEmpty(path.join(fork, 'node_modules', '@opencues'));

  console.log(`\n${pkg.name} uninstall complete.`);
}

// --- SEED CONFIGS ---------------------------------------------------------

function doSeedConfigs() {
  const HOME = require('node:os').homedir();
  const userConfigDir = path.join(HOME, '.cues');
  const repoConfigDir = path.join(REPO_ROOT, 'defaults');
  const sources = ['cues', 'blanks'];

  console.log(`Seeding user-level configs to: ${userConfigDir}/`);
  console.log(`Sources: ${repoConfigDir}\n`);

  const seedPlan = sources.map(s => ({
    src: path.join(repoConfigDir, s),
    dst: path.join(userConfigDir, s),
    exists: fs.existsSync(path.join(userConfigDir, s)),
  }));

  console.log('Seed plan:');
  for (const e of seedPlan) {
    if (!fs.existsSync(e.src)) console.log(`  (no source) ${e.src}`);
    else if (e.exists) console.log(`  SKIP (target exists) ${e.dst}`);
    else console.log(`  COPY ${e.src} → ${e.dst}`);
  }
  if (args.dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }

  console.log('');
  fs.mkdirSync(userConfigDir, { recursive: true });
  let copied = 0, skipped = 0;
  for (const e of seedPlan) {
    if (!fs.existsSync(e.src)) continue;
    if (e.exists) { skipped++; continue; }
    if (fs.statSync(e.src).isDirectory()) copyDir(e.src, e.dst);
    else { fs.mkdirSync(path.dirname(e.dst), { recursive: true }); fs.copyFileSync(e.src, e.dst); }
    copied++;
    console.log(`  copied ${path.relative(REPO_ROOT, e.src)}`);
  }

  console.log(`\nSeeded ${copied} configs, skipped ${skipped} (already present).`);
  console.log('Edit any of these to change global defaults; hot-reload picks up on the next keystroke.');
  console.log('For project-specific overrides, create <project>/.cues/ in your project root.');
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

function rmdirIfEmpty(dir) {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* ignore */ }
}

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
    if (a === '--') continue; // pnpm/npm separator — skip silently
    if (a === '--help' || a === '-h') out.args.help = true;
    else if (a === '--dry-run') out.args.dryRun = true;
    else if (a === '--target') out.args.target = argv[++i];
    else if (a === '--clean') out.args.clean = true;
    else out.unknown.push(a);
  }
  return out;
}

function warnUnknownFlags(unknown) {
  if (!unknown.length) return;
  console.warn(`WARNING: ignoring unknown argument(s): ${unknown.join(' ')}`);
  console.warn(`Known commands: install, uninstall, help`);
  console.warn(`Known flags:    --target <path>, --dry-run, --help`);
  console.warn('');
}

function printBanner() {
  console.log(`${pkg.name} v${pkg.version}`);
}

function printHelp() {
  printBanner();
  console.log('');
  console.log('Commands:');
  console.log('  install (default)   Clone gemini-cli fork (if missing), build runtime, patch fork in place');
  console.log('  uninstall           git checkout the 3 patched files, rm bootstrap copy, rm node_modules entries');
  console.log('  seed-configs        Copy repo defaults to ~/.cues/ (skips files that exist)');
  console.log('  help                Show this message');
  console.log('');
  console.log('Flags:');
  console.log('  --target <path>     Path to gemini-cli fork (default: $HOME/gemini-cli-cues)');
  console.log('  --clean             Legacy alias — every install already runs from clean patched state (no-op)');
  console.log('  --dry-run           Print the plan; do not execute');
  console.log('  --help              Show this message');
  console.log('');
  console.log('Blast radius:');
  console.log('  Cloned (if missing):');
  console.log('    <fork>/  — full gemini-cli fork at pinned SHA');
  console.log('  Files installed inside the fork:');
  console.log('    <fork>/node_modules/@opencues/core/');
  console.log('    <fork>/node_modules/@opencues/runtime/');
  console.log('    <fork>/packages/cli/src/ui/opencues.ts  (bootstrap copy)');
  console.log('  Modified in place inside the fork (revertable via git checkout):');
  console.log('    <fork>/packages/cli/src/ui/AppContainer.tsx');
  console.log('    <fork>/packages/cli/src/ui/components/InputPrompt.tsx');
  console.log('    <fork>/packages/cli/src/ui/components/Footer.tsx');
  console.log('  Repo state (no host pollution):');
  console.log('    packages/*/dist/, .turbo/  (build cache, gitignored)');
}

function launchCommand() {
  const probe = spawnSync('command', ['-v', 'opencues'], { stdio: ['ignore', 'pipe', 'ignore'], shell: true });
  return probe.status === 0 ? 'opencues' : 'pnpm exec opencues';
}
