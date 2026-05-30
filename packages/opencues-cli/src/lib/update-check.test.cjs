// Tests for the update-check notifier.
//
// What we test:
//   - Version comparison (catches "v0.10.0 < v0.2.0" string-compare bugs)
//   - Cache TTL: fresh cache returned without fetch; stale triggers fetch
//   - OPENCUES_NO_UPDATE_CHECK env-var opt-out
//   - Network failure falls back to stale cache (never throws)
//   - Notice only when latest > current (not equal, not older)
//   - parseVersion handles X.Y.Z and pre-release tags
//
// What we DON'T test here:
//   - The actual https.get → registry.npmjs.org round-trip. Mocked via
//     the injectable `fetcher` option. Real network coverage belongs in
//     an integration test, not a unit suite.
//
// Run: node --test packages/opencues-cli/src/lib/update-check.test.cjs

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { checkForUpdate, getCachedNotice, formatNotice, _internal } = require('./update-check.cjs');

// Each test gets its own cache file so they don't trample each other.
function freshCacheFile(name) {
  const p = path.join(os.tmpdir(), `oc-update-check-test-${name}-${process.pid}-${Date.now()}.json`);
  try { fs.unlinkSync(p); } catch {}
  return p;
}

test('compareVersions: standard X.Y.Z', () => {
  const cmp = _internal.compareVersions;
  assert.strictEqual(cmp('1.0.0', '1.0.0'), 0);
  assert.ok(cmp('1.0.1', '1.0.0') > 0);
  assert.ok(cmp('1.1.0', '1.0.99') > 0);
  assert.ok(cmp('2.0.0', '1.99.99') > 0);
  // Catch the lexical-compare bug — "0.10.0" < "0.2.0" if you string-sort.
  assert.ok(cmp('0.10.0', '0.2.0') > 0);
  assert.ok(cmp('0.2.0', '0.10.0') < 0);
});

test('compareVersions: pre-release < release', () => {
  const cmp = _internal.compareVersions;
  assert.ok(cmp('1.0.0', '1.0.0-beta.1') > 0);
  assert.ok(cmp('1.0.0-alpha', '1.0.0') < 0);
  assert.ok(cmp('1.0.0-beta.2', '1.0.0-beta.1') > 0);
});

test('parseVersion: malformed returns zeros', () => {
  assert.deepStrictEqual(_internal.parseVersion('not-a-version').num, [0, 0, 0]);
  assert.deepStrictEqual(_internal.parseVersion('').num, [0, 0, 0]);
});

test('OPENCUES_NO_UPDATE_CHECK=1 returns null without fetching', async () => {
  const prior = process.env.OPENCUES_NO_UPDATE_CHECK;
  process.env.OPENCUES_NO_UPDATE_CHECK = '1';
  let fetched = false;
  try {
    const notice = await checkForUpdate('0.1.0', {
      cacheFile: freshCacheFile('env-opt-out'),
      fetcher: async () => { fetched = true; return '999.0.0'; },
    });
    assert.strictEqual(notice, null);
    assert.strictEqual(fetched, false, 'fetcher must not be called when opt-out env is set');
  } finally {
    if (prior === undefined) delete process.env.OPENCUES_NO_UPDATE_CHECK;
    else process.env.OPENCUES_NO_UPDATE_CHECK = prior;
  }
});

test('first call fetches; second call within TTL uses cache', async () => {
  const cacheFile = freshCacheFile('ttl-cache');
  let fetchCount = 0;

  const notice1 = await checkForUpdate('0.1.0', {
    cacheFile,
    now: 1_000_000_000,
    fetcher: async () => { fetchCount++; return '0.2.0'; },
  });
  assert.strictEqual(notice1.latest, '0.2.0');
  assert.strictEqual(notice1.available, true);
  assert.strictEqual(fetchCount, 1, 'first call hits network');

  // Same fetcher, second call 1h later — should hit cache.
  const notice2 = await checkForUpdate('0.1.0', {
    cacheFile,
    now: 1_000_000_000 + (60 * 60 * 1000), // +1h
    fetcher: async () => { fetchCount++; return 'unused'; },
  });
  assert.strictEqual(notice2.latest, '0.2.0');
  assert.strictEqual(fetchCount, 1, 'within-TTL call must hit cache');

  fs.unlinkSync(cacheFile);
});

test('stale cache triggers re-fetch', async () => {
  const cacheFile = freshCacheFile('ttl-stale');
  let fetchCount = 0;

  await checkForUpdate('0.1.0', {
    cacheFile,
    now: 1_000_000_000,
    fetcher: async () => { fetchCount++; return '0.2.0'; },
  });
  assert.strictEqual(fetchCount, 1);

  // 25h later → stale. Should re-fetch.
  const notice = await checkForUpdate('0.1.0', {
    cacheFile,
    now: 1_000_000_000 + (25 * 60 * 60 * 1000),
    fetcher: async () => { fetchCount++; return '0.3.0'; },
  });
  assert.strictEqual(fetchCount, 2);
  assert.strictEqual(notice.latest, '0.3.0');

  fs.unlinkSync(cacheFile);
});

