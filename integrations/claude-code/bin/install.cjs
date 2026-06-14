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
// Today this runs from a clone via `opencues install claude-code` (which
// itself resolves to `node integrations/claude-code/bin/install.cjs install`).
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

// Bundled-srcHash drift probe used by the no-op-if-healthy gate.
// Delegates to the canonical version-markers.cjs in opencues-cli.
// Returns { fresh: boolean, reason: string } — fresh: true when the
// install marker's srcHash matches the current source's srcHash (no
// rebuild needed); fresh: false when they differ (rebuild) or when
// no marker exists yet (treat as fresh — first install just wrote
// it). Errors swallowed silently and treated as fresh so a bad probe
// can't trigger spurious rebuilds.
function checkSrcHashDrift(markerDir) {
  try {
    const { checkDrift } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
    const drift = checkDrift(markerDir, { pkg, REPO_ROOT });
    if (drift.status === 'fresh' || drift.status === 'missing') {
      return { fresh: true, reason: drift.reason };
    }
    return { fresh: false, reason: drift.reason };
  } catch {
    // Couldn't compute drift (clone-side install with missing files,
    // post-publish path that has no source clone, etc.). Treat as
    // fresh — drift detection is best-effort.
    return { fresh: true, reason: 'probe-error' };
  }
}

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

// Skip the per-host banner when invoked as a sub-process from a
// higher-level command that already printed its own banner (e.g.
// `opencues update`). Avoids duplicate banners mid-stream.
if (process.env.OPENCUES_SKIP_BANNER !== '1') printBanner();

