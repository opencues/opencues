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
  // Vendored bun (~/.opencues/vendor/bun/bin/) is acceptable too —
  // the top-level `opencues install` preflight either installs it
  // (with consent) or prompts the user to. PATH was prepended by the
  // parent process; we also accept the vendored path directly.
  const HOME_DIR = require('os').homedir();
  const vendoredBun = path.join(HOME_DIR, '.opencues', 'vendor', 'bun', 'bin', 'bun');
  const bunCheck = spawnSync('which', ['bun'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (bunCheck.status !== 0 && !fs.existsSync(vendoredBun)) {
    const msg = args.dryRun
      ? '\nWARNING: bun is not on PATH. A real install would fail here — the terminal app is a Bun app.'
      : '\nERROR: bun is not on PATH. The terminal app is a Bun + OpenTUI app, so install cannot proceed.';
    console.error(msg);
    console.error('Install bun:');
    console.error('  Contained (preferred):  opencues install shell  → say Y to the bun prompt');
    console.error('  System:                 curl -fsSL https://bun.sh/install | bash');
    if (!args.dryRun) process.exit(127);
  }
  if (fs.existsSync(vendoredBun)) {
    const vendoredBin = path.dirname(vendoredBun);
    if (!process.env.PATH || !process.env.PATH.split(path.delimiter).includes(vendoredBin)) {
      process.env.PATH = vendoredBin + path.delimiter + (process.env.PATH || '');
    }
  }

  const vendoredTmux = path.join(require('os').homedir(), '.opencues', 'vendor', 'tmux', 'bin', 'tmux');
  const hasTmux =
    fs.existsSync(vendoredTmux) ||
    spawnSync('which', ['tmux'], { stdio: ['ignore', 'pipe', 'ignore'] }).status === 0;
  if (!hasTmux) {
    console.error('\nNOTE: tmux is not installed. oc-shell requires tmux >= 3.2.');
    console.error('  macOS:         brew install tmux');
    console.error('  Debian/Ubuntu: sudo apt install tmux');
    console.error('  Fedora:        sudo dnf install tmux');
    console.error('  Arch:          sudo pacman -S tmux');
    console.error('After installing, run oc-install-tmux to build a private copy for oc-shell,');
    console.error('or set OPENCUES_TMUX=/path/to/tmux to use your system tmux directly.');
    console.error('');
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
  // Version marker for drift detection (shell is self-owned — marker
  // lands in node_modules/@opencues alongside the staged runtime).
  try {
    const { writeMarker } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
    writeMarker('shell', path.join(PKG_DIR, 'node_modules', '@opencues'), { pkg, REPO_ROOT });
  } catch { /* non-fatal */ }

  // Auto-run oc-install-tmux when needed so the user doesn't have to
  // remember a second command. Three exit paths from here:
  //   1. tmux >= 3.2 already on PATH → skip; oc-shell will use it via
  //      its OPENCUES_TMUX / vendored / PATH resolution chain.
  //   2. ~/.opencues/vendor/tmux/bin/tmux already exists → skip.
  //   3. Neither → run oc-install-tmux. It tries the prebuilt-tarball
  //      path first, falls through to source build if 404. Source build
  //      may fail if the C-toolchain isn't installed — at that point
  //      oc-install-tmux prints platform-specific apt/brew commands.
  if (!hasUsableTmux()) {
    console.log('');
    console.log('▸ Setting up tmux for oc-shell (one-time)…');
    const tmuxInstaller = path.join(PKG_DIR, 'bin', 'oc-install-tmux');
    const tmuxResult = spawnSync('bash', [tmuxInstaller], { stdio: 'inherit' });
    if (tmuxResult.status !== 0) {
      console.log('');
      console.log('  oc-install-tmux didn\'t complete. oc-shell needs tmux 3.2+ to launch.');
      console.log('  Options: (a) install via your package manager (apt/brew install tmux), then re-run');
      console.log('           (b) install the build-time deps shown above + re-run');
      console.log('           (c) point at an existing tmux: OPENCUES_TMUX=/path/to/tmux oc-shell');
      // Non-fatal — the rest of the install succeeded; tmux is per-launch.
    }
  }
}

// Probe for a usable tmux. Returns true if either:
//   - tmux >=3.2 is on PATH, OR
//   - the vendored ~/.opencues/vendor/tmux/bin/tmux exists (oc-shell
//     prefers it via its resolution chain).
function hasUsableTmux() {
  const HOME_DIR = require('os').homedir();
  const vendored = path.join(HOME_DIR, '.opencues', 'vendor', 'tmux', 'bin', 'tmux');
  if (fs.existsSync(vendored)) return true;
  try {
    const out = require('child_process').execSync('tmux -V 2>/dev/null', { encoding: 'utf8' });
    const m = out.match(/tmux (\d+)\.(\d+)/);
    if (!m) return false;
    const maj = parseInt(m[1], 10), min = parseInt(m[2], 10);
    return maj > 3 || (maj === 3 && min >= 2);
  } catch { return false; }
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  // Shell uninstall mirrors install exactly — every artifact we own goes:
  //   1. Staged @opencues/{core,runtime} in this package's node_modules
  //   2. Symlinks created by --link
  //   3. ~/.opencues/vendor/  (vendored tmux + build src + logs)
  //         — installed by `oc-install-tmux`
  //   4. ~/.opencues/shell-integration.{bash,zsh,fish}
  //         — installed by `oc-install-shell-integration`
  //   5. The marked source line in ~/.bashrc / ~/.zshrc / fish config
  //         — installed by `oc-install-shell-integration`
  //   6. ~/.opencues/ itself if it's now empty
  //
  // The user can opt out of 3-5 with --keep-vendor (preserves the
  // vendored tmux + integration snippets + rc edit).
  // Items 1-2 are always removed (they live inside our package dir).
  //
  // NEVER touch ~/.cues/ — those are user configs, by design surviving
  // every uninstall.
  const HOME_DIR = require('os').homedir();
  const OC_DIR = path.join(HOME_DIR, '.opencues');
  const stagedCore = path.join(PKG_DIR, 'node_modules', '@opencues', 'core');
  const stagedRt = path.join(PKG_DIR, 'node_modules', '@opencues', 'runtime');
  const linkPaths = args.link
    ? ['oc-shell', 'oc-install-tmux', 'oc-install-shell-integration'].map((b) => path.join(args.link, b))
    : [];

  const vendorDir = path.join(OC_DIR, 'vendor');
  const snippets = [
    path.join(OC_DIR, 'shell-integration.bash'),
    path.join(OC_DIR, 'shell-integration.zsh'),
    path.join(OC_DIR, 'shell-integration.fish'),
  ].filter(p => fs.existsSync(p));
  const rcFiles = [
    path.join(HOME_DIR, '.bashrc'),
    path.join(HOME_DIR, '.zshrc'),
    path.join(HOME_DIR, '.config', 'fish', 'config.fish'),
  ];
  const RC_MARKER = '# OpenCues shell-integration (managed by oc-install-shell-integration)';
  const rcEdits = rcFiles
    .filter(p => fs.existsSync(p))
    .map(p => ({ path: p, hasMarker: fs.readFileSync(p, 'utf8').includes(RC_MARKER) }))
    .filter(e => e.hasMarker);

  // Build the plan deterministically so --dry-run matches reality.
  const plan = [];
  for (const p of [stagedCore, stagedRt]) {
    if (fs.existsSync(p)) plan.push({ kind: 'rmdir', path: p });
  }
  for (const linkPath of linkPaths) {
    try { if (fs.lstatSync(linkPath).isSymbolicLink()) plan.push({ kind: 'unlink', path: linkPath }); }
    catch { /* not present */ }
  }
  if (!args.keepVendor) {
    if (fs.existsSync(vendorDir)) plan.push({ kind: 'rmdir', path: vendorDir, label: 'vendored tmux + build dir' });
    for (const s of snippets) plan.push({ kind: 'rm', path: s, label: 'shell-integration snippet' });
    for (const e of rcEdits) plan.push({ kind: 'rc-strip', path: e.path, label: `strip OpenCues source line from ${path.basename(e.path)}` });
  }

  console.log('Uninstall plan:');
  if (plan.length === 0) {
    console.log('  (nothing to remove — appears clean)');
  } else {
    for (const step of plan) {
      const suffix = step.label ? `   ${dim(step.label)}` : '';
      if (step.kind === 'rmdir') console.log(`  rm -rf ${step.path}${suffix}`);
      else if (step.kind === 'unlink') console.log(`  rm ${step.path}${suffix}`);
      else if (step.kind === 'rm') console.log(`  rm ${step.path}${suffix}`);
      else if (step.kind === 'rc-strip') console.log(`  edit ${step.path}${suffix}`);
    }
  }
  if (args.keepVendor) {
    console.log(`  ${dim('--keep-vendor: leaving ~/.opencues/vendor/ + shell-integration snippets + rc edits in place')}`);
  }

  if (args.dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }

  for (const step of plan) {
    try {
      if (step.kind === 'rmdir') { fs.rmSync(step.path, { recursive: true, force: true }); console.log(`  removed ${step.path}/`); }
      else if (step.kind === 'unlink' || step.kind === 'rm') { fs.unlinkSync(step.path); console.log(`  removed ${step.path}`); }
      else if (step.kind === 'rc-strip') { stripOpenCuesSourceLine(step.path, RC_MARKER); console.log(`  stripped ${step.path}`); }
    } catch (err) {
      console.warn(`  WARN: failed ${step.kind} ${step.path}: ${err.message}`);
    }
  }

  // Try to rmdir ~/.opencues if it's empty now. If it has anything left
  // (e.g. third-party tooling, or --keep-vendor preserved files), leave
  // it alone. We never recursively delete it — too easy to torch state
  // the user wanted to keep.
  try {
    if (fs.existsSync(OC_DIR) && fs.readdirSync(OC_DIR).length === 0) {
      fs.rmdirSync(OC_DIR);
      console.log(`  removed empty ${OC_DIR}/`);
    }
  } catch { /* ignore */ }

  console.log(`\n${pkg.name} uninstall complete.`);
}

// Dim helper — minimal local copy so we don't need the CLI's style.cjs here.
function dim(s) { return `\x1b[2m${s}\x1b[22m`; }

// Strip the marker-tagged OpenCues source line from an rc file.
// Preserves every other line. The marker is appended to the line itself
// (as a trailing comment) by oc-install-shell-integration, so a simple
// line-by-line filter is sufficient. Also drops a single blank line
// immediately preceding the OpenCues line if present (oc-install-shell-
// integration writes one) so the file doesn't grow whitespace on each
// install/uninstall cycle.
function stripOpenCuesSourceLine(rcPath, marker) {
  const text = fs.readFileSync(rcPath, 'utf8');
  const lines = text.split('\n');
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(marker)) {
      // If the previous kept line is empty and the line before THAT
      // isn't also empty, the empty line was probably the spacer we
      // wrote. Drop it.
      if (keep.length >= 1 && keep[keep.length - 1] === '' &&
          (keep.length < 2 || keep[keep.length - 2] !== '')) {
        keep.pop();
      }
      continue;
    }
    keep.push(lines[i]);
  }
  fs.writeFileSync(rcPath, keep.join('\n'));
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
  const out = { command: 'install', args: { help: false, dryRun: false, link: null, keepVendor: false }, unknown: [] };
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
    else if (a === '--keep-vendor') out.args.keepVendor = true;
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
  console.log('  --keep-vendor       Uninstall: preserve ~/.opencues/vendor/ (tmux + shell-integration snippets + rc edits)');
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
