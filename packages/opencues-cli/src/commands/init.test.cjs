// Tests for `opencues init` — scaffold <cwd>/.cues/ with templates.
//
// Zero prior coverage. init.cjs is synchronous and reads its template
// files from `ctx.PKG_DIR/src/templates/`, so ctx must point at the REAL
// opencues-cli package dir (the templates aren't duplicated per-test).
//
// Hermeticity: HOME + USERPROFILE point at a fresh mkdtemp dir per test
// (init.cjs doesn't itself read HOME directly, but process.cwd() is
// where it writes — every test chdir's into its own fresh mkdtemp
// project dir, restored + removed afterward, so the real repo/cwd is
// never touched).
//
// NOTE: init.cjs used to throw ENOENT on the non-`--minimal` path because
// its `files` list included AUDITORS.md but src/templates/ shipped no such
// template. Fixed by shipping the template (+ a defensive empty-scaffold
// fallback). The 'non-minimal scaffolds all four files' test below is the
// regression pin; the former vitest `it.fails` knownbug file is retired.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const init = require('./init.cjs');

const PKG_DIR = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');

let realCwd;
let projectDir;

beforeEach(() => {
  realCwd = process.cwd();
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-init-proj-'));
  process.chdir(projectDir);
});

afterEach(() => {
  process.chdir(realCwd);
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function ctx() { return { PKG_DIR, REPO_ROOT }; }

function silence(fn) {
  const origLog = console.log;
  const calls = [];
  console.log = (...a) => calls.push(a.join(' '));
  try { fn(); } finally { console.log = origLog; }
  return calls;
}

// ─── Happy path ────────────────────────────────────────────────────────────

test('happy: --help prints usage and creates nothing', () => {
  const calls = silence(() => init(['--help'], ctx()));
  assert.ok(calls.some(l => l.includes('opencues init')));
  assert.strictEqual(fs.existsSync(path.join(projectDir, '.cues')), false);
});

test('happy: --minimal creates all four files with empty .md bodies except README', () => {
  silence(() => init(['--minimal'], ctx()));
  const dir = path.join(projectDir, '.cues');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'CUES.md'), 'utf8'), '');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'BLANKS.md'), 'utf8'), '');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'AUDITORS.md'), 'utf8'), '');
  // README is always the real template, even in --minimal (informational, not schema).
  assert.ok(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').length > 0);
});

test('happy: no flags scaffolds all four files from real templates (non-minimal)', () => {
  // Regression: the missing src/templates/AUDITORS.md template used to
  // throw ENOENT mid-loop, leaving .cues/ half-scaffolded (CUES.md +
  // BLANKS.md written, AUDITORS.md + README.md never reached).
  silence(() => init([], ctx()));
  const dir = path.join(projectDir, '.cues');
  for (const f of ['CUES.md', 'BLANKS.md', 'AUDITORS.md', 'README.md']) {
    assert.strictEqual(fs.existsSync(path.join(dir, f)), true, `${f} was scaffolded`);
    assert.ok(fs.readFileSync(path.join(dir, f), 'utf8').length > 0, `${f} has template content`);
  }
});

test('happy: --dry-run prints the plan and creates nothing', () => {
  const calls = silence(() => init(['--dry-run', '--minimal'], ctx()));
  assert.ok(calls.some(l => l.includes('dry-run')));
  assert.strictEqual(fs.existsSync(path.join(projectDir, '.cues')), false);
});

// ─── Edge cases ────────────────────────────────────────────────────────────

test('edge: idempotent — re-running skips files that already exist, never overwrites', () => {
  silence(() => init(['--minimal'], ctx()));
  const cuesPath = path.join(projectDir, '.cues', 'CUES.md');
  fs.writeFileSync(cuesPath, 'MY CUSTOM CONTENT');

  const calls = silence(() => init(['--minimal'], ctx()));
  assert.strictEqual(fs.readFileSync(cuesPath, 'utf8'), 'MY CUSTOM CONTENT');
  assert.ok(calls.some(l => l.includes('SKIP (exists)')));
  assert.ok(calls.some(l => /skipped 4/.test(l) || l.includes('skipped') && l.includes('4')));
});

test('edge: partial pre-existing state — only missing files are created, existing ones untouched', () => {
  fs.mkdirSync(path.join(projectDir, '.cues'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.cues', 'CUES.md'), 'PRE-EXISTING');
  silence(() => init(['--minimal'], ctx()));
  assert.strictEqual(fs.readFileSync(path.join(projectDir, '.cues', 'CUES.md'), 'utf8'), 'PRE-EXISTING');
  assert.strictEqual(fs.readFileSync(path.join(projectDir, '.cues', 'BLANKS.md'), 'utf8'), '');
});

test('edge: running in a directory that already has unrelated files leaves them alone', () => {
  fs.writeFileSync(path.join(projectDir, 'unrelated.txt'), 'leave me be');
  silence(() => init(['--minimal'], ctx()));
  assert.strictEqual(fs.readFileSync(path.join(projectDir, 'unrelated.txt'), 'utf8'), 'leave me be');
  assert.strictEqual(fs.existsSync(path.join(projectDir, '.cues', 'CUES.md')), true);
});

// ─── Invalid input ─────────────────────────────────────────────────────────

test('invalid: unrecognised flags are ignored rather than rejected (forwards-compat, no throw)', () => {
  assert.doesNotThrow(() => silence(() => init(['--totally-not-a-real-flag', '--minimal'], ctx())));
  assert.strictEqual(fs.existsSync(path.join(projectDir, '.cues', 'CUES.md')), true);
});

test('invalid: --dry-run combined with --minimal still only prints, no writes', () => {
  const calls = silence(() => init(['--dry-run', '--minimal', '--bogus'], ctx()));
  assert.ok(calls.some(l => l.includes('[dry-run]')));
  assert.strictEqual(fs.existsSync(path.join(projectDir, '.cues')), false);
});
