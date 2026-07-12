// Tests for `opencues new <kind> <name>` — scaffold a single cue/blank.
//
// Zero prior coverage. Purely scriptable path only (non-interactive —
// node --test has no TTY, so prompt.isInteractive() is false and every
// interactive branch is skipped automatically, exercising the same
// "flags win" contract every other command test in this pass relies on).
//
// Hermeticity: HOME + USERPROFILE point at a fresh mkdtemp dir per test
// (new.cjs's default, non --project scope writes under os.homedir());
// every test also chdir's into its own fresh mkdtemp project dir for the
// --project cases. Both restored/removed after.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const newCmd = require('./new.cjs');

const PKG_DIR = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');

let realHome, realUserProfile, realCwd;
let tmpHome, projectDir;

beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  realCwd = process.cwd();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-new-home-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-new-proj-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.chdir(projectDir);
});

afterEach(() => {
  process.chdir(realCwd);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function ctx() { return { PKG_DIR, REPO_ROOT }; }

async function run(argv) {
  const logs = [], errs = [];
  const origLog = console.log, origErr = console.error, origExit = process.exit;
  let exitCode = null;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  process.exit = (code) => { exitCode = code; throw new Error('__EXIT__'); };
  let threw = false;
  try {
    await newCmd(argv, ctx());
  } catch (err) {
    if (!err || err.message !== '__EXIT__') { console.log = origLog; console.error = origErr; process.exit = origExit; throw err; }
    threw = true;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errs, exitCode, threw };
}

// ─── Happy path ────────────────────────────────────────────────────────────

test('happy: --help prints usage and creates nothing', async () => {
  const { logs, threw } = await run(['--help']);
  assert.strictEqual(threw, false);
  assert.ok(logs.some(l => l.includes('opencues new')));
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues')), false);
});

test('happy: `new cue <name>` (user scope) scaffolds CUE.md with {{NAME}} substituted', async () => {
  const { threw, exitCode } = await run(['cue', 'my-legal-cue']);
  assert.strictEqual(threw, false);
  assert.strictEqual(exitCode, null);
  const file = path.join(tmpHome, '.cues', 'cues', 'my-legal-cue', 'CUE.md');
  assert.strictEqual(fs.existsSync(file), true);
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('name: my-legal-cue'));
  assert.ok(!content.includes('{{NAME}}'));
});

test('happy: `new blank <name> --project` scaffolds BLANK.md under <cwd>/.cues/', async () => {
  const { threw, exitCode } = await run(['blank', 'my-api', '--project']);
  assert.strictEqual(threw, false);
  assert.strictEqual(exitCode, null);
  const file = path.join(projectDir, '.cues', 'blanks', 'my-api', 'BLANK.md');
  assert.strictEqual(fs.existsSync(file), true);
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('name: my-api'));
  assert.ok(content.includes('type: blank'));
});

test('happy: --dry-run prints the plan and creates nothing', async () => {
  const { logs, threw } = await run(['cue', 'dryrun-cue', '--dry-run']);
  assert.strictEqual(threw, false);
  assert.ok(logs.some(l => l.includes('[dry-run]')));
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'cues', 'dryrun-cue')), false);
});

// ─── Edge cases ────────────────────────────────────────────────────────────

test('edge: name with digits and hyphens after the leading letter is accepted', async () => {
  const { threw, exitCode } = await run(['cue', 'a1-b2-c3']);
  assert.strictEqual(threw, false);
  assert.strictEqual(exitCode, null);
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'cues', 'a1-b2-c3', 'CUE.md')), true);
});

test('edge: single-letter name is accepted (minimal valid boundary)', async () => {
  const { threw, exitCode } = await run(['blank', 'a']);
  assert.strictEqual(threw, false);
  assert.strictEqual(exitCode, null);
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'blanks', 'a', 'BLANK.md')), true);
});

test('edge: user scope and project scope for the same name coexist independently', async () => {
  await run(['cue', 'shared-name']);
  const { threw, exitCode } = await run(['cue', 'shared-name', '--project']);
  assert.strictEqual(threw, false);
  assert.strictEqual(exitCode, null);
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'cues', 'shared-name', 'CUE.md')), true);
  assert.strictEqual(fs.existsSync(path.join(projectDir, '.cues', 'cues', 'shared-name', 'CUE.md')), true);
});

test('edge: unrecognised flags are ignored rather than rejected (forwards-compat, no throw)', async () => {
  const { threw, exitCode } = await run(['cue', 'flagtest', '--totally-not-a-real-flag']);
  assert.strictEqual(threw, false);
  assert.strictEqual(exitCode, null);
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'cues', 'flagtest', 'CUE.md')), true);
});

// ─── Invalid input ─────────────────────────────────────────────────────────

test('invalid: missing both kind and name exits 2 with usage guidance', async () => {
  const { errs, exitCode, threw } = await run([]);
  assert.strictEqual(threw, true);
  assert.strictEqual(exitCode, 2);
  assert.ok(errs.some(e => e.includes('missing arguments')));
});

test('invalid: missing name (kind given) exits 2', async () => {
  const { errs, exitCode, threw } = await run(['cue']);
  assert.strictEqual(threw, true);
  assert.strictEqual(exitCode, 2);
  assert.ok(errs.some(e => e.includes('missing arguments')));
});

test('invalid: unknown kind exits 2', async () => {
  const { errs, exitCode, threw } = await run(['nonsense-kind', 'somename']);
  assert.strictEqual(threw, true);
  assert.strictEqual(exitCode, 2);
  assert.ok(errs.some(e => e.includes('unknown kind')));
});

test('invalid: name starting with uppercase letter is rejected', async () => {
  const { errs, exitCode, threw } = await run(['cue', 'BadName']);
  assert.strictEqual(threw, true);
  assert.strictEqual(exitCode, 2);
  assert.ok(errs.some(e => e.includes('must match')));
});

test('invalid: name starting with a digit is rejected', async () => {
  const { errs, exitCode, threw } = await run(['cue', '1bad']);
  assert.strictEqual(threw, true);
  assert.strictEqual(exitCode, 2);
  assert.ok(errs.some(e => e.includes('must match')));
});

test('invalid: name containing spaces is rejected', async () => {
  const { errs, exitCode, threw } = await run(['cue', 'bad name']);
  assert.strictEqual(threw, true);
  assert.strictEqual(exitCode, 2);
  assert.ok(errs.some(e => e.includes('must match')));
});

test('invalid: name containing an underscore is rejected (only lowercase/digits/hyphens allowed)', async () => {
  const { errs, exitCode, threw } = await run(['blank', 'bad_name']);
  assert.strictEqual(threw, true);
  assert.strictEqual(exitCode, 2);
  assert.ok(errs.some(e => e.includes('must match')));
});

test('invalid: refuses to overwrite an existing scaffold with the same kind+name', async () => {
  await run(['cue', 'dupname']);
  const { errs, exitCode, threw } = await run(['cue', 'dupname']);
  assert.strictEqual(threw, true);
  assert.strictEqual(exitCode, 1);
  assert.ok(errs.some(e => e.includes('refusing to overwrite')));
  // Original content survives — not touched by the refused write.
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'cues', 'dupname', 'CUE.md')), true);
});

test('invalid: same name across kinds (cue vs blank) does not collide (different subdirs)', async () => {
  await run(['cue', 'samename']);
  const { threw, exitCode } = await run(['blank', 'samename']);
  assert.strictEqual(threw, false);
  assert.strictEqual(exitCode, null);
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'cues', 'samename', 'CUE.md')), true);
  assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'blanks', 'samename', 'BLANK.md')), true);
});
