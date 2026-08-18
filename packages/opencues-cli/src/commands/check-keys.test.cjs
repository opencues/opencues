// Tests for `opencues check-keys` — API key liveness probe.
//
// The command makes real HTTPS calls per configured key, so tests either
// avoid triggering any network I/O (the "no keys configured" path skips
// every probe function entirely — see the `if (!key) continue;` guard in
// check-keys.cjs) or monkey-patch `node:https`'s `.get` so a "configured"
// key can be exercised deterministically without a real network call.
//
// Hermeticity: HOME (+ USERPROFILE, which is what os.homedir() actually
// reads on Windows — see seed-configs.test.cjs for why both are needed)
// point at a fresh mkdtemp dir with no `.cues/.env`, and every provider
// env var this command reads is cleared/restored around each test.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');

const checkKeys = require('./check-keys.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
// DERIVED from the provider registry, not hardcoded — the hardcoded seven
// drifted the day an eighth provider landed: adding deepseek made core's
// key-detection recognise DEEPSEEK_API_KEY, a developer's shell exporting it
// leaked through this sanitize list, and the no-network assertion below
// failed on that machine while CI (no such key) stayed green. Deriving the
// list means the NEXT provider is scrubbed automatically. FINNHUB is the one
// non-LLM key check-keys also probes, so it rides along explicitly.
const coreForKeys = require(path.resolve(__dirname, '../../../opencues-core/dist/index.js'));
const PROVIDER_ENV_KEYS = [
  ...new Set(coreForKeys.listProviders().map((pv) => pv.envKeyName).filter(Boolean)),
  'FINNHUB_API_KEY',
];

let realHome, realUserProfile;
let savedProviderEnv = {};
let tmpHome;

beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-checkkeys-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  savedProviderEnv = {};
  for (const k of PROVIDER_ENV_KEYS) {
    savedProviderEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  for (const k of PROVIDER_ENV_KEYS) {
    if (savedProviderEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedProviderEnv[k];
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  const origLog = console.log;
  console.log = (...args) => chunks.push(args.join(' ') + '\n');
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = orig;
    console.log = origLog;
  }).then(() => chunks.join(''));
}

// ─── Happy path ────────────────────────────────────────────────────────────

test('happy: --help prints usage without making any network calls', async () => {
  const realGet = https.get;
  let called = false;
  https.get = (...args) => { called = true; return realGet(...args); };
  try {
    const out = await captureStdout(() => checkKeys(['--help'], { REPO_ROOT }));
    assert.match(out, /opencues check-keys/);
    assert.strictEqual(called, false, '--help must not hit the network');
  } finally {
    https.get = realGet;
  }
});

test('happy: no keys configured — every provider reports unset, zero network calls, no exit(1)', async () => {
  const realGet = https.get;
  let called = false;
  https.get = (...args) => { called = true; return realGet(...args); };
  const realExit = process.exit;
  let exitCode = null;
  process.exit = (c) => { exitCode = c; };
  try {
    const out = await captureStdout(() => checkKeys([], { REPO_ROOT }));
    assert.strictEqual(called, false, 'unset keys must never trigger a probe call');
    assert.match(out, /GROQ_API_KEY unset/);
    assert.match(out, /FINNHUB_API_KEY unset/);
    assert.strictEqual(exitCode, null, 'no configured keys means nothing can fail — must not exit(1)');
  } finally {
    https.get = realGet;
    process.exit = realExit;
  }
});

// ─── Edge cases ─────────────────────────────────────────────────────────

test('edge: a key present in ~/.cues/.env is picked up (process.env still wins if both set)', async () => {
  const envDir = path.join(tmpHome, '.cues');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, '.env'), 'FINNHUB_API_KEY=file-based-key\n');

  // Mock the network so the "file-based-key" path resolves deterministically.
  const realGet = https.get;
  const seenUrls = [];
  https.get = (url, opts, cb) => {
    seenUrls.push(String(url));
    const { EventEmitter } = require('node:events');
    const res = new EventEmitter();
    res.statusCode = 200;
    process.nextTick(() => {
      res.emit('data', Buffer.from('{"c":123.45}'));
      res.emit('end');
    });
    cb(res);
    return new EventEmitter();
  };
  try {
    const out = await captureStdout(() => checkKeys([], { REPO_ROOT }));
    assert.ok(seenUrls.some(u => u.includes('finnhub.io')), `expected a finnhub probe call, got: ${JSON.stringify(seenUrls)}`);
    assert.match(out, /AAPL=\$123\.45/);
  } finally {
    https.get = realGet;
  }
});

test('edge: process.env value wins over ~/.cues/.env for the same key', async () => {
  const envDir = path.join(tmpHome, '.cues');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, '.env'), 'FINNHUB_API_KEY=file-key\n');
  process.env.FINNHUB_API_KEY = 'env-key';

  const realGet = https.get;
  let seenAuth = null;
  https.get = (url, opts, cb) => {
    seenAuth = String(url);
    const { EventEmitter } = require('node:events');
    const res = new EventEmitter();
    res.statusCode = 200;
    process.nextTick(() => { res.emit('data', Buffer.from('{"c":1}')); res.emit('end'); });
    cb(res);
    return new EventEmitter();
  };
  try {
    await captureStdout(() => checkKeys([], { REPO_ROOT }));
    assert.ok(seenAuth.includes('token=env-key'), `expected process.env value in the request, got: ${seenAuth}`);
  } finally {
    https.get = realGet;
  }
});

// ─── Invalid input ─────────────────────────────────────────────────────────

test('invalid: a failing probe (401) is reported and the command exits 1', async () => {
  process.env.FINNHUB_API_KEY = 'bad-key';
  const realGet = https.get;
  https.get = (url, opts, cb) => {
    const { EventEmitter } = require('node:events');
    const res = new EventEmitter();
    res.statusCode = 401;
    process.nextTick(() => { res.emit('data', Buffer.from('unauthorized')); res.emit('end'); });
    cb(res);
    return new EventEmitter();
  };
  const realExit = process.exit;
  let exitCode = null;
  process.exit = (c) => { exitCode = c; };
  try {
    const out = await captureStdout(() => checkKeys([], { REPO_ROOT }));
    assert.match(out, /HTTP 401/);
    assert.strictEqual(exitCode, 1, 'a failing configured key must exit 1');
  } finally {
    https.get = realGet;
    process.exit = realExit;
  }
});

test('invalid: a malformed .env line (no "=") is silently ignored, not crashed on', async () => {
  const envDir = path.join(tmpHome, '.cues');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, '.env'), 'THIS LINE HAS NO EQUALS SIGN\nGROQ_API_KEY=\n');
  const realGet = https.get;
  let called = false;
  https.get = (...args) => { called = true; return realGet(...args); };
  try {
    const out = await captureStdout(() => checkKeys([], { REPO_ROOT }));
    // GROQ_API_KEY= parses to an empty string, which is falsy — still unset.
    assert.match(out, /GROQ_API_KEY unset/);
    assert.strictEqual(called, false);
  } finally {
    https.get = realGet;
  }
});
