// Version markers — one tiny JSON file per integration recording the
// CLI version + runtime version + core version that landed at install.
//
// Why: the May 2026 dual-CC-fork bug was source-has-fix, bundle-doesn't.
// Source builds → fork A re-installed → fork B forgotten. Each fork's
// bundled @opencues/{core,runtime} stays at the prior version forever
// until someone explicitly re-runs the host installer.
//
// Marker files let doctor cross-check what's deployed vs the current
// source build, and let `opencues update` enumerate every fork that
// needs a refresh.
//
// Marker location: each integration's "install root" — the place the
// integration owns. CC writes to <fork>/.cues/version.json. OC and
// gemini write to their fork dirs. Shell writes to integrations/shell
// node_modules. Chrome writes to its dist dir.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { resolveForkDir, supportDir, forkDir, enumerateForkDirs } = require('./fork-paths.cjs');

const FILENAME = 'version.json';

// Source dirs whose content is bundled into every fork's
// node_modules/@opencues/{core,runtime} at install time. The marker
// includes a content hash of EVERY file under these dirs so a source
// edit lands a different srcHash even if the developer forgets to
// bump runtime/core's package.json version. Drift detection at
// `opencues run <host>` then catches it and rebuilds transparently.
//
// Adding a third bundled package later (e.g. `@opencues/auditors`)
// → append the src dir here. Anything outside this list won't be
// covered by hash-based drift (e.g. CLI changes only affect the CLI
// binary, not the bundled fork runtime).
const BUNDLED_SOURCE_DIRS = [
  'packages/opencues-runtime/src',
  'packages/opencues-core/src',
  'packages/opencues-core/node-http-adapter.js', // package-root file, not under src/
];

/**
 * Compute a deterministic SHA-256 of every file under BUNDLED_SOURCE_DIRS.
 * Returns a short hex prefix (16 chars) suitable for embedding in
 * the marker. Returns null when the source tree can't be walked
 * (published-CLI path with no workspace clone).
 *
 * Why a hash instead of relying purely on `package.json` version:
 * developers forget to bump. The May 2026 sentinel-rename + nav-
 * keymap PRs landed source changes without touching package.json's
 * version — drift detection that depended only on the string would
 * be blind. The hash is structurally tamper-evident: any source byte
 * change → different hash → forks self-heal on next launch.
 *
 * Tradeoff: ~200ms walk + hash on a warm cache for the current
 * source tree. Acceptable for an `opencues run` startup probe; we
 * already pay more in banner dwell time.
 */
function computeSourceHash(repoRoot) {
  try {
    const hash = crypto.createHash('sha256');
    const files = [];
    for (const rel of BUNDLED_SOURCE_DIRS) {
      const abs = path.join(repoRoot, rel);
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) walkFiles(abs, files);
      else files.push(abs);
    }
    if (files.length === 0) return null;
    files.sort(); // deterministic order — different fs traversal orders mustn't change the hash
    for (const f of files) {
      // Relative path keeps the hash stable across machines + workspace
      // moves. Don't include absolute paths or mtimes.
      const rel = path.relative(repoRoot, f);
      hash.update(rel);
      hash.update('\0'); // separator so file boundaries can't collide with content
      hash.update(fs.readFileSync(f));
      hash.update('\0');
    }
    return hash.digest('hex').slice(0, 16);
  } catch { return null; }
}

function walkFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Skip nested build output / nested workspace deps — these aren't
      // bundled into the fork, so they shouldn't affect drift detection.
      if (e.name === 'dist' || e.name === 'node_modules' || e.name === '.cache') continue;
      walkFiles(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
}

// Get the source-built runtime version. Read from the canonical
// package.json (workspace clone). Falls back to null if we can't find it
// (published-CLI path doesn't have a clone; relies on the marker being
// "what we shipped" without a source comparison).
function getSourceVersions(repoRoot) {
  const runtimePkg = path.join(repoRoot, 'packages/opencues-runtime/package.json');
  const corePkg = path.join(repoRoot, 'packages/opencues-core/package.json');
  return {
    runtime: readPkgVersion(runtimePkg),
    core: readPkgVersion(corePkg),
  };
}

function readPkgVersion(pkgPath) {
  try { return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; }
  catch { return null; }
}

