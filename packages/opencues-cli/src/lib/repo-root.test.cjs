// Tests for repo-root — the standalone-CLI repo resolution + fetch ladder.
//
// HERMETIC: every test runs with HOME redirected into a mkdtemp dir (so
// ~/.opencues/repo never touches the real user home — the PR #41 rule) and
// fetches from a local file:// fixture repo via OPENCUES_REPO_URL (no
// network). Requires `git` on PATH (same as CI).

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const repoRoot = require('./repo-root.cjs');

const REAL_HOME = process.env.HOME;
const REAL_URL = process.env.OPENCUES_REPO_URL;

let tmp;           // per-run scratch root
let fixtureRepo;   // local "upstream" git repo (file:// clone source)

function git(cwd, cmd) {
  execSync(`git ${cmd}`, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

// Minimal tree that satisfies isRepoRoot. Includes a fake node_modules +
// built core dist so clones of the fixture arrive "bootstrapped" —
// bootstrapRepo no-ops and tests never invoke real pnpm (its decision
// logic is unit-tested separately with a stubbed runner below).
function writeRepoMarkers(dir) {
  fs.mkdirSync(path.join(dir, 'packages', 'opencues-core', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  fs.writeFileSync(path.join(dir, 'packages', 'opencues-core', 'package.json'), '{"name":"@opencues/core"}\n');
  fs.writeFileSync(path.join(dir, 'packages', 'opencues-core', 'dist', 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(dir, 'node_modules', '.keep'), '');
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-root-'));

  // Build the local "upstream": a real git repo with a v9.9.9 tag.
  fixtureRepo = path.join(tmp, 'upstream');
  fs.mkdirSync(fixtureRepo, { recursive: true });
  writeRepoMarkers(fixtureRepo);
  git(fixtureRepo, 'init -q');                      // -b needs git 2.28+; stay portable
  git(fixtureRepo, 'checkout -q -b main');
  git(fixtureRepo, 'add -A');
  git(fixtureRepo, 'commit -q -m fixture');
  git(fixtureRepo, 'tag v9.9.9');
});

after(() => {
  process.env.HOME = REAL_HOME;
  if (REAL_URL === undefined) delete process.env.OPENCUES_REPO_URL;
  else process.env.OPENCUES_REPO_URL = REAL_URL;
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh fake HOME per test — hermetic ~/.opencues.
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  process.env.HOME = home;
  process.env.OPENCUES_REPO_URL = `file://${fixtureRepo}`;
  delete process.env.OPENCUES_REPO;
});

describe('isRepoRoot', () => {
  it('true for a dir with workspace manifest + core package', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'r-'));
    writeRepoMarkers(d);
    assert.strictEqual(repoRoot.isRepoRoot(d), true);
  });
  it('false for an empty dir and a missing dir', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'e-'));
    assert.strictEqual(repoRoot.isRepoRoot(d), false);
    assert.strictEqual(repoRoot.isRepoRoot(path.join(d, 'nope')), false);
  });
});

