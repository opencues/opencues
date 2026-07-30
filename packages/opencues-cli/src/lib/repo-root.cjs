// repo-root — resolve (and, when needed, fetch) the OpenCues repo the CLI
// drives.
//
// The CLI historically assumed it lived INSIDE the repo (`REPO_ROOT =
// <pkg>/../..`), which is true for clone/dev installs (`pnpm exec opencues`)
// but nonsense for a global `npm i -g opencues`. This module makes both work:
//
//   resolution ladder (first hit wins):
//     1. clone   — the CLI package physically sits inside a repo checkout
//                  (dev / from-clone installs; the pre-Stage-8 behaviour).
//     2. env     — $OPENCUES_REPO points at a checkout (power users / CI).
//     3. home    — ~/.opencues/repo (the standalone default, created by 4).
//     4. fetch   — none found: `git clone --depth 1 --branch v<cli-version>`
//                  into ~/.opencues/repo. The tag pin is the versioning
//                  contract: npm version = git tag = repo snapshot, so a
//                  0.3.0 CLI always drives the v0.3.0 runtime. If the tag
//                  doesn't exist (dev builds), falls back to the default
//                  branch with a loud warning.
//
// Only repo-needing commands trigger step 4 (see REPO_NEEDING in bin/cli.cjs);
// light commands (set-key, config, identity, help, ...) never clone.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_REPO_URL = 'https://github.com/opencues/opencues';
// Overridable for forks and hermetic tests (file:// URLs work). Read at
// call time so tests can set it after require.
function repoUrl() { return process.env.OPENCUES_REPO_URL || DEFAULT_REPO_URL; }

// A directory is a usable repo root iff it has the workspace manifest AND the
// core package. (defaults/ + integrations/ ride along in any real checkout.)
function isRepoRoot(dir) {
  try {
    return fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))
      && fs.existsSync(path.join(dir, 'packages', 'opencues-core', 'package.json'));
  } catch {
    return false;
  }
}

function homeRepoDir() {
  return path.join(os.homedir(), '.opencues', 'repo');
}

