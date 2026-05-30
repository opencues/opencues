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

const FILENAME = 'version.json';

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
//   { status: 'fresh' | 'stale' | 'missing', marker, source }
// `fresh`: marker's runtime + core match source.
// `stale`: marker exists but at least one version doesn't match.
// `missing`: no marker (host not installed via the marker era).
function checkDrift(markerDir, ctx) {
  const marker = readMarker(markerDir);
  const source = getSourceVersions(ctx.REPO_ROOT);
  if (!marker) return { status: 'missing', marker: null, source };
  if (source.runtime && marker.runtime && marker.runtime !== source.runtime) {
    return { status: 'stale', marker, source };
  }
  if (source.core && marker.core && marker.core !== source.core) {
    return { status: 'stale', marker, source };
  }
  return { status: 'fresh', marker, source };
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
  const HOME = os.homedir();
  const candidates = [
    { host: 'claude-code',       root: path.join(HOME, 'claude-code-cues', '.cues') },
    { host: 'claude-code-150',   root: path.join(HOME, 'claude-code-cues-150', '.cues') },
    { host: 'opencode',          root: path.join(HOME, 'opencode-cues', '.opencues') },
    { host: 'gemini-cli',        root: path.join(HOME, 'gemini-cli-cues', '.opencues') },
    { host: 'shell',             root: path.join(ctx.REPO_ROOT, 'integrations/shell/node_modules/@opencues') },
    { host: 'chrome',            root: path.join(ctx.REPO_ROOT, 'integrations/chrome/dist') },
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

module.exports = {
  writeMarker,
  readMarker,
  checkDrift,
  enumerateInstalledHosts,
  getSourceVersions,
  FILENAME,
};
