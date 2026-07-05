// `opencues version` — print CLI version + per-integration versions
// + their declared compatibility ranges + what's actually installed
// on disk per integration (upstream host version + bundled runtime/core
// + install timestamp).
//
// Three sections build a complete picture for bug reports + drift
// checks:
//   1. Integrations — what we'd install if you ran install today
//      (source of truth: integrations/*/package.json)
//   2. Installed hosts — what's actually deployed (each fork's
//      version + bundled runtime/core marker)
//   3. Internal libraries — runtime + core source versions
//
// The "Installed hosts" section is the answer to "what versions am I
// actually running?" — until now you'd have to walk every fork dir
// yourself to find out.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { banner, tree, dim, cliVersion } = require('../lib/style.cjs');

const HOSTS = ['claude-code', 'opencode', 'chrome', 'gemini-cli', 'shell', 'vscode'];

module.exports = function version(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  console.log(banner({ version: cliVersion(ctx) }));
  console.log('');

  // ── Integrations (source-of-truth — what would deploy on install) ──
  const integRows = [];
  for (const h of HOSTS) {
    const pkgPath = path.join(ctx.REPO_ROOT, 'integrations', h, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      integRows.push([`@opencues/${h}`, dim('(not found)'), '']);
      continue;
    }
    const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const compat = p.compatibility
      ? Object.entries(p.compatibility).map(([k, v]) => `${k} ${v}`).join(', ')
      : dim('(unspecified)');
    integRows.push([p.name || `@opencues/${h}`, `v${p.version || '?'}`, compat]);
  }
  console.log(tree({
    title: 'Integrations (source)',
    description: 'host editor integrations + declared upstream compatibility',
    rows: integRows,
  }));
  console.log('');

  // ── Installed hosts (deployed-on-disk per fork) ────────────────────
  const deployed = enumerateDeployed(ctx);
  if (deployed.length === 0) {
    console.log(tree({
      title: 'Installed hosts',
      description: 'no installs detected — run `opencues install <host>` to get started',
      rows: [],
    }));
  } else {
    const rows = deployed.map(d => [
      d.host + (d.shape ? ` (${d.shape})` : ''),
      d.upstreamVersion ? `host v${d.upstreamVersion}` : dim('(host version unknown)'),
      d.runtime && d.core
        ? `runtime ${d.runtime} / core ${d.core}`
        : dim('(no version marker — re-run install to populate)'),
      dim(d.root),
    ]);
    console.log(tree({
      title: 'Installed hosts (deployed)',
      description: 'what\'s actually on disk per fork',
      rows,
    }));
  }
  console.log('');

  // ── Internal libraries (source) ────────────────────────────────────
  const libRows = [];
  for (const lib of ['opencues-core', 'opencues-runtime']) {
    const pkgPath = path.join(ctx.REPO_ROOT, 'packages', lib, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    libRows.push([p.name || lib, `v${p.version || '?'}`]);
  }
  console.log(tree({
    title: 'Internal libraries (source)',
    description: 'core + runtime source versions — compare against deployed runtime/core above to spot drift',
    rows: libRows,
  }));
};

// Enumerate every deployed install on disk. Returns:
//   [{ host, root, shape?, upstreamVersion?, runtime?, core?, installedAt? }]
//
// Walks the standard install roots from version-markers.cjs (which
// already knows about every host's canonical location), then for each
// also reads the upstream host's package.json so we can show the host
// version (e.g. "CC 2.1.150"), not just our bundled runtime version.
function enumerateDeployed(ctx) {
  const HOME = os.homedir();
  let enumerateInstalledHosts;
  try {
    ({ enumerateInstalledHosts } = require('../lib/version-markers.cjs'));
  } catch { return []; }

  const installs = enumerateInstalledHosts(ctx);
  return installs.map(({ host, root, drift }) => {
    // The version-markers lib already gave us runtime + core from the
    // marker; pull upstream version per-host from each fork's own
    // package.json so the output is more useful.
    const upstreamVersion = readUpstreamVersion(host, root);
    const shape = inferShape(host, root);
    return {
      host: normaliseHostLabel(host),
      root: forkRootFromMarkerDir(host, root),
      shape,
      upstreamVersion,
      runtime: drift.marker?.runtime || null,
      core: drift.marker?.core || null,
      installedAt: drift.marker?.installedAt || null,
    };
  });
}

// Where each host's upstream package.json lives, relative to the
// marker dir version-markers gave us. Subtle: each upstream repo
// stores its user-facing version in a different place — CC packages
// it under @anthropic-ai/claude-code, OC's monorepo has it under
// packages/opencode (the root package.json is a workspace shell
// with no version), Gemini puts it at the fork root.
function readUpstreamVersion(host, markerDir) {
  let pkgPath;
  if (host === 'claude-code' || host === 'claude-code-150') {
    // markerDir is <fork>/.cues; upstream pkg is at
    // <fork>/node_modules/@anthropic-ai/claude-code/package.json
    const forkRoot = path.dirname(markerDir);
    pkgPath = path.join(forkRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json');
  } else if (host === 'opencode') {
    // markerDir is <fork>/.opencues; OC is a monorepo whose root
    // package.json has no `version` — the user-facing version lives
    // at packages/opencode/package.json.
    pkgPath = path.join(path.dirname(markerDir), 'packages', 'opencode', 'package.json');
  } else if (host === 'gemini-cli') {
    // markerDir is <fork>/.opencues; upstream pkg at <fork>/package.json
    pkgPath = path.join(path.dirname(markerDir), 'package.json');
  } else {
    return null; // chrome (extension self) + shell/vscode (self-owned) — no upstream
  }
  try {
    const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return p.version || null;
  } catch { return null; }
}

// CC ships in two shapes; expose that distinction in the output so
// users can see "I have BOTH a cli.js fork and a native fork."
function inferShape(host, markerDir) {
  if (host !== 'claude-code' && host !== 'claude-code-150') return null;
  const forkRoot = path.dirname(markerDir);
  if (fs.existsSync(path.join(forkRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'))) return 'cli.js';
  if (fs.existsSync(path.join(forkRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))) return 'native';
  return null;
}

function forkRootFromMarkerDir(host, markerDir) {
  // version-markers passes us the marker DIR; show the user the FORK
  // root (its parent) since that's what they recognise from install
  // commands.
  if (host === 'shell' || host === 'chrome' || host === 'vscode') return markerDir;
  return path.dirname(markerDir);
}

function normaliseHostLabel(host) {
  // version-markers distinguishes claude-code vs claude-code-150 so
  // doctor can show two rows; for the user-facing version table both
  // are "claude-code" with a shape suffix.
  return host === 'claude-code-150' ? 'claude-code' : host;
}

function printHelp() {
  console.log('opencues version');
  console.log('');
  console.log('Print three views:');
  console.log('');
  console.log('  • Integrations (source)    — what would deploy if you ran `opencues install`');
  console.log('  • Installed hosts (deployed) — what\'s actually on disk per fork, including');
  console.log('                                upstream host versions (CC, OC, Gemini) +');
  console.log('                                bundled runtime/core + install timestamps');
  console.log('  • Internal libraries (source) — runtime + core source versions');
  console.log('');
  console.log('Compare "deployed runtime/core" against "Internal libraries (source)"');
  console.log('to spot drift — if any fork shows an older version, re-run install for that');
  console.log('host (or `opencues update` for everything).');
}
