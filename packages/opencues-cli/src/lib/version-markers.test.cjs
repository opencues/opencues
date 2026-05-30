// Tests for version markers — the dual-fork drift defense.
//
// What we test:
//   - writeMarker round-trips through readMarker
//   - checkDrift detects stale (runtime version mismatch)
//   - checkDrift detects stale (core version mismatch)
//   - checkDrift returns 'missing' when no marker
//   - checkDrift returns 'fresh' when versions match
//   - marker write doesn't crash if dir is unwritable (returns null)
//
// The pre-marker-era 'missing' case is important — existing installs
// won't have a marker. Doctor shouldn't yell at them as 'stale'; it
// should suggest re-running install to write the marker.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { writeMarker, readMarker, checkDrift } = require('./version-markers.cjs');

// Set up a fake REPO_ROOT with packages/opencues-{runtime,core}/package.json
// at known versions, so the source-comparison tests are deterministic.
function makeFakeRepoRoot(name, runtimeVer, coreVer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `oc-version-${name}-`));
  fs.mkdirSync(path.join(root, 'packages/opencues-runtime'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages/opencues-core'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'packages/opencues-runtime/package.json'),
    JSON.stringify({ name: '@opencues/runtime', version: runtimeVer }),
  );
  fs.writeFileSync(
    path.join(root, 'packages/opencues-core/package.json'),
    JSON.stringify({ name: '@opencues/core', version: coreVer }),
  );
  return root;
}

function freshMarkerDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `oc-marker-${name}-`));
}

test('writeMarker → readMarker round-trip', () => {
  const repoRoot = makeFakeRepoRoot('round-trip', '0.1.0', '0.1.0');
  const markerDir = freshMarkerDir('round-trip');
  const ctx = { pkg: { version: '0.1.5' }, REPO_ROOT: repoRoot };

  const written = writeMarker('claude-code', markerDir, ctx);
  assert.ok(written, 'writeMarker returns the marker data on success');
  assert.strictEqual(written.host, 'claude-code');
  assert.strictEqual(written.cli, '0.1.5');
  assert.strictEqual(written.runtime, '0.1.0');
  assert.strictEqual(written.core, '0.1.0');
  assert.ok(written.installedAt, 'installedAt is set');

  const read = readMarker(markerDir);
  assert.deepStrictEqual(read, written, 'read matches what was written');
});

test('checkDrift: fresh when versions match', () => {
  const repoRoot = makeFakeRepoRoot('fresh', '0.1.0', '0.1.0');
  const markerDir = freshMarkerDir('fresh');
  const ctx = { pkg: { version: '0.1.5' }, REPO_ROOT: repoRoot };
  writeMarker('claude-code', markerDir, ctx);

  const drift = checkDrift(markerDir, ctx);
  assert.strictEqual(drift.status, 'fresh');
});

test('checkDrift: stale when runtime version differs', () => {
  // Write a marker at runtime 0.1.0 / core 0.1.0...
  const repoRoot = makeFakeRepoRoot('stale-runtime-old', '0.1.0', '0.1.0');
  const markerDir = freshMarkerDir('stale-runtime');
  const ctx = { pkg: { version: '0.1.0' }, REPO_ROOT: repoRoot };
  writeMarker('claude-code', markerDir, ctx);

  // ...then bump runtime to 0.2.0 (source updated, marker stale).
  fs.writeFileSync(
    path.join(repoRoot, 'packages/opencues-runtime/package.json'),
    JSON.stringify({ name: '@opencues/runtime', version: '0.2.0' }),
  );

  const drift = checkDrift(markerDir, ctx);
  assert.strictEqual(drift.status, 'stale');
  assert.strictEqual(drift.marker.runtime, '0.1.0');
  assert.strictEqual(drift.source.runtime, '0.2.0');
});

test('checkDrift: stale when core version differs', () => {
  const repoRoot = makeFakeRepoRoot('stale-core', '0.1.0', '0.1.0');
  const markerDir = freshMarkerDir('stale-core');
  const ctx = { pkg: { version: '0.1.0' }, REPO_ROOT: repoRoot };
  writeMarker('opencode', markerDir, ctx);

  // Bump core.
  fs.writeFileSync(
    path.join(repoRoot, 'packages/opencues-core/package.json'),
    JSON.stringify({ name: '@opencues/core', version: '0.2.0' }),
  );

  const drift = checkDrift(markerDir, ctx);
  assert.strictEqual(drift.status, 'stale');
  assert.strictEqual(drift.marker.core, '0.1.0');
  assert.strictEqual(drift.source.core, '0.2.0');
});

test('checkDrift: missing when no marker', () => {
  const repoRoot = makeFakeRepoRoot('no-marker', '0.1.0', '0.1.0');
  const markerDir = freshMarkerDir('no-marker');
  const ctx = { pkg: { version: '0.1.0' }, REPO_ROOT: repoRoot };
  // No writeMarker call.
  const drift = checkDrift(markerDir, ctx);
  assert.strictEqual(drift.status, 'missing');
  assert.strictEqual(drift.marker, null);
});

test('writeMarker: unwritable dir returns null without throwing', () => {
  const repoRoot = makeFakeRepoRoot('unwritable', '0.1.0', '0.1.0');
  const ctx = { pkg: { version: '0.1.0' }, REPO_ROOT: repoRoot };
  // /dev/null/foo can't be created.
  const result = writeMarker('shell', '/dev/null/cannot-create-here', ctx);
  // Marker write failure must NOT throw — install can complete without
  // the marker (we lose drift detection but everything else works).
  assert.strictEqual(result, null);
});

test('checkDrift: works when CLI version was null at write time', () => {
  const repoRoot = makeFakeRepoRoot('null-cli', '0.1.0', '0.1.0');
  const markerDir = freshMarkerDir('null-cli');
  // No pkg.version available (extremely-old install).
  const ctx = { pkg: {}, REPO_ROOT: repoRoot };
  writeMarker('claude-code', markerDir, ctx);
  const drift = checkDrift(markerDir, ctx);
  // Runtime + core still compared on their own merits.
  assert.strictEqual(drift.status, 'fresh');
});
