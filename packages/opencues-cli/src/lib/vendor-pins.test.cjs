'use strict';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { writeVendorMarker, readVendorMarker, checkVendorDrift, markerPath, vendorDir } = require('./vendor-pins.cjs');

// HERMETICITY ─────────────────────────────────────────────────────────
// Every helper in vendor-pins.cjs resolves paths via `os.homedir()`,
// which reads `process.env.HOME`. The tests below mutate
// `~/.opencues/vendor/<tool>/` — if they ran against the real $HOME
// they would (and historically DID) silently delete the user's
// vendored tmux / bun directories on every `pnpm test` run.
//
// Symptom that pinned this: running `pnpm test` in opencues-cli would
// `rm -rf ~/.opencues/vendor/tmux/` six times, then a later
// `opencues run shell` would fall through to /usr/bin/tmux 3.0 and
// fail the >= 3.2 version check. The vendor binary was being
// destroyed by the test that's supposed to verify the marker code
// works.
//
// Fix: redirect `$HOME` to a per-test-file tempdir for the whole
// suite. `os.homedir()` reads HOME on every call (it's not cached),
// so this works even though vendor-pins.cjs was required before the
// override. The original HOME is restored at the end.
const ORIGINAL_HOME = process.env.HOME;
let SANDBOX_HOME = '';

before(() => {
  SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-vendor-pins-test-'));
  process.env.HOME = SANDBOX_HOME;
});

after(() => {
  process.env.HOME = ORIGINAL_HOME;
  try { fs.rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Per-test cleanup — drop ~/<sandbox>/.opencues so each test starts
// from an empty slate. Safe now because `~` is the sandboxed tempdir,
// not the real user's home.
beforeEach(() => {
  try {
    fs.rmSync(path.join(SANDBOX_HOME, '.opencues'), { recursive: true, force: true });
  } catch { /* ignore */ }
});

function clean(tool) {
  // Belt-and-braces: this still resolves to the sandboxed HOME because
  // os.homedir() reads $HOME on every call. Kept inline so the tests'
  // intent ("start from a clean per-tool slate") stays readable.
  try { fs.rmSync(vendorDir(tool), { recursive: true, force: true }); } catch {}
}

test('write → read round-trip', () => {
  clean('tmux');
  const data = writeVendorMarker('tmux', '3.4');
  assert.strictEqual(data.tool, 'tmux');
  assert.strictEqual(data.version, '3.4');
  const read = readVendorMarker('tmux');
  assert.deepStrictEqual(read, data);
  clean('tmux');
});

test('checkVendorDrift: fresh when version matches pin', () => {
  clean('tmux');
  writeVendorMarker('tmux', '3.4');
  const drift = checkVendorDrift('tmux');
  assert.strictEqual(drift.status, 'fresh');
  clean('tmux');
});

test('checkVendorDrift: stale when version differs from pin', () => {
  clean('tmux');
  writeVendorMarker('tmux', '3.3');
  const drift = checkVendorDrift('tmux');
  assert.strictEqual(drift.status, 'stale');
  assert.strictEqual(drift.marker.version, '3.3');
  assert.strictEqual(drift.expected, '3.4');
  clean('tmux');
});

test('checkVendorDrift: missing with no binary', () => {
  clean('tmux');
  const drift = checkVendorDrift('tmux');
  assert.strictEqual(drift.status, 'missing');
  assert.strictEqual(drift.binaryPresent, false);
});

test('checkVendorDrift: missing-marker but binary present (pre-marker install)', () => {
  clean('tmux');
  const binDir = path.join(vendorDir('tmux'), 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'tmux'), '#!/bin/sh\necho fake', { mode: 0o755 });
  const drift = checkVendorDrift('tmux');
  assert.strictEqual(drift.status, 'missing');
  assert.strictEqual(drift.binaryPresent, true);
  clean('tmux');
});

test("checkVendorDrift: bun with wildcard '*' pin treats any version as fresh", () => {
  clean('bun');
  writeVendorMarker('bun', '1.2.3');
  const drift = checkVendorDrift('bun');
  // bun's pin is currently '*' (no version requirement). Any installed
  // version counts as fresh.
  assert.strictEqual(drift.status, 'fresh');
  assert.strictEqual(drift.expected, '*');
  clean('bun');
});

test('writeVendorMarker: silent failure on unwritable target', () => {
  // Override the sandboxed HOME to an un-writable path for the
  // duration of this one test. Restored before the next test runs.
  const sandboxHome = process.env.HOME;
  process.env.HOME = '/dev/null/nope';
  try {
    const data = writeVendorMarker('tmux', '3.4');
    assert.strictEqual(data, null);
  } finally {
    process.env.HOME = sandboxHome;
  }
});

test('readVendorMarker: corrupted JSON returns null', () => {
  clean('tmux');
  fs.mkdirSync(vendorDir('tmux'), { recursive: true });
  fs.writeFileSync(markerPath('tmux'), 'not valid json');
  const read = readVendorMarker('tmux');
  assert.strictEqual(read, null);
  clean('tmux');
});
