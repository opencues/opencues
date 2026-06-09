// Tests for `opencues doctor`'s F9 sandbox-status helper (INFOSEC F9).
//
// Pins the unwrapped-by-default footgun visibility: when scripted
// blanks are installed without `sandbox: strict`, doctor must count
// them so users see the exposure.

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { _internal } = require('./doctor.cjs');
const { scanScriptedBlanks } = _internal;

let tmpHome;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-scan-'));
});

after(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function writeBlank(name, frontmatter) {
  const dir = path.join(tmpHome, '.cues', 'blanks', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BLANK.md'), `---\n${frontmatter}\n---\n\n# ${name}\n`);
}

test('F9: counts scripted blanks with sandbox: strict separately from unconfined', () => {
  writeBlank('volume', 'name: volume\nblankScript: ./vol.sh\nsandbox: strict');
  writeBlank('brightness', 'name: brightness\nblankScript: ./b.sh');
  writeBlank('weather', 'name: weather'); // not scripted — should be ignored
  writeBlank('risky', 'name: risky\nblankScript: ./r.sh\nsandbox: off');
  const r = scanScriptedBlanks(tmpHome);
  assert.strictEqual(r.total, 3, 'should count 3 scripted blanks (volume, brightness, risky)');
  assert.strictEqual(r.strict, 1, 'only volume has sandbox: strict');
  assert.deepStrictEqual(r.unstrictPaths.sort(), ['brightness', 'risky']);
});

test('F9: no scripted blanks → zero totals', () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-empty-'));
  try {
    const r = scanScriptedBlanks(emptyHome);
    assert.strictEqual(r.total, 0);
    assert.strictEqual(r.strict, 0);
    assert.deepStrictEqual(r.unstrictPaths, []);
  } finally {
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('F9: ignores BLANK.md files without `blankScript:` (built-in TS blanks)', () => {
  const tsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-ts-'));
  try {
    const dir = path.join(tsHome, '.cues', 'blanks', 'answer');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BLANK.md'), '---\nname: answer\nimpl: AnswerBlank\n---\n');
    const r = scanScriptedBlanks(tsHome);
    assert.strictEqual(r.total, 0, 'built-in TS blank should not be counted as scripted');
  } finally {
    fs.rmSync(tsHome, { recursive: true, force: true });
  }
});

test('F9: malformed frontmatter is silently skipped (best-effort)', () => {
  const wonkyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-wonky-'));
  try {
    const dir = path.join(wonkyHome, '.cues', 'blanks', 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BLANK.md'), 'no frontmatter here at all');
    const r = scanScriptedBlanks(wonkyHome);
    assert.strictEqual(r.total, 0);
  } finally {
    fs.rmSync(wonkyHome, { recursive: true, force: true });
  }
});
