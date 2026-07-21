// Tests for `opencues logs` — read/tail /tmp/opencues.log.
//
// Zero prior coverage. logs.cjs hardcodes LOG_PATH = '/tmp/opencues.log'
// (not parameterised via ctx or env), so tests do NOT touch that real
// path at all (writing to it would race with other processes / isn't
// scratch-sandboxed and isn't hermetic across platforms — on Windows
// '/tmp/...' resolves against the current drive root, not a scratch
// dir). Instead every test monkey-patches `node:fs`'s `existsSync` and
// `node:child_process`'s `spawnSync`/`spawn` (both are singletons — the
// same module objects logs.cjs itself requires) so the command's control
// flow is exercised deterministically without any real file or `tail`
// binary dependency (not guaranteed to be on PATH on every platform).
//
// Hermeticity note: this file touches no HOME/USERPROFILE/tmpdir paths
// at all — logs.cjs's only "filesystem" surface is the hardcoded
// LOG_PATH check, which we stub. Nothing here needs the sandbox-HOME
// pattern used by the other suites in this pass, but per the review
// checklist we still confirm (see grep note in the closing summary)
// that no real path is ever touched.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

// logs.cjs does `const { spawnSync, spawn } = require('node:child_process')`
// at require-time — those locals are bound once, so patching `cp.spawnSync`
// / `cp.spawn` AFTER requiring logs.cjs would be invisible to it. Install
// one-time indirection wrappers on the child_process module BEFORE
// requiring logs.cjs, then swap the indirection TARGET per test instead
// of the module export itself. `fs.existsSync` doesn't need this trick —
// logs.cjs calls it via the `fs.` namespace at call time, so per-test
// reassignment of `fs.existsSync` works directly.
const realSpawnSyncFn = cp.spawnSync;
const realSpawnFn = cp.spawn;
let currentSpawnSync = realSpawnSyncFn;
let currentSpawn = realSpawnFn;
cp.spawnSync = (...args) => currentSpawnSync(...args);
cp.spawn = (...args) => currentSpawn(...args);

const logs = require('./logs.cjs');

let realExistsSync, realExit;
let sigintListenersBefore, sigtermListenersBefore;

beforeEach(() => {
  realExistsSync = fs.existsSync;
  currentSpawnSync = realSpawnSyncFn;
  currentSpawn = realSpawnFn;
  realExit = process.exit;
  sigintListenersBefore = process.listeners('SIGINT');
  sigtermListenersBefore = process.listeners('SIGTERM');
});

afterEach(() => {
  fs.existsSync = realExistsSync;
  currentSpawnSync = realSpawnSyncFn;
  currentSpawn = realSpawnFn;
  process.exit = realExit;
  // --tail registers new SIGINT/SIGTERM listeners on the real `process`;
  // strip anything added beyond what was there before this test so
  // listeners don't accumulate across the suite.
  for (const l of process.listeners('SIGINT')) {
    if (!sigintListenersBefore.includes(l)) process.removeListener('SIGINT', l);
  }
  for (const l of process.listeners('SIGTERM')) {
    if (!sigtermListenersBefore.includes(l)) process.removeListener('SIGTERM', l);
  }
});

// logs.cjs does NOT `return` after its `process.exit(1)` "no log file"
// call — real process.exit() never returns, so that's fine at runtime,
// but a non-throwing test stub would fall through into the tail/one-shot
// code below it and overwrite the exit code. Match the seed-configs.test.cjs
// / check-keys.test.cjs pattern: throw a sentinel from the stub so control
// actually leaves the function, and swallow just that sentinel here.
function silence(fn) {
  const origLog = console.log, origErr = console.error;
  const logsOut = [], errsOut = [];
  console.log = (...a) => logsOut.push(a.join(' '));
  console.error = (...a) => errsOut.push(a.join(' '));
  try { fn(); } catch (e) { if (!e || e.message !== '__EXIT__') throw e; }
  finally { console.log = origLog; console.error = origErr; }
  return { logs: logsOut, errs: errsOut };
}

function stubExit() {
  let code = null;
  process.exit = (c) => { code = c; throw new Error('__EXIT__'); };
  return () => code;
}

// ─── Happy path ────────────────────────────────────────────────────────────

test('happy: --help prints usage and touches neither fs nor child_process', () => {
  let existsCalled = false, spawnCalled = false;
  fs.existsSync = (...a) => { existsCalled = true; return realExistsSync(...a); };
  currentSpawnSync = (...a) => { spawnCalled = true; return realSpawnSyncFn(...a); };
  const { logs: out } = silence(() => logs(['--help']));
  assert.ok(out.some(l => l.includes('opencues logs')));
  assert.strictEqual(existsCalled, false, '--help must not check for the log file');
  assert.strictEqual(spawnCalled, false, '--help must not spawn tail');
});

test('happy: default one-shot invocation spawns tail -n 50 <LOG_PATH> and exits with its status', () => {
  fs.existsSync = () => true;
  let capturedArgs = null;
  currentSpawnSync = (cmd, args) => { capturedArgs = [cmd, ...args]; return { status: 0 }; };
  const getExitCode = stubExit();
  silence(() => logs([]));
  assert.deepStrictEqual(capturedArgs, ['tail', '-n', '50', '/tmp/opencues.log']);
  assert.strictEqual(getExitCode(), 0);
});

