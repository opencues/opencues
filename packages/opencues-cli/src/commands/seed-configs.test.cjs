// Command-level tests for `opencues seed-configs`.
//
// The four SEED/SYNC/HEAL/COMPILE *phases* are already covered in depth by
// `packages/opencues-runtime/testing/seed-configs.test.ts` (it requires this
// SAME .cjs file directly — see that file's header comment and this file's
// own `module.exports._test` surface). This suite intentionally does NOT
// re-test phase behaviour; it covers the command-level surface that suite
// doesn't touch: `--help`, `--dry-run`, exit-code on a missing source dir,
// `--silent`'s actual effect on stdout, the `OPENCUES_HOME` override, and
// flag combinations.
//
// Hermeticity: every test sets HOME to a fresh mkdtemp dir (never the real
// user's ~/.cues/) and restores it afterwards, per the vendor-pins test
// pattern (see lib/vendor-pins.test.cjs / doctor.scanblanks.test.cjs).

'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const seedConfigs = require('./seed-configs.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../../..');

let realHome;
let realUserProfile;
let realOpencuesHome;
let tmpHome;

// os.homedir() does NOT read $HOME on Windows — it reads %USERPROFILE%
// (verified empirically: setting only process.env.HOME left os.homedir()
// pointing at the real C:\Users\<real user> here). seed-configs.cjs calls
// os.homedir() directly, so on win32 a test that only overrides HOME is
// NOT hermetic — it would silently read/write the real user's profile.
// Override both so this suite is hermetic on every platform.
beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  realOpencuesHome = process.env.OPENCUES_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-seed-cmd-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.OPENCUES_HOME;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  if (realOpencuesHome === undefined) delete process.env.OPENCUES_HOME; else process.env.OPENCUES_HOME = realOpencuesHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function silence(fn) {
  const orig = console.log;
  const calls = [];
  console.log = (...args) => calls.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return calls;
}

// ─── Happy path ────────────────────────────────────────────────────────────

test('happy: --help prints usage and performs no filesystem writes', () => {
  const calls = silence(() => seedConfigs(['--help'], { REPO_ROOT }));
  assert.ok(calls.some(l => l.includes('opencues seed-configs')), `expected usage text, got: ${JSON.stringify(calls)}`);
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues')), false, '--help must not create ~/.cues/');
});

test('happy: without --silent, console.log is called (normal verbose output)', () => {
  const calls = silence(() => seedConfigs([], { REPO_ROOT }));
  assert.ok(calls.length > 0, 'expected verbose output when --silent is not passed');
});

test('happy: OPENCUES_HOME override redirects the OPENCUES.md target', () => {
  const altHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-seed-althome-'));
  process.env.OPENCUES_HOME = altHome;
  try {
    silence(() => seedConfigs(['--silent'], { REPO_ROOT }));
    assert.strictEqual(fs.existsSync(path.join(altHome, 'OPENCUES.md')), true, 'OPENCUES.md should land at $OPENCUES_HOME');
    // The rest of the library (cues/, blanks/) still seeds under ~/.cues/
    // regardless of the OPENCUES_HOME override (only the settings file moves).
    assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'cues')), true);
  } finally {
    fs.rmSync(altHome, { recursive: true, force: true });
  }
});

// ─── Edge cases ────────────────────────────────────────────────────────────

test('edge: --silent produces zero console.log calls even when work happens', () => {
  const calls = silence(() => seedConfigs(['--silent'], { REPO_ROOT }));
  assert.deepStrictEqual(calls, [], `--silent must suppress all console.log output, got: ${JSON.stringify(calls)}`);
  // Confirm real work still happened despite the silence.
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'OPENCUES.md')), true);
});

test('edge: --dry-run creates no CUES/BLANKS content, only prints the plan', () => {
  const calls = silence(() => seedConfigs(['--dry-run'], { REPO_ROOT }));
  assert.ok(calls.some(l => l.includes('dry-run')), `expected a dry-run notice, got: ${JSON.stringify(calls)}`);
  // Target dir may exist (pre-seed migrate step mkdir's it unconditionally)
  // but must be empty — no actual copy happened.
  const targetDir = path.join(tmpHome, '.cues');
  if (fs.existsSync(targetDir)) {
    assert.deepStrictEqual(fs.readdirSync(targetDir), [], 'dry-run must not populate ~/.cues/');
  }
});

test('edge: --project --dry-run together scope to cwd and still do no writes', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-seed-proj-'));
  const cwd = process.cwd();
  process.chdir(projectDir);
  try {
    const calls = silence(() => seedConfigs(['--project', '--dry-run'], { REPO_ROOT }));
    assert.ok(calls.some(l => l.includes('dry-run')));
    const targetDir = path.join(projectDir, '.cues');
    if (fs.existsSync(targetDir)) {
      assert.deepStrictEqual(fs.readdirSync(targetDir), []);
    }
    // User-level HOME must be completely untouched by a --project run.
    assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues')), false);
  } finally {
    process.chdir(cwd);
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── Invalid input ─────────────────────────────────────────────────────────

test('invalid: missing defaults/ source dir exits 1 with an actionable error', () => {
  const fakeRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-seed-norepo-'));
  const realExit = process.exit;
  const errors = [];
  const realErr = console.error;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('__EXIT__'); };
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.throws(() => seedConfigs(['--silent'], { REPO_ROOT: fakeRepoRoot }), /__EXIT__/);
    assert.strictEqual(exitCode, 1);
    assert.ok(errors.some(e => e.includes('source dir not found')), `expected a source-dir error, got: ${JSON.stringify(errors)}`);
  } finally {
    process.exit = realExit;
    console.error = realErr;
    fs.rmSync(fakeRepoRoot, { recursive: true, force: true });
  }
});

test('invalid: unrecognised flags are ignored rather than rejected (forwards-compat, no throw)', () => {
  assert.doesNotThrow(() => silence(() => seedConfigs(['--totally-not-a-real-flag'], { REPO_ROOT })));
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'OPENCUES.md')), true, 'unknown flags must not block the normal seed run');
});
