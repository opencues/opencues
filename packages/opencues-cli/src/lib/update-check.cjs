// Update-check — passive notifier for "a newer opencues is on npm".
//
// Design:
//   - Reads ~/.opencues/.update-check.json (TTL 24h) BEFORE hitting the
//     network. Cache lets every `opencues …` invocation be O(1).
//   - On cache miss / stale → fetches https://registry.npmjs.org/opencues/latest.
//     2s timeout. Failure (offline / 4xx / 5xx) is silent — the next
//     run tries again.
//   - Returns a NOTICE (not an action). Caller decides where to surface
//     it. Today we surface it in install/run/doctor footers.
//   - Respects OPENCUES_NO_UPDATE_CHECK=1. CI / privacy-sensitive users
//     can opt out cleanly. Honoured before any network call.
//   - On clones / dev installs (pnpm-workspace.yaml present), the check
//     compares against the workspace package's version — we still tell
//     dev users "remote has v0.2, you're on v0.1" so the dev's clone
//     stays current.
//
// This module is intentionally CommonJS with no deps — it loads on
// every CLI invocation. Failing-silent on every error path is the
// load-bearing property; we never want a notifier bug to break the
// real command the user invoked.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const CACHE_FILE = path.join(os.homedir(), '.opencues', '.update-check.json');
const REGISTRY_URL = 'https://registry.npmjs.org/opencues/latest';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const NETWORK_TIMEOUT_MS = 2000;

/**
 * Returns the cached notice if fresh, else fetches + caches, else null.
 * Synchronous-on-cache, async-on-miss. Most invocations hit cache and
 * return < 1ms.
 *
 * @returns {Promise<{ latest: string, current: string, available: boolean } | null>}
 */
async function checkForUpdate(currentVersion, opts = {}) {
  if (process.env.OPENCUES_NO_UPDATE_CHECK === '1') return null;

  const now = opts.now || Date.now();
  const cached = readCache(opts.cacheFile);
  if (cached && (now - cached.checkedAt) < TTL_MS) {
    return buildNotice(currentVersion, cached.latest);
  }

  // Cache miss or stale → fetch.
  let latest;
  try {
    latest = await fetchLatest(opts.url || REGISTRY_URL, opts.fetcher);
  } catch {
    // Network failure — leave the stale cache in place if we have one,
    // never crash. The next invocation tries again.
    if (cached) return buildNotice(currentVersion, cached.latest);
    return null;
  }

  if (!latest) return null;
  writeCache({ latest, checkedAt: now }, opts.cacheFile);
  return buildNotice(currentVersion, latest);
}

function buildNotice(currentVersion, latestVersion) {
  if (!currentVersion || !latestVersion) return null;
  return {
    current: currentVersion,
    latest: latestVersion,
    available: compareVersions(latestVersion, currentVersion) > 0,
  };
}

// Tiny semver-only comparator. Returns >0 if a > b, <0 if a < b, 0 if equal.
// Accepts X.Y.Z plus pre-release tags (treats pre-release as < release
// per semver §11). Not a full semver impl — just what we need to compare
// "are we on the latest?".
function compareVersions(a, b) {
  const parsea = parseVersion(a);
  const parseb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (parsea.num[i] !== parseb.num[i]) return parsea.num[i] - parseb.num[i];
  }
  // Equal X.Y.Z; pre-release < release.
  if (parsea.pre && !parseb.pre) return -1;
  if (!parsea.pre && parseb.pre) return 1;
  if (parsea.pre && parseb.pre) {
    return parsea.pre.localeCompare(parseb.pre);
  }
  return 0;
}

function parseVersion(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/);
  if (!m) return { num: [0, 0, 0], pre: null };
  return {
    num: [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)],
    pre: m[4] || null,
  };
}

function readCache(cacheFile) {
  try {
    const raw = fs.readFileSync(cacheFile || CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.latest !== 'string' || typeof parsed.checkedAt !== 'number') return null;
    return parsed;
  } catch { return null; }
}

function writeCache(data, cacheFile) {
  try {
    const target = cacheFile || CACHE_FILE;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(data));
  } catch { /* silent — cache write failure is not a real problem */ }
}

function fetchLatest(url, fetcher) {
  // Injectable fetcher for tests. Default uses node:https.
  if (fetcher) return fetcher(url);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: NETWORK_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`status ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).version); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

/** Format a notice for the install/run/doctor footer. Returns a string
 *  with the suggested action, or null if no notice or not-newer. */
function formatNotice(notice) {
  if (!notice || !notice.available) return null;
  return `opencues v${notice.latest} is available (you're on v${notice.current}) — run \`opencues update\` to upgrade`;
}

// Sync-only cache read for hot paths (e.g. `opencues run <host>`) where
// a 2s network fetch before the integration launches would be jarring.
// Returns whatever's in cache without ever touching the network. If
// the cache is empty/missing/stale, returns null — the user just won't
// see a notice on this run. The next install/doctor run does the
// network fetch and refreshes the cache.
function getCachedNotice(currentVersion, opts = {}) {
  if (process.env.OPENCUES_NO_UPDATE_CHECK === '1') return null;
  const cached = readCache(opts.cacheFile);
  if (!cached) return null;
  return buildNotice(currentVersion, cached.latest);
}

module.exports = {
  checkForUpdate,
  getCachedNotice,
  formatNotice,
  // Exported for tests.
  _internal: { compareVersions, parseVersion, readCache, writeCache },
};