test('network failure with no cache returns null (silent)', async () => {
  const cacheFile = freshCacheFile('net-fail-no-cache');
  const notice = await checkForUpdate('0.1.0', {
    cacheFile,
    fetcher: async () => { throw new Error('ENETUNREACH'); },
  });
  assert.strictEqual(notice, null, 'network failure with no cache must not throw');
});

test('network failure with stale cache returns stale notice', async () => {
  const cacheFile = freshCacheFile('net-fail-stale-cache');
  // Seed a stale cache.
  fs.writeFileSync(cacheFile, JSON.stringify({
    latest: '0.2.0',
    checkedAt: 1_000_000_000,
  }));
  // 100h later, network fails. We should fall back to the stale cache
  // rather than crash. Better stale than nothing.
  const notice = await checkForUpdate('0.1.0', {
    cacheFile,
    now: 1_000_000_000 + (100 * 60 * 60 * 1000),
    fetcher: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.ok(notice, 'should return notice from stale cache');
  assert.strictEqual(notice.latest, '0.2.0');
  fs.unlinkSync(cacheFile);
});

test('notice.available is false when current >= latest', async () => {
  const cacheFile = freshCacheFile('not-available');
  const notice = await checkForUpdate('0.2.0', {
    cacheFile,
    fetcher: async () => '0.2.0',
  });
  assert.strictEqual(notice.available, false);
  fs.unlinkSync(cacheFile);

  const cacheFile2 = freshCacheFile('not-available-newer');
  const notice2 = await checkForUpdate('0.3.0', {
    cacheFile: cacheFile2,
    fetcher: async () => '0.2.0',
  });
  assert.strictEqual(notice2.available, false);
  fs.unlinkSync(cacheFile2);
});

test('formatNotice: null/not-available returns null', () => {
  assert.strictEqual(formatNotice(null), null);
  assert.strictEqual(formatNotice({ current: '0.1.0', latest: '0.1.0', available: false }), null);
});

test('formatNotice: available returns a hint string', () => {
  const s = formatNotice({ current: '0.1.0', latest: '0.2.0', available: true });
  assert.ok(s.includes('v0.2.0'));
  assert.ok(s.includes('v0.1.0'));
  assert.ok(s.includes('opencues update'));
});

test('getCachedNotice: returns null when no cache exists', () => {
  const cacheFile = freshCacheFile('cached-empty');
  const notice = getCachedNotice('0.1.0', { cacheFile });
  assert.strictEqual(notice, null);
});

test('getCachedNotice: returns notice from existing cache (never fetches)', () => {
  const cacheFile = freshCacheFile('cached-hit');
  fs.writeFileSync(cacheFile, JSON.stringify({ latest: '0.5.0', checkedAt: Date.now() }));
  const notice = getCachedNotice('0.1.0', { cacheFile });
  assert.ok(notice);
  assert.strictEqual(notice.latest, '0.5.0');
  assert.strictEqual(notice.available, true);
  fs.unlinkSync(cacheFile);
});

test('getCachedNotice: respects OPENCUES_NO_UPDATE_CHECK', () => {
  const cacheFile = freshCacheFile('cached-opt-out');
  fs.writeFileSync(cacheFile, JSON.stringify({ latest: '99.0.0', checkedAt: Date.now() }));
  const prior = process.env.OPENCUES_NO_UPDATE_CHECK;
  process.env.OPENCUES_NO_UPDATE_CHECK = '1';
  try {
    assert.strictEqual(getCachedNotice('0.1.0', { cacheFile }), null);
  } finally {
    if (prior === undefined) delete process.env.OPENCUES_NO_UPDATE_CHECK;
    else process.env.OPENCUES_NO_UPDATE_CHECK = prior;
  }
  fs.unlinkSync(cacheFile);
});

test('corrupted cache file is treated as no cache', async () => {
  const cacheFile = freshCacheFile('corrupted');
  fs.writeFileSync(cacheFile, '{ not valid json');
  let fetchCount = 0;
  const notice = await checkForUpdate('0.1.0', {
    cacheFile,
    fetcher: async () => { fetchCount++; return '0.2.0'; },
  });
  assert.strictEqual(notice.latest, '0.2.0');
  assert.strictEqual(fetchCount, 1, 'corrupted cache must trigger fresh fetch');
  fs.unlinkSync(cacheFile);
});