describe('resolveRepoRoot ladder', () => {
  it('1: detects the clone containing the CLI package (dev mode)', () => {
    const clone = fs.mkdtempSync(path.join(tmp, 'clone-'));
    writeRepoMarkers(clone);
    const pkgDir = path.join(clone, 'packages', 'opencues-cli');
    fs.mkdirSync(pkgDir, { recursive: true });
    const r = repoRoot.resolveRepoRoot(pkgDir);
    assert.strictEqual(r.source, 'clone');
    assert.strictEqual(fs.realpathSync(r.root), fs.realpathSync(clone));
  });

  it('2: $OPENCUES_REPO override wins when valid, is ignored when invalid', () => {
    const standalone = fs.mkdtempSync(path.join(tmp, 'pkg-')); // NOT inside a repo
    const envRepo = fs.mkdtempSync(path.join(tmp, 'env-'));
    writeRepoMarkers(envRepo);
    process.env.OPENCUES_REPO = envRepo;
    assert.deepStrictEqual(repoRoot.resolveRepoRoot(standalone), { root: envRepo, source: 'env' });

    process.env.OPENCUES_REPO = path.join(tmp, 'not-a-repo');
    assert.strictEqual(repoRoot.resolveRepoRoot(standalone).source, null);
  });

  it('3: falls back to ~/.opencues/repo when present', () => {
    const standalone = fs.mkdtempSync(path.join(tmp, 'pkg-'));
    const home = repoRoot.homeRepoDir();
    fs.mkdirSync(home, { recursive: true });
    writeRepoMarkers(home);
    const r = repoRoot.resolveRepoRoot(standalone);
    assert.strictEqual(r.source, 'home');
    assert.strictEqual(r.root, home);
  });

  it('4: none found → { root: null }', () => {
    const standalone = fs.mkdtempSync(path.join(tmp, 'pkg-'));
    assert.deepStrictEqual(repoRoot.resolveRepoRoot(standalone), { root: null, source: null });
  });
});

describe('fetchRepo', () => {
  it('clones the version tag into ~/.opencues/repo', () => {
    const dest = repoRoot.fetchRepo('9.9.9', { log: () => {} });
    assert.strictEqual(dest, repoRoot.homeRepoDir());
    assert.ok(repoRoot.isRepoRoot(dest));
    const tag = execSync('git describe --tags', { cwd: dest, encoding: 'utf8' }).trim();
    assert.strictEqual(tag, 'v9.9.9');
  });

  it('falls back to the default branch when the tag is missing (dev builds)', () => {
    const warnings = [];
    const dest = repoRoot.fetchRepo('0.0.0-nope', { log: (m) => warnings.push(m) });
    assert.ok(repoRoot.isRepoRoot(dest));
    assert.ok(warnings.some(w => /tag v0\.0\.0-nope not found/.test(w)), `expected fallback warning, got: ${warnings.join(' | ')}`);
  });

  it('clears a half-clone left by an interrupted run', () => {
    const dest = repoRoot.homeRepoDir();
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'debris.txt'), 'interrupted');
    const out = repoRoot.fetchRepo('9.9.9', { log: () => {} });
    assert.ok(repoRoot.isRepoRoot(out));
    assert.ok(!fs.existsSync(path.join(out, 'debris.txt')));
  });

  it('fails with a user-ready message when the clone fails', () => {
    process.env.OPENCUES_REPO_URL = `file://${path.join(tmp, 'no-such-upstream')}`;
    assert.throws(
      () => repoRoot.fetchRepo('9.9.9', { log: () => {} }),
      (err) => /git clone failed|clone manually/.test(err.message),
    );
  });
});

describe('ensureRepoRoot', () => {
  it('returns an existing root without fetching', () => {
    const clone = fs.mkdtempSync(path.join(tmp, 'clone-'));
    writeRepoMarkers(clone);
    const pkgDir = path.join(clone, 'packages', 'opencues-cli');
    fs.mkdirSync(pkgDir, { recursive: true });
    process.env.OPENCUES_REPO_URL = `file://${path.join(tmp, 'no-such-upstream')}`; // would fail if fetched
    assert.strictEqual(fs.realpathSync(repoRoot.ensureRepoRoot(pkgDir, '9.9.9', { log: () => {} })), fs.realpathSync(clone));
  });

  it('fetches when nothing is found', () => {
    const standalone = fs.mkdtempSync(path.join(tmp, 'pkg-'));
    const root = repoRoot.ensureRepoRoot(standalone, '9.9.9', { log: () => {} });
    assert.strictEqual(root, repoRoot.homeRepoDir());
    assert.ok(repoRoot.isRepoRoot(root));
  });
});

