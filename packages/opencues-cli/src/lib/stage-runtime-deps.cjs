'use strict';
// stage-runtime-deps.cjs — copy @opencues/runtime's own runtime
// DEPENDENCIES into a self-owned host's local node_modules.
//
// WHY THIS EXISTS
//
// The self-owned hosts (mac, apple-notes, shell) stage @opencues/{core,
// runtime} as dist-only real copies — dist/ + package.json, no
// node_modules. That's deliberate (the version marker needs a stable
// install target, not a workspace symlink), but it leaves the runtime's
// declared dependencies unresolvable: Node's upward walk from
// <host>/node_modules/@opencues/runtime/dist/src/... finds no `acorn`,
// because pnpm keeps transitive deps in the workspace store, not at the
// repo root.
//
// The symptom is silent and host-wide: the JS user-blank loader
// (user-blanks/esm-rewrite.js → node-loader.js) lazy-requires acorn +
// acorn-walk, so EVERY JS user blank fails to register while built-in
// and .sh blanks keep working. Observed on mac 2026-07-26 — the shipped
// `gh-issues` reference blank failed on BOTH the in-process and the
// subprocess-fallback paths with `Cannot find module 'acorn'`, logged as
// a warn and otherwise invisible.
//
// The other integrations already solve this in their own way:
//   - gemini-cli's setup.sh runs `npm install --no-save acorn acorn-walk`
//     into the fork (§ "acorn alone is already a transitive gemini dep,
//     but acorn-walk isn't").
//   - claude-code's install.cjs probes `user-blanks/registry.js` and warns
//     that JS user-blanks are disabled when the transitive dep is absent.
// This module is the third approach and the one that actually fixes it for
// a dist-only staged bundle: copy the versions the runtime was BUILT
// against, straight from the workspace, so the install stays offline and
// version-pinned. Shared rather than hand-copied into three installers —
// a guard that must exist identically on several paths belongs in one
// function (CLAUDE.md § "Security guard hand-mirrored across two parallel
// loader implementations drifts").
//
// isolated-vm is intentionally BEST-EFFORT: it's a native module, it's
// only needed for the JS sandbox, and registry.ts is engineered to load
// without it (the host then disables JS user blanks rather than crashing).
// A missing/unresolvable isolated-vm must never fail an install.

const fs = require('node:fs');
const path = require('node:path');

/** Deps of @opencues/runtime that its LAZY requires reach at runtime.
 *  `optional: true` → absence is a warning, never an install failure. */
const RUNTIME_DEPS = [
  { name: 'acorn', optional: false },
  { name: 'acorn-walk', optional: false },
  { name: 'isolated-vm', optional: true },
];

/**
 * Resolve a dependency's package ROOT (the dir holding its package.json)
 * as seen from @opencues/runtime in the workspace. Returns null when the
 * dep can't be resolved — callers decide whether that's fatal.
 */
/** The dir dependency resolution starts from: @opencues/runtime itself. */
function REPO_ROOT_RUNTIME(REPO_ROOT) {
  return path.join(REPO_ROOT, 'packages', 'opencues-runtime');
}

function resolveDepDir(name, REPO_ROOT) {
  const from = REPO_ROOT_RUNTIME(REPO_ROOT);
  let entry;
  try {
    entry = require.resolve(name, { paths: [from] });
  } catch {
    // Native/ESM-only packages can fail `resolve` on their main entry
    // (isolated-vm's binding, "exports"-gated packages) while still being
    // present on disk — fall back to the conventional layout.
    const guess = path.join(from, 'node_modules', name);
    return fs.existsSync(path.join(guess, 'package.json')) ? fs.realpathSync(guess) : null;
  }
  // Walk up from the resolved entry file to the package root. pnpm nests
  // as .pnpm/<pkg>@<ver>/node_modules/<pkg>, so stop at the package.json
  // whose `name` matches — not merely the first package.json found.
  let dir = path.dirname(entry);
  for (let i = 0; i < 12 && dir !== path.dirname(dir); i++) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        if (JSON.parse(fs.readFileSync(pj, 'utf8')).name === name) return fs.realpathSync(dir);
      } catch { /* unreadable package.json — keep walking */ }
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Copy every runtime dependency into `<destNodeModules>/<dep>`.
 *
 * @param {object} opts
 * @param {string} opts.REPO_ROOT        repo root (workspace with pnpm-workspace.yaml)
 * @param {string} opts.destNodeModules  the host's node_modules dir
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ staged: string[], missing: string[] }}
 * @throws when a NON-optional dep can't be resolved — shipping a bundle
 *         whose JS user-blank loader is dead is worse than failing loudly.
 */
/**
 * Resolve a package root as seen FROM an arbitrary directory (not just the
 * runtime package) — used to walk a dependency's own dependencies.
 */
