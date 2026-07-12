// Tests for `opencues debug [on|off]` — the debug-mode OPENCUES.md
// scalar toggle.
//
// HERMETICITY: `ocFile()` in debug.cjs calls `os.homedir()` fresh on
// every invocation (inside the function, not cached at module scope —
// unlike context.cjs, see that file's header comment for the contrast),
// so a per-test `beforeEach` HOME/USERPROFILE swap is sufficient here.
// Both env vars are overridden because `os.homedir()` on this Windows
// dev box reads `%USERPROFILE%`, not `$HOME`.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const debug = require('./debug.cjs');
const prompt = require('../lib/prompt.cjs');

let realHome, realUserProfile, tmpHome;
let realIsInteractive, realSelect;

beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-debug-test-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  realIsInteractive = prompt.isInteractive;
  realSelect = prompt.select;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  prompt.isInteractive = realIsInteractive;
  prompt.select = realSelect;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function ocFilePath() { return path.join(tmpHome, '.cues', 'OPENCUES.md'); }

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
  return Promise.resolve()
    .then(fn)
    .catch((e) => { if (e.message !== '__EXIT__') throw e; })
    .finally(() => {
      console.log = origLog;
      console.error = origErr;
      process.exit = realExit;
    })
    .then(() => ({ logs: logs.join('\n'), errs: errs.join('\n'), exitCode }));
}

// ─── Happy path ─────────────────────────────────────────────────────────────

test('happy: `debug on` writes debug-mode: on to a fresh ~/.cues/OPENCUES.md', async () => {
  const { logs } = await capture(() => debug(['on'], {}));
  assert.match(logs, /Set debug-mode: on/);
  const content = fs.readFileSync(ocFilePath(), 'utf8');
  assert.match(content, /^debug-mode:\s*on\s*$/m);
});

test('happy: `debug off` after `debug on` flips the value in place, preserving other scalars', async () => {
  await capture(() => debug(['on'], {}));
  fs.appendFileSync(ocFilePath(), ''); // no-op, documents file already exists
  // Seed an unrelated scalar to prove it survives the rewrite.
  const before = fs.readFileSync(ocFilePath(), 'utf8').replace(
    /^---\n/, '---\nvoice-mode: on\n',
  );
  fs.writeFileSync(ocFilePath(), before);
  await capture(() => debug(['off'], {}));
  const content = fs.readFileSync(ocFilePath(), 'utf8');
  assert.match(content, /^debug-mode:\s*off\s*$/m);
  assert.match(content, /^voice-mode:\s*on\s*$/m);
});

test('happy: non-interactive, no value → prints the current setting instead of prompting', async () => {
  await capture(() => debug(['on'], {}));
  const { logs } = await capture(() => debug([], {}));
  assert.match(logs, /debug-mode = on/);
});

test('happy: `--project` scopes the write to <cwd>/.cues/OPENCUES.md instead of ~/.cues/', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-debug-project-'));
  const cwd = process.cwd();
  process.chdir(projectDir);
  try {
    await capture(() => debug(['on', '--project'], {}));
    const projectFile = path.join(projectDir, '.cues', 'OPENCUES.md');
    assert.ok(fs.existsSync(projectFile));
    assert.match(fs.readFileSync(projectFile, 'utf8'), /debug-mode:\s*on/);
    // Must not have touched the sandboxed user-level file.
    assert.strictEqual(fs.existsSync(ocFilePath()), false);
  } finally {
    process.chdir(cwd);
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test('edge: printCurrent reports "not present" when OPENCUES.md does not exist yet', async () => {
  const { logs } = await capture(() => debug([], {}));
  assert.match(logs, /not present \(debug-mode would default to 'off'\)/);
});

test('edge: writing debug-mode into a file with no frontmatter fence wraps it in a new one', async () => {
  fs.mkdirSync(path.join(tmpHome, '.cues'), { recursive: true });
  fs.writeFileSync(ocFilePath(), 'just some prose, no frontmatter\n');
  await capture(() => debug(['on'], {}));
  const content = fs.readFileSync(ocFilePath(), 'utf8');
  assert.match(content, /^---\ndebug-mode: on\n---\n/);
  assert.match(content, /just some prose, no frontmatter/);
});

test('edge: interactive picker writes the newly picked value when it differs from current', async () => {
  prompt.isInteractive = () => true;
  prompt.select = async () => 'off';
  await capture(() => debug(['on'], {})); // seed current = on, scriptable path
  const { logs } = await capture(() => debug([], {})); // now goes interactive
  assert.match(logs, /debug-mode = off/);
  const content = fs.readFileSync(ocFilePath(), 'utf8');
  assert.match(content, /^debug-mode:\s*off\s*$/m);
});

test('edge: interactive picker choosing the same value as current is a no-op', async () => {
  await capture(() => debug(['on'], {}));
  prompt.isInteractive = () => true;
  prompt.select = async () => 'on';
  const { logs } = await capture(() => debug([], {}));
  assert.match(logs, /already on — nothing changed/);
});

test('edge: --help prints usage without touching the filesystem', async () => {
  const { logs } = await capture(() => debug(['--help'], {}));
  assert.match(logs, /opencues debug \[on\|off\] \[--project\]/);
  assert.strictEqual(fs.existsSync(ocFilePath()), false);
});

// ─── Invalid input ──────────────────────────────────────────────────────────

test('invalid: a value other than on/off exits 2 with an actionable error', async () => {
  const { errs, exitCode } = await capture(() => debug(['maybe'], {}));
  assert.strictEqual(exitCode, 2);
  assert.match(errs, /value must be 'on' or 'off' \(got "maybe"\)/);
  assert.strictEqual(fs.existsSync(ocFilePath()), false);
});
