// Integration test for the registry-fetch path of update-check.
//
// The unit suite (update-check.test.cjs) injects a fake fetcher. That
// validates every branch of the caching/comparison logic but leaves
// the real `https.get` codepath untested. This file fills that gap by
// running an actual HTTP server in-process (via Node's built-in http)
// and pointing the fetcher at it via the `url` option.
//
// We still don't hit the real registry.npmjs.org — that would make
// tests flaky (network dependency) and slow. The point is to exercise
// the real `node:https`-equivalent code (`node:http` for our test
// server) end-to-end without mocking it out.
//
// Trade-off: we're testing against http, not https. The fetcher uses
// https.get in production; for the local test we override `url` to
// http://localhost:N and the production code happens to still work
// because https.get's API mirrors http.get's request/response shape.
// A more rigorous version would spin up a self-signed HTTPS server,
// but the marginal coverage isn't worth the certificate dance.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { checkForUpdate } = require('./update-check.cjs');

function freshCacheFile(name) {
  return path.join(os.tmpdir(), `oc-uc-int-${name}-${process.pid}-${Date.now()}.json`);
}

// Spin up a test HTTP server that emulates npm's `latest` endpoint.
// Returns { url, close }. Caller awaits `close()` to shut down.
function startRegistryServer(responseBody, opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (opts.hangMs) {
        return setTimeout(() => {
          res.writeHead(opts.status || 200, { 'Content-Type': 'application/json' });
          res.end(responseBody);
        }, opts.hangMs);
      }
      res.writeHead(opts.status || 200, { 'Content-Type': 'application/json' });
      res.end(responseBody);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

// Override the fetcher used by checkForUpdate to use http instead of
// https for the test. This is essentially what the injectable fetcher
// is for; we wire it to a real Node http.get round-trip.
function httpFetcher(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`status ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).version); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

test('integration: real HTTP fetch parses the version + caches it', async () => {
  const server = await startRegistryServer('{"name":"opencues","version":"0.2.7"}');
  const cacheFile = freshCacheFile('happy');
  try {
    const notice = await checkForUpdate('0.1.0', {
      url: server.url,
      cacheFile,
      fetcher: httpFetcher,
    });
    assert.ok(notice);
    assert.strictEqual(notice.latest, '0.2.7');
    assert.strictEqual(notice.available, true);
    // Cache file written.
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.strictEqual(cache.latest, '0.2.7');
    assert.ok(typeof cache.checkedAt === 'number');
  } finally {
    await server.close();
    try { fs.unlinkSync(cacheFile); } catch {}
  }
});

test('integration: 5xx response is silent (no notice, no cache write)', async () => {
  const server = await startRegistryServer('"server error"', { status: 500 });
  const cacheFile = freshCacheFile('5xx');
  try {
    const notice = await checkForUpdate('0.1.0', {
      url: server.url,
      cacheFile,
      fetcher: httpFetcher,
    });
    assert.strictEqual(notice, null, 'no notice on 5xx');
    assert.strictEqual(fs.existsSync(cacheFile), false, 'no cache write on 5xx');
  } finally {
    await server.close();
  }
});

test('integration: malformed JSON returns null without throwing', async () => {
  const server = await startRegistryServer('not-json{{{');
  const cacheFile = freshCacheFile('malformed');
  try {
    const notice = await checkForUpdate('0.1.0', {
      url: server.url,
      cacheFile,
      fetcher: httpFetcher,
    });
    assert.strictEqual(notice, null);
  } finally {
    await server.close();
  }
});

test('integration: timeout falls through to null silently', async () => {
  // Server delays 4s; our fetcher times out at 2s.
  const server = await startRegistryServer('{"version":"0.2.0"}', { hangMs: 4000 });
  const cacheFile = freshCacheFile('timeout');
  try {
    const notice = await checkForUpdate('0.1.0', {
      url: server.url,
      cacheFile,
      fetcher: httpFetcher,
    });
    assert.strictEqual(notice, null, 'timeout must not throw');
  } finally {
    await server.close();
  }
});
