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

// ──────────────────────────────────────────────────────────────────
// srcHash — load-bearing drift signal that catches source changes
// even when developers forget to bump package.json versions. The
// scenario that motivated this whole layer: PRs #37 / #38 / #39 /
// #40 landed runtime + CLI source changes without bumping versions,
// so version-string drift detection would have been blind. srcHash
// fires regardless.
// ──────────────────────────────────────────────────────────────────

function makeFakeRepoWithSrc(name, srcFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `oc-srchash-${name}-`));
  for (const dir of ['packages/opencues-runtime/src', 'packages/opencues-core/src']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, 'packages/opencues-runtime/package.json'),
    JSON.stringify({ name: '@opencues/runtime', version: '0.1.0' }),
  );
  fs.writeFileSync(
    path.join(root, 'packages/opencues-core/package.json'),
    JSON.stringify({ name: '@opencues/core', version: '0.1.0' }),
  );
  for (const [relPath, content] of Object.entries(srcFiles)) {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

test('writeMarker: records srcHash of the bundled source tree', () => {
  const repoRoot = makeFakeRepoWithSrc('write-hash', {
    'packages/opencues-runtime/src/index.ts': 'export const X = 1;',
    'packages/opencues-core/src/index.ts': 'export const Y = 2;',
  });
  const markerDir = freshMarkerDir('write-hash');
  const ctx = { pkg: { version: '0.1.0' }, REPO_ROOT: repoRoot };
  const written = writeMarker('claude-code', markerDir, ctx);
  assert.ok(written.srcHash, 'srcHash field populated');
  assert.strictEqual(typeof written.srcHash, 'string');
  assert.strictEqual(written.srcHash.length, 16, 'srcHash is the 16-char hex prefix');
});

test('checkDrift: stale when src changes without a version bump', () => {
  const repoRoot = makeFakeRepoWithSrc('srchash-drift', {
    'packages/opencues-runtime/src/index.ts': 'export const X = 1;',
    'packages/opencues-core/src/index.ts': 'export const Y = 2;',
  });
  const markerDir = freshMarkerDir('srchash-drift');
  const ctx = { pkg: { version: '0.1.0' }, REPO_ROOT: repoRoot };
  writeMarker('claude-code', markerDir, ctx);

  // Mutate runtime source WITHOUT touching package.json. This is the
  // failure mode the version-string check is blind to.
  fs.writeFileSync(
    path.join(repoRoot, 'packages/opencues-runtime/src/index.ts'),
    'export const X = 999;',
  );
  const drift = checkDrift(markerDir, ctx);
  assert.strictEqual(drift.status, 'stale');
  assert.strictEqual(drift.reason, 'srcHash');
  assert.notStrictEqual(drift.marker.srcHash, drift.sourceHash);
});

test('checkDrift: reason field names whichever check fired', () => {
  // Version drift only — no src change.
  const repoRoot = makeFakeRepoWithSrc('reason-version', {
    'packages/opencues-runtime/src/index.ts': 'const X = 1;',
    'packages/opencues-core/src/index.ts': 'const Y = 2;',
  });
  const markerDir = freshMarkerDir('reason-version');
  const ctx = { pkg: { version: '0.1.0' }, REPO_ROOT: repoRoot };
  writeMarker('claude-code', markerDir, ctx);
  // Bump core version, leave src untouched.
  fs.writeFileSync(
    path.join(repoRoot, 'packages/opencues-core/package.json'),
    JSON.stringify({ name: '@opencues/core', version: '0.2.0' }),
  );
  const drift = checkDrift(markerDir, ctx);
  assert.strictEqual(drift.status, 'stale');
  assert.strictEqual(drift.reason, 'core');
});

test('checkDrift: fresh when neither srcHash nor versions change', () => {
  const repoRoot = makeFakeRepoWithSrc('fresh-hash', {
    'packages/opencues-runtime/src/a.ts': 'const A = 1;',
    'packages/opencues-runtime/src/b.ts': 'const B = 2;',
    'packages/opencues-core/src/c.ts': 'const C = 3;',
  });
  const markerDir = freshMarkerDir('fresh-hash');
  const ctx = { pkg: { version: '0.1.0' }, REPO_ROOT: repoRoot };
  writeMarker('claude-code', markerDir, ctx);
  const drift = checkDrift(markerDir, ctx);
  assert.strictEqual(drift.status, 'fresh');
  assert.strictEqual(drift.reason, 'match');
});

test('checkDrift: srcHash ignores dist/, node_modules/, .cache/', () => {
  // These dirs ship build output / vendored deps which legitimately
  // change without being source edits. They mustn't trigger drift.
  const repoRoot = makeFakeRepoWithSrc('ignored-dirs', {
    'packages/opencues-runtime/src/index.ts': 'const X = 1;',
    'packages/opencues-core/src/index.ts': 'const Y = 2;',
  });
  const markerDir = freshMarkerDir('ignored-dirs');
  const ctx = { pkg: { version: '0.1.0' }, REPO_ROOT: repoRoot };
  writeMarker('claude-code', markerDir, ctx);
  // Drop "build output" + "node_modules" inside src/ — should be
  // walked-around, not hashed.
  fs.mkdirSync(path.join(repoRoot, 'packages/opencues-runtime/src/dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'packages/opencues-runtime/src/dist/built.js'), 'this should not affect drift');
  fs.mkdirSync(path.join(repoRoot, 'packages/opencues-core/src/node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'packages/opencues-core/src/node_modules/x/pkg.json'), '{}');
  const drift = checkDrift(markerDir, ctx);
  assert.strictEqual(drift.status, 'fresh');
});

test('checkDrift: deterministic across traversal orders', () => {
  // Hash mustn't depend on the order the filesystem hands files back —
  // otherwise two machines could compute different hashes for
  // identical source trees and trigger false-positive rebuilds.
  // Hard to assert directly without simulating fs ordering, but a
  // smoke test: hash twice in a row, expect identical results.
  const repoRoot = makeFakeRepoWithSrc('determinism', {
    'packages/opencues-runtime/src/a.ts': 'const A = 1;',
    'packages/opencues-runtime/src/sub/b.ts': 'const B = 2;',
    'packages/opencues-runtime/src/sub/sub2/c.ts': 'const C = 3;',
    'packages/opencues-core/src/x.ts': 'const X = 1;',
  });
  const markerDir = freshMarkerDir('determinism');
  const ctx = { pkg: { version: '0.1.0' }, REPO_ROOT: repoRoot };
  const m1 = writeMarker('claude-code', markerDir, ctx);
  // Rewrite the marker — second hash should match.
  const m2 = writeMarker('claude-code', markerDir, ctx);
  assert.strictEqual(m1.srcHash, m2.srcHash);
});
