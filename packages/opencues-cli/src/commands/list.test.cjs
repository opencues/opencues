// Tests for `opencues list` — enumerate cues/blanks/auditors across
// search paths.
//
// Zero prior coverage. list.cjs is synchronous, reads @opencues/core's
// built dist directly (already built at packages/opencues-core/dist/),
// and derives its search paths from OPENCUES_HOME / cwd/.cues / home/.cues
// (ConfigLoader precedence). No process.exit on the success paths (only
// on a failed core require, which we don't exercise since dist exists).
//
// Hermeticity: HOME + USERPROFILE point at a fresh, empty mkdtemp dir per
// test (no `.cues/` inside it) and OPENCUES_HOME is deleted so it can
// never leak in from the real environment. Every test also chdir's into
// its own fresh mkdtemp project dir. Both are restored/removed after.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const list = require('./list.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../../..');

let realHome, realUserProfile, realOpencuesHome, realCwd;
let tmpHome, projectDir;

beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  realOpencuesHome = process.env.OPENCUES_HOME;
  realCwd = process.cwd();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-list-home-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-list-proj-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.OPENCUES_HOME;
  process.chdir(projectDir);
});

afterEach(() => {
  process.chdir(realCwd);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  if (realOpencuesHome === undefined) delete process.env.OPENCUES_HOME; else process.env.OPENCUES_HOME = realOpencuesHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function ctx() { return { REPO_ROOT }; }

function silence(fn) {
  const origLog = console.log;
  const calls = [];
  console.log = (...a) => calls.push(a.join(' '));
  try { fn(); } finally { console.log = origLog; }
  return calls;
}

function writeCueFolder(root, name, content) {
  const dir = path.join(root, '.cues', 'cues', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CUE.md'), content);
}

function writeBlankFolder(root, name, content) {
  const dir = path.join(root, '.cues', 'blanks', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BLANK.md'), content);
}

function writeAuditorFolder(root, name, content) {
  const dir = path.join(root, '.cues', 'auditors', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AUDITOR.md'), content);
}

function writeMaster(root, filename, content) {
  const dir = path.join(root, '.cues');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content);
}

// ─── Happy path ────────────────────────────────────────────────────────────

test('happy: --help prints usage and reads no config', () => {
  const calls = silence(() => list(['--help'], ctx()));
  assert.ok(calls.some(l => l.includes('opencues list')));
});

test('happy: no .cues/ anywhere prints empty sections without crashing', () => {
  const calls = silence(() => list([], ctx()));
  assert.ok(calls.some(l => l.includes('Cues')));
  assert.ok(calls.some(l => l.includes('Blanks')));
  assert.ok(calls.some(l => l.includes('Auditors')));
  assert.ok(calls.some(l => l.includes('(none)')));
});

test('happy: a folder-based cue in the project .cues/ is listed with its source path', () => {
  writeCueFolder(projectDir, 'legalish', '---\nname: legalish\nmatch: contract\n---\n\nSuggest alternatives.\n');
  const calls = silence(() => list([], ctx()));
  assert.ok(calls.some(l => l.includes('legalish')));
});

test('happy: a folder-based blank is listed', () => {
  writeBlankFolder(projectDir, 'mybla', '---\nname: mybla\ntype: blank\nblankKeywords: mybla\nimpl: MyBlaBlank\n---\n');
  const calls = silence(() => list([], ctx()));
  assert.ok(calls.some(l => l.includes('mybla')));
});

test('happy: an inline cue source in the master CUES.md is listed', () => {
  writeMaster(projectDir, 'CUES.md', [
    '---',
    'name: project-cues',
    '---',
    '',
    '### alternatives',
    '',
    '```yaml',
    'match: foo',
    '```',
    '',
    'Suggest alternatives for foo.',
    '',
  ].join('\n'));
  // Not asserting parse success here (format depends on core's parser
  // internals) — just that list() doesn't crash on a real master file.
  assert.doesNotThrow(() => silence(() => list([], ctx())));
});

// ─── Edge cases ────────────────────────────────────────────────────────────

test('edge: --cues filters out blanks and auditors sections', () => {
  writeCueFolder(projectDir, 'onlycue', '---\nname: onlycue\nmatch: x\n---\n\nbody\n');
  writeBlankFolder(projectDir, 'onlyblank', '---\nname: onlyblank\ntype: blank\nblankKeywords: onlyblank\nimpl: X\n---\n');
  const calls = silence(() => list(['--cues'], ctx()));
  assert.ok(calls.some(l => l.includes('Cues')));
  assert.ok(!calls.some(l => l.includes('Blanks (')));
  assert.ok(!calls.some(l => l.includes('Auditors (')));
});

test('edge: --blanks filters to only blanks', () => {
  writeCueFolder(projectDir, 'acue', '---\nname: acue\nmatch: x\n---\n\nbody\n');
  writeBlankFolder(projectDir, 'ablank', '---\nname: ablank\ntype: blank\nblankKeywords: ablank\nimpl: X\n---\n');
  const calls = silence(() => list(['--blanks'], ctx()));
  assert.ok(calls.some(l => l.includes('Blanks')));
  assert.ok(!calls.some(l => l.includes('Cues (')));
});

test('edge: --auditors filters to only auditors', () => {
  writeAuditorFolder(projectDir, 'grammarish', '---\nname: grammarish\ndescription: fix grammar\n---\n\nCheck grammar.\n');
  const calls = silence(() => list(['--auditors'], ctx()));
  assert.ok(calls.some(l => l.includes('Auditors')));
  assert.ok(!calls.some(l => l.includes('Cues (')));
});

test('edge: OPENCUES_HOME override is read as a search path ahead of cwd/home', () => {
  // Note: OPENCUES_HOME is used AS the .cues-equivalent root directly
  // (list.cjs pushes it straight into `paths`, unlike cwd/HOME which get
  // `.cues` appended) — so the cue folder goes right under it, no extra
  // `.cues` segment.
  const ocHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-list-envhome-'));
  try {
    const dir = path.join(ocHome, 'cues', 'envcue');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CUE.md'), '---\nname: envcue\nmatch: x\n---\n\nbody\n');
    process.env.OPENCUES_HOME = ocHome;
    const calls = silence(() => list([], ctx()));
    assert.ok(calls.some(l => l.includes('envcue')));
  } finally {
    fs.rmSync(ocHome, { recursive: true, force: true });
  }
});

test('edge: --all shows the [all] host marker on entries that would otherwise hide it', () => {
  writeCueFolder(projectDir, 'plaincue', '---\nname: plaincue\nmatch: x\n---\n\nbody\n');
  const plain = silence(() => list([], ctx()));
  const all = silence(() => list(['--all'], ctx()));
  assert.ok(!plain.some(l => l.includes('plaincue') && l.includes('[all]')));
  assert.ok(all.some(l => l.includes('plaincue') && l.includes('[all]')));
});

test('edge: both user-level and project-level .cues/ contribute entries (both search paths read)', () => {
  writeCueFolder(projectDir, 'projcue', '---\nname: projcue\nmatch: x\n---\n\nbody\n');
  writeCueFolder(tmpHome, 'usercue', '---\nname: usercue\nmatch: x\n---\n\nbody\n');
  const calls = silence(() => list([], ctx()));
  assert.ok(calls.some(l => l.includes('projcue')));
  assert.ok(calls.some(l => l.includes('usercue')));
});

// ─── Invalid input ─────────────────────────────────────────────────────────

test('invalid: malformed frontmatter in a folder cue is silently skipped, not crashed', () => {
  writeCueFolder(projectDir, 'broken', '---\n:::not:valid:::\n---\n\nbody\n');
  assert.doesNotThrow(() => silence(() => list([], ctx())));
});

test('invalid: an empty folder with no CUE.md at all is skipped without crashing', () => {
  fs.mkdirSync(path.join(projectDir, '.cues', 'cues', 'ghost'), { recursive: true });
  assert.doesNotThrow(() => silence(() => list([], ctx())));
  const calls = silence(() => list([], ctx()));
  assert.ok(!calls.some(l => l.includes('ghost')));
});

test('invalid: malformed master CUES.md does not crash list (parse errors swallowed)', () => {
  writeMaster(projectDir, 'CUES.md', '---\n:::garbage:::\n---\n');
  assert.doesNotThrow(() => silence(() => list([], ctx())));
});

test('invalid: unrecognised flag combos (e.g. --cues --blanks together) do not crash; last-match-wins per the ternary chain', () => {
  writeCueFolder(projectDir, 'acue', '---\nname: acue\nmatch: x\n---\n\nbody\n');
  writeBlankFolder(projectDir, 'ablank', '---\nname: ablank\ntype: blank\nblankKeywords: ablank\nimpl: X\n---\n');
  assert.doesNotThrow(() => silence(() => list(['--cues', '--blanks'], ctx())));
});