// Write a marker file at the integration's install root.
//   host: 'claude-code' | 'opencode' | 'gemini-cli' | 'shell' | 'chrome'
//   markerDir: absolute path to where the marker lives (e.g. <fork>/.cues/)
//   ctx: { pkg, REPO_ROOT } from the CLI
function writeMarker(host, markerDir, ctx) {
  const versions = getSourceVersions(ctx.REPO_ROOT);
  const data = {
    host,
    cli: ctx.pkg?.version || null,
    runtime: versions.runtime,
    core: versions.core,
    // Hash of the bundled source tree at install time. The
    // load-bearing field for self-healing on `opencues run`: any
    // src/** edit changes this even when developers forget to bump
    // package.json. Null = couldn't read source (published-CLI path
    // without a clone); drift detection falls back to version strings.
    srcHash: computeSourceHash(ctx.REPO_ROOT),
    repoRoot: ctx.REPO_ROOT || null,
    installedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, FILENAME), JSON.stringify(data, null, 2) + '\n');
    return data;
  } catch (err) {
    // Marker write failure is not a fatal install error — the install
    // itself completed; we just lose drift detection on this host. Log
    // and continue.
    return null;
  }
}

// Read the marker file. Returns null if not present / corrupt.
function readMarker(markerDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(markerDir, FILENAME), 'utf8'));
  } catch { return null; }
}

// Compare a marker against the current source build. Returns:
//   { status: 'fresh' | 'stale' | 'missing', marker, source, reason }
// `fresh`:   marker matches source on srcHash (or, when srcHash isn't
//            available, on runtime + core versions).
// `stale`:   marker exists but EITHER srcHash differs OR a version
//            string differs. `reason` explains which check fired
//            ('srcHash' | 'runtime' | 'core') — surfaced to the user
//            in the "rebuilding bundle" line so drift root-cause is
//            never opaque.
// `missing`: no marker (host installed pre-marker era, or marker
//            write failed).
//
// srcHash takes precedence over version strings because it's
// load-bearing: a developer forgetting to bump version.json doesn't
// mask a real source change. The version checks remain as a
// secondary signal for the published-CLI path where source isn't
// readable (srcHash is null on both sides).
function checkDrift(markerDir, ctx) {
  const marker = readMarker(markerDir);
  const source = getSourceVersions(ctx.REPO_ROOT);
  const sourceHash = computeSourceHash(ctx.REPO_ROOT);
  if (!marker) return { status: 'missing', marker: null, source, sourceHash, reason: 'no-marker' };
  if (sourceHash && marker.srcHash && marker.srcHash !== sourceHash) {
    return { status: 'stale', marker, source, sourceHash, reason: 'srcHash', downgrade: markerIsNewer(marker, source) };
  }
  if (source.runtime && marker.runtime && marker.runtime !== source.runtime) {
    return { status: 'stale', marker, source, sourceHash, reason: 'runtime', downgrade: markerIsNewer(marker, source) };
  }
  if (source.core && marker.core && marker.core !== source.core) {
    return { status: 'stale', marker, source, sourceHash, reason: 'core', downgrade: markerIsNewer(marker, source) };
  }
  return { status: 'fresh', marker, source, sourceHash, reason: 'match' };
}

// True when the installed bundle's package versions are NEWER than the
// invoking clone's source — i.e. a "stale" verdict that would actually
// be a DOWNGRADE if acted on. srcHash is direction-blind (any byte
// difference reads as stale), so without this signal a second clone,
// a git worktree, or an old branch checked out in the same clone
// silently rebuilds every fork BACKWARD at launch time. First hit
// live July 2026: `opencues run` from a wip-branch checkout (runtime
// 0.13.5) "healed" a fork freshly installed from master (0.16.0) —
// and because installs copy without deleting, the result was a MIXED
// bundle (new files present, registry/index stale). The launch-time
// self-heal refuses to rebuild when this is true; an explicit
// `opencues install <host>` remains the override (deliberate installs
// may downgrade — e.g. bisecting).
//
// Conservative on missing data: any absent version on either side
// contributes nothing, so pre-marker-era installs and unreadable
// source keep the old rebuild behaviour.
function markerIsNewer(marker, source) {
  const { semverCompare } = require('./compat.cjs');
  const newer = (a, b) => !!a && !!b && semverCompare(a, b) > 0;
  return newer(marker && marker.runtime, source && source.runtime)
    || newer(marker && marker.core, source && source.core);
}

