'use strict';
// Tests for stage-runtime-deps.cjs — the staging step that keeps JS user
// blanks alive on the self-owned hosts (mac / apple-notes / shell).
//
// Regression pinned here: those hosts stage @opencues/{core,runtime} as
// dist-only copies, so the runtime's own acorn / acorn-walk were
// unresolvable and EVERY JS user blank failed to register with a warn
// (observed on mac 2026-07-26 — the shipped `gh-issues` blank died on both
// the in-process and subprocess paths with `Cannot find module 'acorn'`).
//
// Hermetic: every write goes to a mkdtemp dir; the real repo and the real
// $HOME are only ever READ. See check-test-hermeticity.sh / PR #41.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { stageRuntimeDeps, resolveDepDir, RUNTIME_DEPS } = require('./stage-runtime-deps.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('stage-runtime-deps', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stage-deps-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('resolves acorn from the workspace runtime package', () => {
    const dir = resolveDepDir('acorn', REPO_ROOT);
    assert.ok(dir, 'acorn must resolve from packages/opencues-runtime');
    // Must be the package ROOT (the dir holding acorn's own package.json),
    // not the .pnpm wrapper dir above it.
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(pj.name, 'acorn');
  });

  it('returns null for a dependency that does not exist', () => {
    assert.strictEqual(resolveDepDir('this-package-does-not-exist-xyz', REPO_ROOT), null);
  });

  it('stages the required deps as self-contained real dirs', () => {
    const dest = path.join(tmp, 'node_modules');
    const { staged } = stageRuntimeDeps({ REPO_ROOT, destNodeModules: dest });
    for (const { name, optional } of RUNTIME_DEPS) {
      if (optional && !staged.includes(name)) continue;
      const pkg = path.join(dest, name, 'package.json');
      assert.ok(fs.existsSync(pkg), `${name} staged`);
      // dereference — a symlink into the pnpm store breaks when it's pruned.
      assert.ok(!fs.lstatSync(path.join(dest, name)).isSymbolicLink(), `${name} is a real dir`);
    }
    assert.ok(staged.includes('acorn') && staged.includes('acorn-walk'));
  });

  it('the staged copy actually satisfies require() from a dist-only bundle', () => {
    // The real failure mode: resolution from the staged @opencues/runtime
    // path, which is what the user-blank loader does at runtime.
    const dest = path.join(tmp, 'node_modules');
    stageRuntimeDeps({ REPO_ROOT, destNodeModules: dest });
    const fakeRuntime = path.join(dest, '@opencues', 'runtime', 'dist', 'src', 'user-blanks');
    fs.mkdirSync(fakeRuntime, { recursive: true });
    const probe = path.join(fakeRuntime, 'probe.cjs');
    fs.writeFileSync(probe, "require('acorn'); require('acorn-walk'); console.log('ok');");
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `require from the staged bundle failed: ${r.stderr}`);
    assert.match(r.stdout, /ok/);
  });

  it('stages a dependency\'s OWN dependencies (isolated-vm → node-gyp-build)', () => {
    // A flat one-package copy left isolated-vm unable to load its prebuilt
    // binary: `Cannot find module 'node-gyp-build'` (2026-07-26, the second
    // failure found after fixing acorn).
    const dest = path.join(tmp, 'nm-tree');
    const { staged } = stageRuntimeDeps({ REPO_ROOT, destNodeModules: dest });
    if (!staged.includes('isolated-vm')) return; // optional dep absent — nothing to assert
    const ivmDeps = JSON.parse(
      fs.readFileSync(path.join(dest, 'isolated-vm', 'package.json'), 'utf8'),
    ).dependencies ?? {};
    for (const child of Object.keys(ivmDeps)) {
      assert.ok(
        fs.existsSync(path.join(dest, child, 'package.json')),
        `isolated-vm's dependency ${child} must be staged beside it`,
      );
    }
  });

  it('is idempotent — restaging over an existing copy succeeds', () => {
    const dest = path.join(tmp, 'nm-idem');
    stageRuntimeDeps({ REPO_ROOT, destNodeModules: dest });
    const first = fs.readdirSync(path.join(dest, 'acorn')).length;
    stageRuntimeDeps({ REPO_ROOT, destNodeModules: dest });
    assert.strictEqual(fs.readdirSync(path.join(dest, 'acorn')).length, first);
  });

  it('throws (never silently ships) when a REQUIRED dep cannot be resolved', () => {
    // MUST live outside `tmp`: earlier cases stage into `tmp/node_modules`,
    // and Node's resolution walks UP — a bogus repo nested inside `tmp`
    // would resolve acorn from that staged copy and never throw.
    const bogusRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stage-bogus-'));
    after(() => fs.rmSync(bogusRoot, { recursive: true, force: true }));
    const bogusRepo = path.join(bogusRoot, 'empty-repo');
    fs.mkdirSync(path.join(bogusRepo, 'packages', 'opencues-runtime'), { recursive: true });
    assert.throws(
      () => stageRuntimeDeps({ REPO_ROOT: bogusRepo, destNodeModules: path.join(bogusRoot, 'nm') }),
      /required dependency "acorn"/,
    );
  });
});
