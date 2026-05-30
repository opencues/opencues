'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { writeVendorMarker, readVendorMarker, checkVendorDrift, markerPath, vendorDir } = require('./vendor-pins.cjs');

function clean(tool) {
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
  // Force a write to a path that can't exist. Returns null, no throw.
  const origHome = process.env.HOME;
  process.env.HOME = '/dev/null/nope';
  try {
    const data = writeVendorMarker('tmux', '3.4');
    assert.strictEqual(data, null);
  } finally {
    process.env.HOME = origHome;
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