const isClone = fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'));
if (!isClone) {
  console.error(
    '\nPublished-package install path is not implemented yet (Stage 8 ships it).\n' +
    'For now, install from a clone:\n' +
    '  git clone https://github.com/opencues/opencues\n' +
    '  pnpm install\n' +
    '  pnpm exec opencues install claude-code\n',
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
  // Multi-fork model (June 2026). The canonical fork at
  // ~/claude-code-cues/ is the user-facing default — `opencues install
  // claude-code` always bootstraps + patches it. But if extra forks
  // exist on disk (e.g. ~/claude-code-cues-170/ — a dev fork pinned
  // to a specific CC version for version-bump testing, documented in
  // CLAUDE.md), we patch EVERY one in the same run.
  //
  // Why: PR #117 (June 2026) bumped @opencues/{runtime,core} versions.
  // Only the canonical fork got rebuilt; the -170 dev fork silently
  // kept running its hours-old stale bundle. Symptoms: no cues, no
  // blanks, no warning. The user's mental model — "I ran the
  // installer once, every fork on my disk is fresh" — was violated.
  // Fan-out makes that mental model actually hold.
  //
  // Explicit --target still does a single-fork install against the
  // named target; useful for CI / one-off targets outside ~/claude-
  // code-cues*. Pass --canonical-only to skip the fan-out without
  // pinning a target.
  let forks;
  if (args.target) {
    const target = args.target;
    const basename = path.basename(target);
    const shape = basename === 'cli.js' ? 'cli.js' : 'native';
    const root = basename === 'cli.js'
      ? path.resolve(path.dirname(target), '..', '..', '..')
      : path.resolve(path.dirname(target), '..', '..', '..', '..');
    forks = [{ root, target, shape }];
  } else {
    const canonicalRoot = path.join(HOME, 'claude-code-cues');
    ensureCanonicalForkExists(canonicalRoot);
    const canonical = inferForkShape(canonicalRoot);
    if (!canonical) {
      console.error(`Could not infer fork shape for ${canonicalRoot}.`);
      console.error('Expected one of:');
      console.error(`  ${canonicalRoot}/node_modules/@anthropic-ai/claude-code/cli.js`);
      console.error(`  ${canonicalRoot}/node_modules/@anthropic-ai/claude-code/bin/claude.exe`);
      console.error('Neither exists. Re-run install — setup.sh should npm-install the pinned CC version into the fork.');
      process.exit(2);
    }
    forks = [canonical];
    if (!args.canonicalOnly) {
      try {
        const { enumerateCCForks } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
        const allForks = enumerateCCForks();
        for (const f of allForks) {
          if (f.root !== canonical.root) forks.push(f);
        }
      } catch { /* enumeration failure → fall back to canonical-only, no fan-out */ }
    }
  }

  if (forks.length > 1) {
    console.log(`CC forks (${forks.length}):`);
    for (const f of forks) console.log(`  ▸ ${f.root}/  (${f.shape})`);
    console.log(`  ${'\x1b[2m'}Pass --canonical-only to skip extra-fork fan-out.${'\x1b[0m'}`);
  } else {
    console.log(`CC fork: ${forks[0].root}/  (${forks[0].shape})`);
  }
  console.log('');

  let anyInstalled = false;
  let anyFailed = false;
  for (const fork of forks) {
    // No-op-if-healthy gate. Per-fork. The nuke-and-rebuild work is
    // opt-in via --rebuild. validateFork checks every artefact
    // (runtime + core + statusline.sh + patched cli.js/native-extract
    // with opencues markers). If it passes, we ALSO compare the
    // install marker's srcHash to the current source hash — if they
    // differ, the bundle is stale and we rebuild. If both pass, skip
    // this fork.
    //
    // Why srcHash matters even when files exist (PR #48): self-heal
    // detected drift, called install, install short-circuited at
    // "already healthy" without updating the marker — `opencues run`
    // detected drift AGAIN, re-triggered install AGAIN, forever.
    // Closed loop only when install knows "healthy" means "marker
    // hash matches current source", not just "files present".
    if (!args.rebuild && !args.dryRun) {
      const validation = validateFork(fork);
      if (validation.ok) {
        const installRoot = fork.installRoot || path.join(fork.root, '.cues');
        const drift = checkSrcHashDrift(installRoot);
        if (drift.fresh) {
          console.log(`${'\x1b[32m✓\x1b[0m'} ${fork.root} already installed + healthy.`);
          // Don't double-print the --rebuild hint when fanning out;
          // it'd repeat per fork. Print once at the end.
          warnStaleClaudeCuesAlias(fork);
          continue;
        }
        console.log(`${'\x1b[33m▸\x1b[0m'} ${fork.root}: bundle stale (${drift.reason}). Rebuilding...`);
        console.log('');
      } else {
        console.log(`${'\x1b[33m▸\x1b[0m'} ${fork.root}: install state needs repair: ${validation.reason}`);
        console.log(`  ${'\x1b[2m'}Running full reinstall...${'\x1b[0m'}`);
        console.log('');
      }
    }

    checkCompat(fork.target);
    const result = installFork(fork);

    if (!result.ok) {
      console.error(`\n✗ ${fork.root} (${fork.shape}) — ${result.reason}`);
      anyFailed = true;
      // Continue to next fork instead of bailing — partial success
      // beats "first fork failed and the rest were skipped silently".
      continue;
    }
    console.log(`\n✓ ${fork.root} (${fork.shape}) installed + validated.`);
    anyInstalled = true;
    warnStaleClaudeCuesAlias(fork);
  }

  if (anyFailed) {
    if (anyInstalled) {
      console.error(`\nOne or more forks failed; others installed successfully. See per-fork output above.`);
    }
    process.exit(1);
  }

  if (!anyInstalled && forks.length > 0) {
    // Every fork was healthy + fresh — print the rebuild hint once.
    console.log(`  ${'\x1b[2m'}Pass${'\x1b[0m'} ${'\x1b[1m--rebuild\x1b[0m'} ${'\x1b[2m'}to force a nuke-and-reinstall from scratch.${'\x1b[0m'}`);
    return;
  }

  // Use the canonical/first fork for the post-install hints below.
  const fork = forks[0];

  // Print the opt-in hint for the statusline. We install statusline.sh
  // into the fork's .cues/ dir but do NOT auto-edit ~/.claude/settings.json
  // — that's CC's own dir, and writing to it without consent is
  // intrusive. Suggest the explicit command instead. Skipped silently
  // if the user already has our statusLine configured.
  try {
    const userSettings = path.join(HOME, '.claude', 'settings.json');
    if (fs.existsSync(userSettings)) {
      const data = JSON.parse(fs.readFileSync(userSettings, 'utf8'));
      const cmd = data?.statusLine?.command;
      if (typeof cmd === 'string' && (cmd.includes('claude-code-cues') || cmd.endsWith('/statusline.sh'))) {
        return; // already enabled
      }
    }
    const oc = launchCommand();
    console.log('');
    console.log(`Status line tip surface is opt-in — to enable it in Claude Code:`);
    console.log(`  ${oc} statusline enable             # writes ~/.claude/settings.json`);
    console.log(`  ${oc} statusline enable --project   # writes <cwd>/.claude/settings.json`);
  } catch { /* non-fatal — never block install on this hint */ }
}

// Bootstrap the canonical fork dir + package.json if either is missing.
// Pin defaults to whatever compat.json declares as current-pin. This is
// what removes the "package.json missing" first-time-user error.
function ensureCanonicalForkExists(forkRoot) {
  fs.mkdirSync(forkRoot, { recursive: true });
  const pkgPath = path.join(forkRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    const compat = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'compat.json'), 'utf8'));
    const pin = compat['current-pin'] || '2.1.170';
    fs.writeFileSync(pkgPath, JSON.stringify({
      private: true,
      dependencies: { '@anthropic-ai/claude-code': pin },
    }, null, 2) + '\n');
    console.log(`Bootstrapped ${pkgPath} with @anthropic-ai/claude-code@${pin}`);
  }
}