// Resolve without side effects. Returns { root, source } with
// source ∈ 'clone' | 'env' | 'home', or { root: null, source: null }.
function resolveRepoRoot(pkgDir) {
  const cloneRoot = path.resolve(pkgDir, '..', '..');
  if (isRepoRoot(cloneRoot)) return { root: cloneRoot, source: 'clone' };

  const envRoot = process.env.OPENCUES_REPO;
  if (envRoot) {
    if (isRepoRoot(envRoot)) return { root: envRoot, source: 'env' };
    console.error(`  ! $OPENCUES_REPO is set (${envRoot}) but doesn't look like an OpenCues checkout — ignoring.`);
  }

  const home = homeRepoDir();
  if (isRepoRoot(home)) return { root: home, source: 'home' };

  return { root: null, source: null };
}

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// Fetch the repo into ~/.opencues/repo, pinned to the CLI's own version tag.
// Returns the repo root. Throws (with a user-ready message) on failure.
function fetchRepo(version, { log = console.log } = {}) {
  const dest = homeRepoDir();

  if (!gitAvailable()) {
    throw new Error(
      'opencues needs `git` to fetch its runtime repo and none was found.\n'
      + 'Install git (https://git-scm.com) and re-run, or clone manually:\n'
      + `  git clone ${repoUrl()} ${dest}`,
    );
  }

  // A half-clone from an interrupted earlier run blocks `git clone`; clear it.
  if (fs.existsSync(dest) && !isRepoRoot(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const tag = `v${version}`;
  log(`  ▸ fetching the OpenCues runtime repo (${tag}) → ${dest}`);
  let r = spawnSync('git', ['clone', '--depth', '1', '--branch', tag, repoUrl(), dest], {
    stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
  });
  if (r.status !== 0) {
    // Tag missing (unreleased/dev CLI build) or transient — fall back to the
    // default branch, loudly: version drift between CLI and repo is possible.
    log(`  ! tag ${tag} not found upstream — falling back to the default branch`);
    log('    (CLI and repo versions may drift; `opencues update` will realign)');
    r = spawnSync('git', ['clone', '--depth', '1', repoUrl(), dest], {
      stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
    });
  }
  if (r.status !== 0) {
    throw new Error(
      `git clone failed:\n${(r.stderr || '').trim().split('\n').slice(-3).join('\n')}\n`
      + `Check your network, or clone manually:\n  git clone ${repoUrl()} ${dest}`,
    );
  }
  if (!isRepoRoot(dest)) {
    throw new Error(`clone at ${dest} doesn't look like the OpenCues repo — aborting.`);
  }
  log('  ▸ repo ready');
  return dest;
}

// Resolve the pnpm invocation for a machine that may not have pnpm
// installed: prefer a real `pnpm`, else corepack (bundled with Node ≥22 —
// our engines floor), else `bun x pnpm` (bun-only machines installing via
// `bun add -g opencues` have bun but neither node's corepack nor pnpm).
// corepack reads the repo's `packageManager` pin so the version always
// matches the workspace; bun x resolves pnpm@latest, close enough for a
// bootstrap install.
function resolvePnpm({ run = spawnSync } = {}) {
  if (run('pnpm', ['--version'], { stdio: 'ignore' }).status === 0) return ['pnpm'];
  if (run('corepack', ['--version'], { stdio: 'ignore' }).status === 0) return ['corepack', 'pnpm'];
  // pnpm@9 pinned: pnpm 10 needs node:sqlite, which bun doesn't implement.
  if (run('bun', ['--version'], { stdio: 'ignore' }).status === 0) return ['bun', 'x', 'pnpm@9'];
  return null;
}

// Bring a freshly fetched (or half-bootstrapped) CLI-managed repo to a
// usable state: workspace deps installed + @opencues/core built (the one
// package repo-needing commands require directly; per-host installers
// build the rest themselves). Idempotent — skips whatever's present.
// NEVER runs on dev clones (callers gate on source === 'home'/fresh fetch).
function bootstrapRepo(root, { log = console.log, run = spawnSync } = {}) {
  const needDeps = !fs.existsSync(path.join(root, 'node_modules'));
  const needCore = !fs.existsSync(path.join(root, 'packages', 'opencues-core', 'dist', 'index.js'));
  if (!needDeps && !needCore) return;

  const pnpm = resolvePnpm({ run });
  if (!pnpm) {
    throw new Error(
      'opencues needs pnpm (or corepack, bundled with Node 22+, or bun) to\n'
      + 'set up its runtime repo, and none was found. Fix with ONE of:\n'
      + '  corepack enable pnpm      # ships with Node — no install needed\n'
      + '  npm install -g pnpm\n'
      + '  bun --version             # bun works too (bun x pnpm)',
    );
  }
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };

  if (needDeps) {
    log('  ▸ installing workspace dependencies (one-time, ~1 min)');
    // Bun rung: pnpm@9 lacks pnpm 10's default build-script deny, so it
    // would run isolated-vm's node-gyp (doomed under bun — no toolchain,
    // and the binding can't load in bun anyway; the runtime lazy-requires
    // it and degrades gracefully, INFOSEC F1). --ignore-scripts restores
    // pnpm-10-equivalent behaviour on this rung.
    const installArgs = [...pnpm.slice(1), 'install', ...(pnpm[0] === 'bun' ? ['--ignore-scripts'] : [])];
    const r = run(pnpm[0], installArgs, { cwd: root, stdio: 'inherit', env });
    if (r.status !== 0) throw new Error('workspace dependency install failed — see output above.');
  }
  if (needCore) {
    log('  ▸ building @opencues/core');
    const r = run(pnpm[0], [...pnpm.slice(1), 'run', 'build'], {
      cwd: path.join(root, 'packages', 'opencues-core'), stdio: 'inherit', env,
    });
    if (r.status !== 0) throw new Error('@opencues/core build failed — see output above.');
  }
}

// Ensure a usable repo root exists, fetching + bootstrapping if necessary.
// `version` is the CLI's package.json version (the tag pin).
function ensureRepoRoot(pkgDir, version, opts) {
  const found = resolveRepoRoot(pkgDir);
  if (found.root) {
    // The CLI-managed copy self-heals (an interrupted earlier bootstrap
    // leaves deps/dist missing); dev clones are the developer's business.
    if (found.source === 'home') bootstrapRepo(found.root, opts);
    return found.root;
  }
  const root = fetchRepo(version, opts);
  bootstrapRepo(root, opts);
  return root;
}

module.exports = {
  isRepoRoot, resolveRepoRoot, ensureRepoRoot, fetchRepo, bootstrapRepo,
  resolvePnpm, homeRepoDir, repoUrl, DEFAULT_REPO_URL,
};
