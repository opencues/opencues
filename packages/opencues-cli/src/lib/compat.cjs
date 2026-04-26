// Helpers for reading per-integration compat.json + checking against
// upstream host versions. Used by `opencues update [--check|--to]`.
//
// compat.json contract — see integrations/<host>/compat.json. Three
// host-kinds:
//   - "npm"     : host ships as an npm package (CC). We can query the
//                 npm registry without authentication.
//   - "git"     : host is git-pinned (OC). We can query GitHub's release
//                 API for tags + SHAs (also unauthenticated, with rate
//                 limit caveats).
//   - "browser" : host is a browser (Chrome). No auto-upgrade path —
//                 the user updates Chrome via the browser. We just print
//                 the supported-version table.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

/** Load the compat manifest for a given integration folder name (e.g. 'claude-code'). */
function loadCompat(repoRoot, host) {
  const p = path.join(repoRoot, 'integrations', host, 'compat.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Fetch JSON over HTTPS with a small timeout. Returns null on any failure. */
function fetchJson(url, { headers = {}, timeoutMs = 8000 } = {}) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'opencues-cli', Accept: 'application/json', ...headers },
      timeout: timeoutMs,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Query npm registry for all versions of a package. Returns sorted [oldest..newest] or null. */
async function queryNpmVersions(pkgName) {
  const data = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`);
  if (!data || !data.versions) return null;
  return Object.keys(data.versions).sort(semverCompare);
}

/** Query GitHub for tags on a repo (e.g. 'sst/opencode'). Returns [{name, sha}, ...] or null. */
async function queryGitHubTags(repo) {
  const data = await fetchJson(`https://api.github.com/repos/${repo}/tags?per_page=30`);
  if (!Array.isArray(data)) return null;
  return data.map(t => ({ name: t.name, sha: (t.commit && t.commit.sha || '').slice(0, 7) }));
}

/** Compare two semver-ish strings. Tolerates "v" prefix + non-numeric suffixes (rc, alpha). */
function semverCompare(a, b) {
  const parse = s => s.replace(/^v/, '').split(/[.-]/).map(p => /^\d+$/.test(p) ? Number(p) : p);
  const av = parse(a), bv = parse(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const x = av[i], y = bv[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else {
      // Non-numeric (e.g. "rc") sorts BEFORE its numeric counterpart per
      // semver pre-release rules. Plain strcmp is good enough for our use.
      if (String(x) !== String(y)) return String(x) < String(y) ? -1 : 1;
    }
  }
  return 0;
}

/** True if `version` matches a glob-y range like "2.1.x" or ">=121". */
function matchesRange(version, range) {
  if (!range) return false;
  const v = version.replace(/^v/, '');
  // ">=N" handling for chrome-style ranges.
  const ge = range.match(/^>=\s*(\d+)/);
  if (ge) return semverCompare(v, ge[1]) >= 0;
  // "X.Y.x" / "X.x" handling.
  if (range.endsWith('.x')) {
    const prefix = range.slice(0, -1);
    return v.startsWith(prefix);
  }
  // Range like "X.Y.Z - X.Y.x" — accept either bound's prefix.
  if (range.includes(' - ')) {
    return range.split(' - ').some(b => matchesRange(version, b));
  }
  // Exact.
  return v === range;
}

/** True if version appears in the compat manifest's `known-incompatible` list. */
function isKnownIncompatible(version, compat) {
  if (!Array.isArray(compat['known-incompatible'])) return null;
  for (const e of compat['known-incompatible']) {
    if (e.version === version) return e;
    // first-broken means everything from that version up is broken.
    if (e['first-broken'] && semverCompare(version, e['first-broken']) >= 0) return e;
  }
  return null;
}

/** True if version appears in the compat manifest's `tested` list. */
function isTested(version, compat) {
  if (!Array.isArray(compat.tested)) return false;
  return compat.tested.some(t => (typeof t === 'string' ? t : t.version) === version);
}

/**
 * Classify a candidate host version against our compat manifest.
 * Returns: 'tested' | 'compat-untested' | 'incompatible' | 'out-of-range'
 */
function classifyVersion(version, compat) {
  const ki = isKnownIncompatible(version, compat);
  if (ki) return { status: 'incompatible', reason: ki.reason };
  if (isTested(version, compat)) return { status: 'tested' };
  if (matchesRange(version, compat['compat-range'])) return { status: 'compat-untested' };
  return { status: 'out-of-range' };
}

/** Read the user's currently-installed pin (npm forks only). Returns string or null. */
function readNpmPin(home, compat) {
  if (compat['host-kind'] !== 'npm') return null;
  const loc = compat['pin-location'];
  if (!loc || loc.kind !== 'npm-package-json') return null;
  const forkDir = (loc['fork-default'] || '').replace(/^~/, home);
  const pkgPath = path.join(forkDir, loc['path-from-fork'] || 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const fieldPath = (loc.field || '').split('.');
    let v = pkg;
    for (const k of fieldPath) v = v && v[k];
    if (typeof v !== 'string') return null;
    // Strip any caret/tilde prefix (we recommend exact pins but the
    // function should still report what's actually there).
    return v.replace(/^[\^~]/, '');
  } catch {
    return null;
  }
}

module.exports = {
  loadCompat,
  queryNpmVersions,
  queryGitHubTags,
  semverCompare,
  matchesRange,
  classifyVersion,
  readNpmPin,
};