// Look inside a fork dir to figure out which shape's already there.
// Returns { root, target, shape } or null if neither artefact exists.
// (setup.sh will npm-install on first run; this is for the case where
// install completed once and we're re-running.)
function inferForkShape(root) {
  const cliJs = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const nativeBin = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (fs.existsSync(cliJs)) return { root, target: cliJs, shape: 'cli.js' };
  if (fs.existsSync(nativeBin)) return { root, target: nativeBin, shape: 'native' };
  // First-time install: artefacts don't exist yet. Infer from the
  // pin in package.json — versions ≤ 2.1.111 are cli.js shape, ≥ 2.1.113
  // are native. setup.sh's npm install will create whichever; we just
  // need to give it the right target path.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const pin = pkg.dependencies?.['@anthropic-ai/claude-code'] || '';
    const m = pin.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (m) {
      const patch = parseInt(m[3], 10);
      if (m[1] === '2' && m[2] === '1' && patch <= 111) {
        return { root, target: cliJs, shape: 'cli.js' };
      }
      // 2.1.113+ (and any future major) → native binary.
      return { root, target: nativeBin, shape: 'native' };
    }
  } catch { /* fall through */ }
  return null;
}

// Run setup.sh against a single fork + validate the result. Pulled out
// of doInstall so the dry-run / multi-fork paths share the same code.
function installFork(fork) {
  const installRoot = path.join(fork.root, '.cues');
  const tweakccConfigDir = path.join(installRoot, 'patch-state');
  const legacy = legacyPaths();

  console.log(`\n▸ ${fork.root} (${fork.shape})`);

  if (args.dryRun) {
    console.log(`  [dry-run] Would install into ${installRoot}/ + node_modules/@opencues/`);
    console.log(`  [dry-run] Would patch ${fork.target} (${fork.shape})`);
    console.log(`  [dry-run] cli.js backup → ${tweakccConfigDir}/cli.js.backup`);
    return { ok: true };
  }

  // Delegate to setup.sh — strictly CC-specific work (cli.js patching,
  // statusline install, tweakcc build/apply, settings.json fixup).
  // Pass through --keep-state for dev iteration.
  const setupSh = path.join(PKG_DIR, 'patches', 'setup.sh');
  const setupArgs = [];
  if (args.keepState) setupArgs.push('--keep-state');
  const env = { ...process.env, OPENCUES_CC_TARGET: fork.target };
  const result = spawnSync(setupSh, setupArgs, { stdio: 'inherit', env });

  if (result.status === 2) {
    return { ok: false, reason: 'setup.sh exited 2 (no cli.js to patch — fork state invalid?)' };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `setup.sh exited ${result.status}` };
  }

  // setup.sh claimed success — VALIDATE the artefacts actually landed.
  // This catches the silent-failure mode where tweakcc reports
  // success but the patched-artifact verification was skipped.
  const validation = validateFork(fork);
  if (!validation.ok) {
    return { ok: false, reason: `validation failed: ${validation.reason}` };
  }

  // Write the version marker AFTER setup.sh + validation succeeded.
  // Doctor + `opencues update` use this to detect bundled-runtime drift.
  try {
    const { writeMarker } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
    writeMarker('claude-code', installRoot, { pkg, REPO_ROOT });
  } catch { /* non-fatal */ }

  return { ok: true };
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

  // Detect whether ~/.claude/settings.json's statusLine.command points
  // at our script — if so, uninstall removes it. This is the symmetric
  // counterpart to `opencues statusline enable` (we never write to
  // settings.json from install, but a user who explicitly enabled the
  // statusline expects uninstall to put the slot back).
  // Project-level settings.json (<cwd>/.claude/settings.json) is NOT
  // touched here — uninstall is host-scoped, project-scoped statusline
  // cleanup is `opencues statusline disable --project`.
  const settingsJsonPath = path.join(CLAUDE_DIR, 'settings.json');
  const statuslineToRevert = detectOpenCuesStatusLine(settingsJsonPath);

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
  if (statuslineToRevert) {
    console.log(`  edit ${settingsJsonPath}  (clear statusLine.command — currently: ${statuslineToRevert})`);
  }
  if (!rootExists && !inForkExists && !legacyToRemove.length && !statuslineToRevert) {
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

  // 4. Revert settings.json's statusLine if we configured it.
  if (statuslineToRevert) {
    try {
      const data = JSON.parse(fs.readFileSync(settingsJsonPath, 'utf8'));
      // Sanity: only delete if it's STILL our path (user might have
      // edited between plan-print and execute).
      if (data.statusLine && data.statusLine.command === statuslineToRevert) {
        fs.copyFileSync(settingsJsonPath, settingsJsonPath + '.bak.cues-uninstall');
        delete data.statusLine;
        fs.writeFileSync(settingsJsonPath, JSON.stringify(data, null, 2) + '\n');
        console.log(`  cleared statusLine from ${settingsJsonPath}`);
      }
    } catch (err) {
      console.warn(`  could not revert ${settingsJsonPath}: ${err.message}`);
    }
  }

  console.log(`\n${pkg.name} uninstall complete.`);
  console.log('To fully remove the cloned repo: rm -rf <opencues-clone-dir>');
}