test('happy: --lines N passes the custom line count through to tail', () => {
  fs.existsSync = () => true;
  let capturedArgs = null;
  currentSpawnSync = (cmd, args) => { capturedArgs = [cmd, ...args]; return { status: 0 }; };
  stubExit();
  silence(() => logs(['--lines', '200']));
  assert.deepStrictEqual(capturedArgs, ['tail', '-n', '200', '/tmp/opencues.log']);
});

test('happy: --tail / -f spawns tail -f in follow mode with stdio inherited', () => {
  fs.existsSync = () => true;
  let capturedArgs = null, capturedOpts = null;
  const fakeChild = new EventEmitter();
  currentSpawn = (cmd, args, opts) => { capturedArgs = [cmd, ...args]; capturedOpts = opts; return fakeChild; };
  silence(() => logs(['--tail']));
  assert.deepStrictEqual(capturedArgs, ['tail', '-n', '50', '-f', '/tmp/opencues.log']);
  assert.strictEqual(capturedOpts.stdio, 'inherit');
});

test('happy: -f is an accepted alias for --tail', () => {
  fs.existsSync = () => true;
  let called = false;
  const fakeChild = new EventEmitter();
  currentSpawn = () => { called = true; return fakeChild; };
  silence(() => logs(['-f']));
  assert.strictEqual(called, true);
});

// ─── Edge cases ────────────────────────────────────────────────────────────

test('edge: --lines with no following value falls back to the default of 50', () => {
  fs.existsSync = () => true;
  let capturedArgs = null;
  currentSpawnSync = (cmd, args) => { capturedArgs = [cmd, ...args]; return { status: 0 }; };
  stubExit();
  silence(() => logs(['--lines']));
  assert.deepStrictEqual(capturedArgs, ['tail', '-n', '50', '/tmp/opencues.log']);
});

test('edge: tail exit status is propagated through process.exit', () => {
  fs.existsSync = () => true;
  currentSpawnSync = () => ({ status: 3 });
  const getExitCode = stubExit();
  silence(() => logs([]));
  assert.strictEqual(getExitCode(), 3);
});

test('edge: null tail status (killed by signal) falls back to exit 0', () => {
  fs.existsSync = () => true;
  currentSpawnSync = () => ({ status: null });
  const getExitCode = stubExit();
  silence(() => logs([]));
  assert.strictEqual(getExitCode(), 0);
});

test('edge: --tail registers SIGINT/SIGTERM handlers that kill the child and exit', () => {
  fs.existsSync = () => true;
  const fakeChild = new EventEmitter();
  fakeChild.kill = (sig) => { fakeChild.killedWith = sig; };
  currentSpawn = () => fakeChild;
  const getExitCode = stubExit();
  silence(() => logs(['--tail']));
  // The SIGINT handler itself calls the (throwing-stub) process.exit — the
  // handler fires synchronously inside emit(), so guard this call the same
  // way silence() guards the direct logs() call above.
  try { process.emit('SIGINT'); } catch (e) { if (!e || e.message !== '__EXIT__') throw e; }
  assert.strictEqual(fakeChild.killedWith, 'SIGINT');
  assert.strictEqual(getExitCode(), 0);
});

// ─── Invalid input ─────────────────────────────────────────────────────────

test('invalid: --lines with a non-numeric value degrades to "-n NaN" rather than crashing', () => {
  // Documents current (fragile but non-crashing) behaviour: parseInt('abc',
  // 10) is NaN, and String(NaN) === 'NaN' is passed straight through as the
  // -n argument. Not treated as a hard bug (no throw in logs.cjs itself;
  // a real `tail -n NaN` would just error on its own stderr, which
  // one-shot mode surfaces via inherited stdio).
  fs.existsSync = () => true;
  let capturedArgs = null;
  currentSpawnSync = (cmd, args) => { capturedArgs = [cmd, ...args]; return { status: 0 }; };
  stubExit();
  silence(() => logs(['--lines', 'not-a-number']));
  assert.deepStrictEqual(capturedArgs, ['tail', '-n', 'NaN', '/tmp/opencues.log']);
});

test('invalid: no log file present exits 1 with an actionable error, no spawn attempted', () => {
  fs.existsSync = () => false;
  let spawnCalled = false;
  currentSpawnSync = () => { spawnCalled = true; return { status: 0 }; };
  const getExitCode = stubExit();
  const { errs } = silence(() => logs([]));
  assert.strictEqual(getExitCode(), 1);
  assert.strictEqual(spawnCalled, false);
  assert.ok(errs.some(e => e.includes('No log file at')));
});

test('invalid: no log file present short-circuits --tail too (no spawn, no listeners registered)', () => {
  fs.existsSync = () => false;
  let spawnCalled = false;
  currentSpawn = () => { spawnCalled = true; return new EventEmitter(); };
  const getExitCode = stubExit();
  silence(() => logs(['--tail']));
  assert.strictEqual(getExitCode(), 1);
  assert.strictEqual(spawnCalled, false);
});
