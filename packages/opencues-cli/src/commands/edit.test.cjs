// Tests for `opencues edit <file>` — opens a .cues/ config file in $EDITOR.
//
// HERMETICITY:
//  - `os.homedir()` is called fresh inside edit.cjs's function body (not
//    cached at module scope), so a per-test HOME/USERPROFILE swap via
//    beforeEach/afterEach is sufficient (contrast with context.cjs, whose
//    module-scope `const HOME = os.homedir()` needs the swap BEFORE
//    require — see context.test.cjs's header for the story). Both env
//    vars are set because `os.homedir()` on this Windows dev box reads
//    `%USERPROFILE%`, not `$HOME`.
//  - edit.cjs destructures `const { spawnSync } = require('node:child_process')`
//    at require-time, exactly like cleanup.cjs — so the real editor must
//    never actually be launched. The stub below is installed on
//    `node:child_process` BEFORE edit.cjs is first required, so edit.cjs's
//    destructuring captures the stub, not the real spawnSync.
//  - edit.cjs calls `process.exit()` on EVERY successful run (not just
//    error paths), so `process.exit` is stubbed for the whole file.

'use strict';

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cp = require('node:child_process');
const realSpawnSync = cp.spawnSync;
let spawnSyncCalls = [];
let spawnSyncResult = { status: 0 };
cp.spawnSync = (...args) => {
  spawnSyncCalls.push(args);
  return spawnSyncResult;
};

// Required AFTER the spawnSync stub is installed (destructured at load time).
const edit = require('./edit.cjs');

let realHome, realUserProfile, tmpHome;
let realVisual, realEditor;

beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  realVisual = process.env.VISUAL;
  realEditor = process.env.EDITOR;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-edit-test-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  spawnSyncCalls = [];
  spawnSyncResult = { status: 0 };
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  if (realVisual === undefined) delete process.env.VISUAL; else process.env.VISUAL = realVisual;
  if (realEditor === undefined) delete process.env.EDITOR; else process.env.EDITOR = realEditor;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

after(() => { cp.spawnSync = realSpawnSync; });

function cuesFilePath() { return path.join(tmpHome, '.cues', 'cues.md'); }

function capture(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  const realExit = process.exit;
  let exitCode = null;
  process.exit = (c) => { exitCode = c; throw new Error('__EXIT__'); };
  let threw = null;
  try { fn(); }
  catch (e) { if (e.message !== '__EXIT__') threw = e; }
  finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = realExit;
  }
  if (threw) throw threw;
  return { logs: logs.join('\n'), errs: errs.join('\n'), exitCode };
}

// ─── Happy path ─────────────────────────────────────────────────────────────

test('happy: `edit cues` creates a fresh cues.md, launches the editor, exits 0', () => {
  const { logs, exitCode } = capture(() => edit(['cues'], { version: 'test' }));
  assert.strictEqual(exitCode, 0);
  assert.ok(fs.existsSync(cuesFilePath()));
  assert.match(fs.readFileSync(cuesFilePath(), 'utf8'), /auto-created by opencues edit/);
  assert.match(logs, /\(created\)/);
  assert.strictEqual(spawnSyncCalls.length, 1);
  assert.strictEqual(spawnSyncCalls[0][0], 'vi'); // default fallback editor
  assert.deepStrictEqual(spawnSyncCalls[0][1], [cuesFilePath()]);
  assert.strictEqual(spawnSyncCalls[0][2].stdio, 'inherit');
});

test('happy: an existing cues.md is opened as-is, no "(created)" marker, no overwrite', () => {
  fs.mkdirSync(path.dirname(cuesFilePath()), { recursive: true });
  fs.writeFileSync(cuesFilePath(), '# my existing content\n');
  const { logs, exitCode } = capture(() => edit(['cues'], {}));
  assert.strictEqual(exitCode, 0);
  assert.doesNotMatch(logs, /\(created\)/);
  assert.strictEqual(fs.readFileSync(cuesFilePath(), 'utf8'), '# my existing content\n');
});

test('happy: `--project` opens <cwd>/.cues/cues.md instead of ~/.cues/cues.md', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-edit-project-'));
  const cwd = process.cwd();
  process.chdir(projectDir);
  try {
    const { exitCode } = capture(() => edit(['cues', '--project'], {}));
    assert.strictEqual(exitCode, 0);
    const projectFile = path.join(projectDir, '.cues', 'cues.md');
    assert.ok(fs.existsSync(projectFile));
    assert.strictEqual(fs.existsSync(cuesFilePath()), false); // user-level untouched
  } finally {
    process.chdir(cwd);
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test('edge: $EDITOR is used over the vi fallback', () => {
  process.env.EDITOR = 'nano';
  const { exitCode } = capture(() => edit(['cues'], {}));
  assert.strictEqual(exitCode, 0);
  assert.strictEqual(spawnSyncCalls[0][0], 'nano');
});

test('edge: $VISUAL wins over $EDITOR', () => {
  process.env.EDITOR = 'nano';
  process.env.VISUAL = 'code --wait';
  const { exitCode } = capture(() => edit(['cues'], {}));
  assert.strictEqual(exitCode, 0);
  assert.strictEqual(spawnSyncCalls[0][0], 'code --wait');
});

test('edge: flags before the positional name are still parsed correctly', () => {
  // Uses --project, which resolves against <cwd>/.cues — chdir into a
  // throwaway sandbox dir first so this never touches the real repo tree
  // (a prior draft of this test omitted the chdir and left a stray
  // <repo>/packages/opencues-cli/.cues/cues.md on disk).
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-edit-flagorder-'));
  const cwd = process.cwd();
  process.chdir(projectDir);
  try {
    const { exitCode } = capture(() => edit(['--project', 'cues'], {}));
    assert.strictEqual(exitCode, 0);
    assert.ok(fs.existsSync(path.join(projectDir, '.cues', 'cues.md')));
  } finally {
    process.chdir(cwd);
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('edge: a non-zero editor exit status is propagated as the process exit code', () => {
  spawnSyncResult = { status: 3 };
  const { exitCode } = capture(() => edit(['cues'], {}));
  assert.strictEqual(exitCode, 3);
});

test('edge: --help prints usage and does not touch the filesystem or spawn anything', () => {
  const { logs, exitCode } = capture(() => edit(['--help'], {}));
  assert.strictEqual(exitCode, null);
  assert.match(logs, /opencues edit <file> \[--project\]/);
  assert.strictEqual(fs.existsSync(cuesFilePath()), false);
  assert.strictEqual(spawnSyncCalls.length, 0);
});

// ─── Invalid input ──────────────────────────────────────────────────────────

test('invalid: missing <file> exits 2 with an actionable error', () => {
  const { errs, exitCode } = capture(() => edit([], {}));
  assert.strictEqual(exitCode, 2);
  assert.match(errs, /missing <file>/);
  assert.strictEqual(spawnSyncCalls.length, 0);
});

test('invalid: unknown <file> name exits 2, listing the valid options', () => {
  const { errs, exitCode } = capture(() => edit(['blanks'], {}));
  assert.strictEqual(exitCode, 2);
  assert.match(errs, /unknown <file> "blanks"/);
  assert.match(errs, /cues/);
});

test('invalid: editor fails to launch (spawnSync returns .error) exits 127', () => {
  spawnSyncResult = { error: new Error('ENOENT: no such editor') };
  const { errs, exitCode } = capture(() => edit(['cues'], {}));
  assert.strictEqual(exitCode, 127);
  assert.match(errs, /failed to launch/);
});
