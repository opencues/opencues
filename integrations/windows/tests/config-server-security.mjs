// Config-server security invariants — the trust gate that stops a visited
// web page from stealing the user's LLM API keys off the daemon's loopback
// HTTP server.
//
// Threat: the config server serves `/api/keys` (RAW key values) on a fixed,
// guessable loopback port. Binding to 127.0.0.1 does NOT keep browsers out —
// any website the user visits can fetch loopback. The defence is a same-origin
// trust model: NO CORS headers (browser blocks cross-origin reads), a Host
// allow-list (defeats DNS-rebinding), and an Origin refusal (defeats cross-site
// fetch/POST). This test pins all three so a regression can't silently re-open
// drive-by key theft.
//
// Run: node integrations/windows/tests/config-server-security.mjs

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startConfigServer } = require('../src/config-server.cjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`); if (!cond) failures++; };

// Isolated cues home with a real key on disk, so /api/keys has something to leak.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cfgsec-'));
fs.writeFileSync(path.join(home, '.env'), 'GROQ_API_KEY=sk-secret-do-not-leak-1234567890\n');
process.env.GROQ_API_KEY = ''; // force the file to be the source (not a shell export)

const PORT = 51899;
const server = startConfigServer({ cuesHome: home, bind: '127.0.0.1', port: PORT, status: () => ({ shimConnected: false }), log: () => {} });

// Minimal raw HTTP client so we control the Host + Origin headers exactly
// (fetch/undici would rewrite Host, which is the whole point of the test).
function raw({ method = 'GET', pathname = '/', host = `127.0.0.1:${PORT}`, origin, body }) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (origin !== undefined) headers.Origin = origin;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: pathname, headers, setHost: false }, (res) => {
      let data = ''; res.on('data', (d) => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const run = async () => {
  // 1. Legitimate same-origin GET (loopback Host, no Origin) → keys served.
  const good = await raw({ pathname: '/api/keys', host: `127.0.0.1:${PORT}` });
  ok(good.status === 200 && good.body.includes('sk-secret'), 'same-origin GET /api/keys returns the keys');

  // 2. THE core defence: no wildcard (or any) CORS header on a key response —
  //    without this a cross-origin page could read the body.
  ok(good.headers['access-control-allow-origin'] === undefined, '/api/keys sends NO Access-Control-Allow-Origin header');

  // 3. Cross-site Origin (a visited web page's fetch) → refused, no keys.
  const evil = await raw({ pathname: '/api/keys', host: `127.0.0.1:${PORT}`, origin: 'https://evil.example' });
  ok(evil.status === 403 && !evil.body.includes('sk-secret'), 'cross-site Origin on /api/keys is refused (403, no keys)');

  // 4. DNS-rebinding: a foreign Host header (evil.com → 127.0.0.1) → refused.
  const rebind = await raw({ pathname: '/api/keys', host: `evil.example:${PORT}` });
  ok(rebind.status === 403 && !rebind.body.includes('sk-secret'), 'non-loopback Host (DNS-rebinding) is refused (403, no keys)');

  // 5. Opaque origin ("null", e.g. a sandboxed iframe) → refused.
  const nullOrigin = await raw({ pathname: '/api/keys', host: `127.0.0.1:${PORT}`, origin: 'null' });
  ok(nullOrigin.status === 403, 'opaque Origin "null" is refused');

  // 6. Cross-site POST (CSRF write to delete/overwrite keys) → refused.
  const csrf = await raw({ method: 'POST', pathname: '/api/config', host: `127.0.0.1:${PORT}`, origin: 'https://evil.example', body: JSON.stringify({ keys: { GROQ_API_KEY: '' } }) });
  ok(csrf.status === 403, 'cross-site POST /api/config is refused (no CSRF key wipe)');
  ok(fs.readFileSync(path.join(home, '.env'), 'utf8').includes('sk-secret'), 'the key on disk survived the cross-site POST attempt');

  // 7. Cross-origin preflight (OPTIONS) → refused, no CORS grant.
  const pre = await raw({ method: 'OPTIONS', pathname: '/api/config', host: `127.0.0.1:${PORT}`, origin: 'https://evil.example' });
  ok(pre.status === 403 && pre.headers['access-control-allow-origin'] === undefined, 'cross-origin OPTIONS preflight is refused with no CORS grant');

  server.close();
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  if (failures) { console.error(`\n${failures} config-server security invariant(s) FAILED`); process.exit(1); }
  console.log('\nall config-server security invariants hold');
};

run().catch((e) => { console.error(e); server.close(); process.exit(1); });
