// Tests for set-key's at-rest perm hardening (INFOSEC F7).
//
// Contract: regardless of pre-existing perms on ~/.cues/.env, after
// `opencues set-key` runs, the file is mode 0o600 and the parent dir
// is 0o700. Verifies the writeFileSync({mode}) gotcha (mode only on
// creation) is no longer load-bearing.

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const setKey = require('./set-key.cjs');

let realHome;
let tmpHome;

before(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-set-key-test-'));
  process.env.HOME = tmpHome;
});

after(() => {
  process.env.HOME = realHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function envFilePath() {
  return path.join(os.homedir(), '.cues', '.env');
}

function runSetKey(args) {
  // Swallow stdout/stderr to keep test output clean.
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try { setKey(args, { version: 'test' }); }
  finally { console.log = origLog; console.error = origErr; }
}

test('set-key creates file with mode 0o600 + parent dir 0o700', { skip: process.platform === 'win32' }, () => {
  const file = envFilePath();
  try { fs.unlinkSync(file); } catch {}
  try { fs.rmdirSync(path.dirname(file)); } catch {}

  runSetKey(['groq', 'gsk_test_create']);

  const fileMode = fs.statSync(file).mode & 0o777;
  const dirMode = fs.statSync(path.dirname(file)).mode & 0o777;
  assert.strictEqual(fileMode, 0o600, `expected 0600, got ${fileMode.toString(8)}`);
  assert.strictEqual(dirMode, 0o700, `expected 0700, got ${dirMode.toString(8)}`);
});

test('set-key tightens pre-existing world-readable file to 0o600', { skip: process.platform === 'win32' }, () => {
  const file = envFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'EXISTING_KEY=foo\n');
  fs.chmodSync(file, 0o644);
  fs.chmodSync(path.dirname(file), 0o755);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o644);

  runSetKey(['groq', 'gsk_test_tighten']);

  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

  // Existing key preserved, new key added.
  const contents = fs.readFileSync(file, 'utf8');
  assert.match(contents, /EXISTING_KEY=foo/);
  assert.match(contents, /GROQ_API_KEY=gsk_test_tighten/);
});

test('set-key tightens pre-existing group-readable file to 0o600', { skip: process.platform === 'win32' }, () => {
  const file = envFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'KEY=val\n');
  fs.chmodSync(file, 0o640);

  runSetKey(['groq', 'gsk_test_group']);

  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});