function resolveDepDirFrom(name, fromDir) {
  let entry;
  try {
    entry = require.resolve(name, { paths: [fromDir] });
  } catch {
    const guess = path.join(fromDir, 'node_modules', name);
    return fs.existsSync(path.join(guess, 'package.json')) ? fs.realpathSync(guess) : null;
  }
  let dir = path.dirname(entry);
  for (let i = 0; i < 12 && dir !== path.dirname(dir); i++) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        if (JSON.parse(fs.readFileSync(pj, 'utf8')).name === name) return fs.realpathSync(dir);
      } catch { /* keep walking */ }
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Copy `name` and, transitively, everything its package.json declares as a
 * runtime `dependencies` entry — flat, into `destNodeModules`.
 *
 * Copying one package is NOT enough: isolated-vm requires `node-gyp-build`
 * at load time to find its prebuilt binary, so a flat single-package copy
 * still died with `Cannot find module 'node-gyp-build'` (2026-07-26). pnpm
 * keeps each dep's own deps as symlinks beside it in the store, so
 * resolution from the copied package's REAL path finds them.
 */
function stageTree(name, fromDir, destNodeModules, seen, staged) {
  if (seen.has(name)) return true;
  const src = resolveDepDirFrom(name, fromDir);
  if (!src) return false;
  seen.add(name);
  const dest = path.join(destNodeModules, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  staged.push(name);
  let deps = {};
  try { deps = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).dependencies ?? {}; } catch { /* none */ }
  // Resolve each child FROM the dependency's own real location so pnpm's
  // per-package node_modules is the lookup root.
  for (const child of Object.keys(deps)) stageTree(child, src, destNodeModules, seen, staged);
  return true;
}

function stageRuntimeDeps({ REPO_ROOT, destNodeModules, log = () => {} }) {
  const staged = [];
  const missing = [];
  const seen = new Set();
  for (const { name, optional } of RUNTIME_DEPS) {
    const src = resolveDepDir(name, REPO_ROOT);
    if (!src) {
      missing.push(name);
      if (optional) {
        log(`    ⚠ ${name} not resolvable — JS user-blanks will run without it (built-in + .sh blanks unaffected)`);
        continue;
      }
      throw new Error(
        `stageRuntimeDeps: required dependency "${name}" of @opencues/runtime could not be resolved from the ` +
        `workspace. Run \`pnpm install\` at ${REPO_ROOT} and retry — staging a bundle without it silently ` +
        `disables every JS user blank on this host.`,
      );
    }
    // dereference + transitive: pnpm's store entries are symlink farms, and
    // a dep's own deps (isolated-vm → node-gyp-build) must land beside it or
    // the staged copy fails at require time.
    stageTree(name, REPO_ROOT_RUNTIME(REPO_ROOT), destNodeModules, seen, staged);
  }
  if (staged.length) log(`    staged runtime deps: ${staged.join(', ')}`);
  return { staged, missing };
}

/**
 * Vendor the user-blank SUBPROCESS runner + the deps it resolves.
 *
 * The subprocess loader spawns `~/.opencues/vendor/user-blank-runner.cjs`
 * with `NODE_PATH=<runner-dir>/node_modules` (subprocess-loader.ts), so
 * that vendor dir needs its OWN copy of isolated-vm — staging into the
 * host's node_modules doesn't help a child process rooted elsewhere.
 *
 * shell + opencode already tried this in their setup.sh, but copied from
 * `$OPENCUES_ROOT/node_modules/isolated-vm` — a path that does not exist
 * in a pnpm workspace (deps live in the store, not hoisted to the repo
 * root). The copy silently no-opped, `~/.opencues/vendor/node_modules`
 * stayed empty, and every JS user blank that fell through to the
 * subprocess path died with `Cannot find module 'isolated-vm'`. Using
 * resolveDepDir() instead makes it layout-agnostic.
 *
 * Best-effort by design: a missing runner source or an unresolvable
 * isolated-vm degrades JS user-blanks, it must never fail an install.
 *
 * @returns {{ runner: boolean, staged: string[] }}
 */
function vendorUserBlankRunner({ REPO_ROOT, home, log = () => {} }) {
  const os = require('node:os');
  const vendorDir = path.join(home ?? os.homedir(), '.opencues', 'vendor');
  fs.mkdirSync(path.join(vendorDir, 'node_modules'), { recursive: true });

  let runner = false;
  const candidates = [
    path.join(REPO_ROOT, 'packages/opencues-runtime/dist/src/user-blanks/subprocess-runner.cjs'),
    path.join(REPO_ROOT, 'packages/opencues-runtime/src/user-blanks/subprocess-runner.cjs'),
  ];
  for (const src of candidates) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(vendorDir, 'user-blank-runner.cjs'));
      runner = true;
      break;
    }
  }
  if (!runner) log('    ⚠ user-blank subprocess runner not found — JS user-blanks will run in-process only');

  let staged = [];
  try {
    ({ staged } = stageRuntimeDeps({ REPO_ROOT, destNodeModules: path.join(vendorDir, 'node_modules'), log: () => {} }));
    if (staged.length) log(`    vendored user-blank runner + deps: ${staged.join(', ')}`);
  } catch (err) {
    // stageRuntimeDeps throws on a missing REQUIRED dep; for the vendor
    // dir that's a degraded sandbox, not a broken install.
    log(`    ⚠ user-blank runner deps incomplete (${err.message.split('\n')[0]})`);
  }
  return { runner, staged };
}

module.exports = { stageRuntimeDeps, vendorUserBlankRunner, resolveDepDir, RUNTIME_DEPS };