describe('bootstrapRepo (stubbed runner — decision logic only)', () => {
  function repoWith({ deps, dist }) {
    const d = fs.mkdtempSync(path.join(tmp, 'boot-'));
    writeRepoMarkers(d);
    if (!deps) fs.rmSync(path.join(d, 'node_modules'), { recursive: true });
    if (!dist) fs.rmSync(path.join(d, 'packages', 'opencues-core', 'dist'), { recursive: true });
    return d;
  }
  const okRun = (calls) => (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; };

  it('no-ops when deps + core dist are present', () => {
    const calls = [];
    repoRoot.bootstrapRepo(repoWith({ deps: true, dist: true }), { log: () => {}, run: okRun(calls) });
    assert.deepStrictEqual(calls, []);
  });

  it('installs deps and builds core when both are missing', () => {
    const calls = [];
    repoRoot.bootstrapRepo(repoWith({ deps: false, dist: false }), { log: () => {}, run: okRun(calls) });
    assert.ok(calls.some(c => c.join(' ') === 'pnpm --version'));
    assert.ok(calls.some(c => c.join(' ') === 'pnpm install'));
    assert.ok(calls.some(c => c.join(' ') === 'pnpm run build'));
  });

  it('builds core only when deps are already present', () => {
    const calls = [];
    repoRoot.bootstrapRepo(repoWith({ deps: true, dist: false }), { log: () => {}, run: okRun(calls) });
    assert.ok(!calls.some(c => c.join(' ') === 'pnpm install'));
    assert.ok(calls.some(c => c.join(' ') === 'pnpm run build'));
  });

  it('falls back to corepack when pnpm is absent', () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: cmd === 'pnpm' ? 1 : 0 };  // no pnpm; corepack works
    };
    repoRoot.bootstrapRepo(repoWith({ deps: false, dist: false }), { log: () => {}, run });
    assert.ok(calls.some(c => c.join(' ') === 'corepack pnpm install'));
  });

  it('throws a user-ready message when neither pnpm nor corepack exists', () => {
    const run = () => ({ status: 1 });
    assert.throws(
      () => repoRoot.bootstrapRepo(repoWith({ deps: false, dist: false }), { log: () => {}, run }),
      (err) => /corepack enable pnpm|npm install -g pnpm/.test(err.message),
    );
  });
});

describe('cli dispatch gate (bin/cli.cjs, standalone copy)', () => {
  // Copy the CLI package OUTSIDE the repo — from inside the clone the
  // ladder resolves at step 1 and the gate never fires. This simulates a
  // global `npm i -g opencues` install layout.
  const { spawnSync } = require('node:child_process');
  let standaloneCli;

  before(() => {
    const dir = path.join(tmp, 'global-install', 'node_modules', 'opencues');
    const src = path.resolve(__dirname, '..', '..');
    fs.mkdirSync(dir, { recursive: true });
    for (const piece of ['bin', 'src', 'package.json']) {
      fs.cpSync(path.join(src, piece), path.join(dir, piece), { recursive: true });
    }
    standaloneCli = path.join(dir, 'bin', 'cli.cjs');
  });

  it('light command (help) works repo-less and never clones', () => {
    const r = spawnSync('node', [standaloneCli, 'help'], { encoding: 'utf8', env: { ...process.env } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok((r.stdout || '').length > 0);
    assert.ok(!fs.existsSync(repoRoot.homeRepoDir()), 'help must not trigger a repo fetch');
  });

  it('repo-needing command triggers the fetch (pinned tag) before running', () => {
    // `validate` is repo-needing; the command itself may exit non-zero
    // against the marker-only fixture — the contract under test is that
    // the repo LANDS first (runtime behaviour is the command's own concern).
    const env = { ...process.env, OPENCUES_NO_INTERACTIVE: '1' };
    spawnSync('node', [standaloneCli, 'validate'], { encoding: 'utf8', env, timeout: 30000 });
    assert.ok(repoRoot.isRepoRoot(repoRoot.homeRepoDir()), 'expected ~/.opencues/repo to be fetched');
  });
});