// Walk every standard install root and return drift status for each.
// Standard roots:
//   ~/claude-code-cues/.cues/
//   ~/claude-code-cues-150/.cues/    (dual fork — the May 2026 case)
//   ~/opencode-cues/                 (we write to root since the fork is ours-by-clone)
//   ~/gemini-cli-cues/
//   <repo>/integrations/shell/node_modules/@opencues/   (self-owned host)
//   <repo>/integrations/chrome/dist/                    (built MV3 bundle)
//
// Returns: [{ host, root, drift }] for every root that exists on disk.
function enumerateInstalledHosts(ctx) {
  const candidates = [
    { host: 'claude-code',       root: supportDir('claude-code', resolveForkDir('claude-code')) },
    { host: 'opencode',          root: supportDir('opencode', resolveForkDir('opencode')) },
    { host: 'gemini-cli',        root: supportDir('gemini-cli', resolveForkDir('gemini-cli')) },
    { host: 'shell',             root: path.join(ctx.REPO_ROOT, 'integrations/shell/node_modules/@opencues') },
    { host: 'chrome',            root: path.join(ctx.REPO_ROOT, 'integrations/chrome/dist') },
    // dsh's served bundle INLINES core+runtime at build time, so a stale
    // bundle is exactly the drift this detects — the browser is running
    // whatever esbuild last saw, and nothing at page load would say so.
    { host: 'dsh',               root: path.join(ctx.REPO_ROOT, 'integrations/dsh/node_modules/@opencues') },
  ];
  const results = [];
  for (const c of candidates) {
    // Only enumerate hosts whose parent dir exists. The marker may not
    // exist yet (pre-marker-era installs) — `checkDrift` handles that
    // case as 'missing'.
    const parent = path.dirname(c.root);
    if (!fs.existsSync(parent)) continue;
    results.push({ host: c.host, root: c.root, drift: checkDrift(c.root, ctx) });
  }
  return results;
}

// Detect "dev relic" / stale CC fork dirs — every CC fork on disk (across the
// new ~/.opencues/forks/ layout AND the legacy ~/claude-code-cues* layout)
// other than the canonical new-location fork. Two populations: per-shape dev
// forks (`-150`, `-170`) and — post-consolidation — a leftover legacy
// ~/claude-code-cues from before the move. doctor surfaces these so the user
// can delete them (the legacy one after a reinstall lands the new fork).
function detectExtraCCForks() {
  const canonical = forkDir('claude-code');
  return enumerateForkDirs('claude-code').filter((dir) => dir !== canonical);
}

// Enumerate EVERY CC fork on disk that's a legit install (canonical +
// any `~/claude-code-cues*` siblings that carry a real CC binary).
// Returns: [{ root, target, shape }] for each fork.
//
// Why this exists: PR #117 (June 2026) bumped @opencues/{core,runtime}
// versions; only the canonical fork got rebuilt by `opencues install`.
// The `-170` dev fork — documented in CLAUDE.md as a load-bearing test
// install — kept running its stale bundle for hours with no warning,
// because every install-path command (install / update / doctor)
// historically only knew about the canonical fork.
//
// Fix shape: install/update fans out across whatever's on disk, so
// "I ran the installer once, everything's fresh" actually holds.
// detectExtraCCForks's older "delete the relics" framing is retained
// for genuinely orphaned dirs (no CC binary at all); anything with a
// real binary is rebuilt instead.
function enumerateCCForks() {
  const out = [];
  for (const root of enumerateForkDirs('claude-code')) {
    const cliJs = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    const nativeBin = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(cliJs)) {
      out.push({ root, target: cliJs, shape: 'cli.js' });
    } else if (fs.existsSync(nativeBin)) {
      out.push({ root, target: nativeBin, shape: 'native' });
    }
    // Dirs with no binary at all are skipped here — detectExtraCCForks
    // covers the "orphan dir to delete" surface.
  }
  // Canonical (new location) first if present; rest sorted for stable output.
  const canonicalRoot = forkDir('claude-code');
  const canonical = out.find(f => f.root === canonicalRoot);
  const others = out.filter(f => f !== canonical).sort((a, b) => a.root.localeCompare(b.root));
  return canonical ? [canonical, ...others] : others;
}

module.exports = {
  writeMarker,
  readMarker,
  checkDrift,
  markerIsNewer,
  enumerateInstalledHosts,
  detectExtraCCForks,
  enumerateCCForks,
  getSourceVersions,
  computeSourceHash,
  FILENAME,
  BUNDLED_SOURCE_DIRS,
};