// Read ~/.claude/settings.json and return the opencues statusLine
// command if that's currently configured. Returns null if no
// settings.json, no statusLine, or the command isn't ours.
function detectOpenCuesStatusLine(settingsFile) {
  if (!fs.existsSync(settingsFile)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch { return null; }
  const cmd = data?.statusLine?.command;
  if (typeof cmd !== 'string') return null;
  const isOurs = cmd.includes('claude-code-cues') ||
                 cmd.includes('claude-code-cues-150') ||
                 cmd.includes('.claude/highlight-statusline.sh') ||
                 cmd.includes('.claude/opencues/statusline.sh') ||
                 (cmd.endsWith('/statusline.sh') && cmd.includes('/.cues/'));
  return isOurs ? cmd : null;
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

// Single-target detection — back-compat for uninstall (which only ever
// touched one fork at a time). For install, prefer detectAllForks().
function tryAutoDetectCli() {
  // Common locations. Order: standard npm install → claude-cues local install.
  const candidates = [
    path.join(CLAUDE_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(HOME, 'claude-code-cues', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(HOME, 'claude-code-cues-150', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// Multi-fork detection. Returns every CC fork on disk that's a viable
// install target. Returns [{root, target, shape: 'cli.js' | 'native'}].
//
// Why this matters: prior to today, install.cjs only patched whichever
// single fork tryAutoDetectCli() returned first. Users running both the
// canonical fork AND a versioned dev fork (e.g. `~/claude-code-cues-150/`)
// would re-run install thinking it'd update both — silently the dev fork
// stayed unpatched. (Documented in CLAUDE.md root § Claude Installs.)
// Now install enumerates every fork + patches each in turn.
//
// Lookup order:
//   1. Standard `~/.claude/node_modules/...` (rare — pre-fork-era layout)
//   2. `~/claude-code-cues/` (canonical fork; shape auto-detected — today's
//      pin in compat.json:current-pin is 2.1.170 native bun-binary, older
//      pins fell on the cli.js shape)
//   3. Any other `~/claude-code-cues-*/` (user-named version-test forks
//      — see CLAUDE.md § Claude Installs for the dev-fork retirement note)
//
// An explicit --target overrides the auto-detection — single-fork mode.
function detectAllForks() {
  const out = [];
  const seen = new Set();

  // (1) Pre-fork legacy.
  const legacyCli = path.join(CLAUDE_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (fs.existsSync(legacyCli)) {
    const root = path.resolve(path.dirname(legacyCli), '..', '..', '..');
    if (!seen.has(root)) { out.push({ root, target: legacyCli, shape: 'cli.js' }); seen.add(root); }
  }

  // (2) + (3) + (4): walk ~/claude-code-cues* dirs. Each one has either
  // a cli.js or a bin/claude.exe in its node_modules.
  try {
    for (const entry of fs.readdirSync(HOME, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('claude-code-cues')) continue;
      const root = path.join(HOME, entry.name);
      if (seen.has(root)) continue;
      const cliJs = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      const nativeBin = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(cliJs)) {
        out.push({ root, target: cliJs, shape: 'cli.js' });
        seen.add(root);
      } else if (fs.existsSync(nativeBin)) {
        out.push({ root, target: nativeBin, shape: 'native' });
        seen.add(root);
      }
      // If neither exists, this is an empty fork dir (e.g. user created
      // it but never ran install). Skip — setup.sh would fail anyway.
    }
  } catch { /* HOME unreadable — extremely unlikely; fall through */ }

  return out;
}

// Verify a patched fork actually has the OpenCues v2 wiring landed.
// Returns { ok, reason }. Called after each setup.sh run so we can
// surface partial-install failures loud (versus the prior silent
// "claimed success, half-patched" failure mode).
//
// IMPORTANT: detect the CURRENT shape from what's on disk right now
// rather than trusting the `fork.shape` snapshot from before install.
// An upgrade that crosses the 2.1.111 → 2.1.113 cutover (cli.js ↔
// native binary) makes the pre-install shape stale by the time
// validation runs — the artefact files have moved. Re-detecting here
// lets a single install handle in-place shape transitions cleanly.
function validateFork(fork) {
  const installRoot = path.join(fork.root, '.cues');
  const runtime = path.join(fork.root, 'node_modules', '@opencues', 'runtime');
  const core = path.join(fork.root, 'node_modules', '@opencues', 'core');
  const statusline = path.join(installRoot, 'statusline.sh');

  if (!fs.existsSync(runtime)) return { ok: false, reason: `runtime missing at ${runtime}` };
  if (!fs.existsSync(core))    return { ok: false, reason: `core missing at ${core}` };
  if (!fs.existsSync(statusline)) return { ok: false, reason: `statusline.sh missing at ${statusline}` };

  // Re-detect shape from what's actually on disk now.
  const cliJs     = path.join(fork.root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const nativeBin = path.join(fork.root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const liveShape = fs.existsSync(nativeBin) ? 'native'
                  : fs.existsSync(cliJs)     ? 'cli.js'
                  : null;
  if (!liveShape) {
    return { ok: false, reason: `neither cli.js nor bin/claude.exe present in ${path.dirname(cliJs)} — npm install may not have completed` };
  }

  // Patched-artefact validation differs by shape:
  //   - cli.js shape: cli.js is text-patched in place; grep for @opencues/runtime.
  //   - native shape: tweakcc extracts cli.js from the ELF .bun
  //     section, patches it, repacks, AND writes the post-patch text
  //     to <installRoot>/patch-state/native-claudejs-patched.js for
  //     verification (the bun section itself isn't ASCII-greppable
  //     because it's compressed).
  if (liveShape === 'cli.js') {
    try {
      const text = fs.readFileSync(cliJs, 'utf8');
      if (!text.includes('@opencues/runtime') && !text.includes('startOpenCues')) {
        return { ok: false, reason: `cli.js exists but missing opencues markers` };
      }
    } catch (err) {
      return { ok: false, reason: `cli.js unreadable: ${err.message}` };
    }
  } else {
    const verifiedExtract = path.join(installRoot, 'patch-state', 'native-claudejs-patched.js');
    if (!fs.existsSync(verifiedExtract)) {
      return { ok: false, reason: `tweakcc post-patch extract missing at ${verifiedExtract} — tweakcc never ran or didn't extract` };
    }
    try {
      const text = fs.readFileSync(verifiedExtract, 'utf8');
      if (!text.includes('@opencues/runtime') && !text.includes('startOpenCues')) {
        return { ok: false, reason: `post-patch extract exists but missing opencues markers` };
      }
    } catch (err) {
      return { ok: false, reason: `post-patch extract unreadable: ${err.message}` };
    }
  }

  // Update caller's view so success log + version marker match reality.
  fork.shape = liveShape;
  fork.target = liveShape === 'cli.js' ? cliJs : nativeBin;

  // Boot-smoke: actually `require` the runtime + the exact paths the
  // patch's bootstrap pulls. Catches the bug class where files exist
  // on disk + tweakcc markers are present but a transitive require
  // chain resolves to a missing file — symptom on the user:
  // claude-cues launches, types nothing happens, /tmp/opencues.log
  // stays untouched. Patch's outer try/catch swallows the failure
  // silently.
  //
  // Concrete instance the smoke catches (June 2026 PR #117 regression):
  // setup.sh hard-coded the dist subdirs it copied ("sources" only),
  // missing the new "providers" subdir. `@opencues/core/model-aliases`
  // require'd `./providers/claude-cli-daemon` — boot threw at the
  // outer try, every CC session came up with __oc.failed=true.
  // Markers were present, validateFork was happy, the user got silent
  // breakage. The fix: install.cjs now refuses to ship a fork whose
  // bundled runtime can't load.
  //
  // Probe paths mirror EXACTLY the specifier list the patch emits in
  // `opencuesRuntime.ts` (every `const xxxPath = "@opencues/runtime/..."`
  // line). Keep in sync — when the patch starts requiring a new
  // submodule, append it here so a new install can't silently ship a
  // broken bundle.
  const smokeProbes = [
    '@opencues/runtime',
    '@opencues/runtime/dist/adapters/cc/v2.1/boot.js',
    '@opencues/runtime/dist/src/blanks/index.js',
    '@opencues/runtime/dist/src/security/spawn-sandbox.js',
    '@opencues/runtime/dist/src/security/sandbox-runner.js',
    '@opencues/runtime/dist/src/user-blanks/registry.js',
  ];
  for (const spec of smokeProbes) {
    const probe = spawnSync(process.execPath, [
      '-e', `require(${JSON.stringify(spec)})`,
    ], { cwd: fork.root, env: process.env });
    if (probe.status !== 0) {
      const stderr = (probe.stderr || '').toString().split('\n').slice(0, 4).join('\n');
      return {
        ok: false,
        reason: `boot-smoke FAILED for require(${JSON.stringify(spec)}) from ${fork.root} — installed bundle is broken. ` +
                `setup.sh's copy step probably missed a new dist subdir; the recursive copy in setup.sh § 5 should cover ` +
                `every dist/*/ subdir.\n  ${stderr.replace(/\n/g, '\n  ')}`,
      };
    }
  }
  return { ok: true };
}

// Best-effort stale-alias detector. Greps the common shell rc files
// (~/.bashrc, ~/.zshrc, ~/.bash_aliases, ~/.config/fish/config.fish)
// for an `alias claude-cues=…` line that points at a cli.js path. If
// we installed a native-binary shape, the cli.js path is dead and
// running `claude-cues` after upgrade fails with "Cannot find
// module". Print one info block with the correct line + the file
// they need to edit. No write — that's invasive.
function warnStaleClaudeCuesAlias(fork) {
  if (fork.shape !== 'native') return; // cli.js fork — old alias still works
  const candidates = [
    path.join(HOME, '.bashrc'),
    path.join(HOME, '.zshrc'),
    path.join(HOME, '.bash_aliases'),
    path.join(HOME, '.config', 'fish', 'config.fish'),
  ];
  const stale = [];
  // Match: alias claude-cues=… that mentions cli.js. Allows quotes +
  // bash/zsh/fish variants. Doesn't match an alias pointing at
  // bin/claude.exe (already correct).
  const re = /alias\s+claude-cues\s*[= ].*cli\.js/;
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) stale.push({ file: f, lineNo: i + 1, line: lines[i].trim() });
      }
    } catch { /* fail-silent */ }
  }
  if (stale.length === 0) return;
  const correct = `alias claude-cues='${path.join(fork.root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')}'`;
  console.log('');
  console.log('\x1b[33mNote:\x1b[0m your shell config has a `claude-cues` alias pointing at the pre-2.1.113 cli.js path,');
  console.log('which no longer exists after the upgrade to a native-binary CC version. Update it to:');
  console.log('');
  console.log(`  ${correct}`);
  console.log('');
  console.log('Detected stale alias in:');
  for (const s of stale) {
    console.log(`  ${s.file}:${s.lineNo}`);
    console.log(`    \x1b[2m${s.line}\x1b[0m`);
  }
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
  const KNOWN_FLAGS = new Set(['--help', '-h', '--target', '--dry-run', '--clean', '--keep-state', '--rebuild', '--canonical-only']);
  const VALUE_FLAGS = new Set(['--target']);
  const KNOWN_COMMANDS = new Set(['install', 'uninstall', 'seed-configs', 'help']);
  const out = { command: 'install', args: { help: false, dryRun: false, clean: false, keepState: false, rebuild: false, canonicalOnly: false }, unknown: [] };
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
    else if (a === '--rebuild') out.args.rebuild = true;
    else if (a === '--canonical-only') out.args.canonicalOnly = true;
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
  console.log('    /tmp/opencues-status-<pid>.json');
  console.log('    /tmp/opencues-cursor-state-<pid>.json');
}

// Prefer the short "opencues" form when the binary is on PATH; fall back
// to the always-works-from-a-clone form. Used in user-facing hint messages.
function launchCommand() {
  const probe = spawnSync('command', ['-v', 'opencues'], { stdio: ['ignore', 'pipe', 'ignore'], shell: true });
  return probe.status === 0 ? 'opencues' : 'pnpm exec opencues';
}
