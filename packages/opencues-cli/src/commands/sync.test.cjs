// Tests for `opencues sync` — pushes ~/.cues/-shaped config trees into
// chrome's dist/configs bundle.
//
// Hermeticity — two layers:
//   1. HOME + USERPROFILE point at a fresh mkdtemp dir for every test
//      (default source resolution reads ~/.cues/).
//   2. ctx.REPO_ROOT is ALSO a fresh mkdtemp dir, never the real repo
//      root. sync.cjs always writes to
//      `<ctx.REPO_ROOT>/integrations/chrome/dist/configs` regardless of
//      --target/--wsl (those only add an EXTRA mirror) — so if we ever
//      pointed ctx.REPO_ROOT at the real repo, every test run would
//      wipe + rewrite the real integrations/chrome/dist/configs/ build
//      artifact. Instead, the fake REPO_ROOT gets a tiny shim at
//      packages/opencues-core/dist/index.js that re-exports the REAL,
//      already-built @opencues/core (so sync.cjs's real parsing logic
//      — parseCuesMd/inferHostCompat/etc — still runs for real), while
//      every filesystem WRITE stays fully contained in the fake
//      REPO_ROOT tmpdir.
//
// sync.cjs calls process.exit() directly on nearly every error path (no
// return-a-code convention here, unlike statusline.cjs/version.cjs), so
// process.exit is stubbed to throw `__EXIT_<code>__` and control flow is
// asserted via assert.rejects/assert.throws, mirroring
// install.routing.test.cjs's established pattern.
//
// Deliberately OUT of scope: `--watch` (a long-running fs.watch loop —
// would hang the test process; the underlying syncChrome() function it
// wraps is already exercised directly by every other test here).

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL_REPO_ROOT = path.resolve(__dirname, '../../../..');
const REAL_CORE_DIST = path.join(REAL_REPO_ROOT, 'packages/opencues-core/dist/index.js');

const sync = require('./sync.cjs');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let tmpHome, fakeRepoRoot;
let realHome, realUserProfile;
let logs, errs;
let origLog, origErr, origExit;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sync-home-'));
  fakeRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sync-repo-'));
  // Shim so loadCore()'s require(`${REPO_ROOT}/packages/opencues-core/dist/index.js`)
  // resolves to the REAL built core, while every WRITE sync.cjs performs
  // stays under the fake REPO_ROOT (which is what all path.join(ctx.REPO_ROOT, ...)
  // write targets are actually built from).
  const shimDir = path.join(fakeRepoRoot, 'packages', 'opencues-core', 'dist');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'index.js'), `module.exports = require(${JSON.stringify(REAL_CORE_DIST)});\n`);

  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  logs = [];
  errs = [];
  origLog = console.log;
  origErr = console.error;
  origExit = process.exit;
  console.log = (...a) => logs.push(stripAnsi(a.join(' ')));
  console.error = (...a) => errs.push(stripAnsi(a.join(' ')));
  process.exit = (code) => { throw new Error(`__EXIT_${code}__`); };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.exit = origExit;
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(fakeRepoRoot, { recursive: true, force: true });
});

function ctx() {
  return { REPO_ROOT: fakeRepoRoot, pkg: { version: 'test' } };
}

function distConfigs() {
  return path.join(fakeRepoRoot, 'integrations', 'chrome', 'dist', 'configs');
}

// A minimal, chrome-compatible folder-based cue.
function writeFixtureCueDir(root) {
  const dir = path.join(root, 'cues', 'demo-cue');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CUE.md'), [
    '---',
    'name: demo-cue',
    'match: contract',
    '---',
    '',
    'Suggest alternatives.',
    '',
  ].join('\n'));
  return dir;
}

// A folder-based cue explicitly scoped OFF chrome.
function writeFixtureNonChromeCueDir(root) {
  const dir = path.join(root, 'cues', 'not-for-chrome');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CUE.md'), [
    '---',
    'name: not-for-chrome',
    'match: whatever',
    'not-on-host: [chrome]',
    '---',
    '',
    'test',
    '',
  ].join('\n'));
  return dir;
}

// ─── Happy path ────────────────────────────────────────────────────────────

describe('opencues sync chrome', () => {
  it('happy: --help prints usage and touches no filesystem', () => {
    sync(['--help'], ctx());
    assert.match(logs.join('\n'), /opencues sync <host>/);
    assert.strictEqual(fs.existsSync(distConfigs()), false);
  });

  it('happy: --source <dir> --dry-run prints a plan and copies nothing', () => {
    const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sync-src-'));
    try {
      writeFixtureCueDir(srcRoot);
      sync(['chrome', '--source', srcRoot, '--dry-run'], ctx());
      assert.match(logs.join('\n'), /\[dry-run\] Would copy/);
      assert.strictEqual(fs.existsSync(distConfigs()), false);
    } finally {
      fs.rmSync(srcRoot, { recursive: true, force: true });
    }
  });

  it('happy: --source <dir> performs a real copy into <fakeRepoRoot>/integrations/chrome/dist/configs', () => {
    const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sync-src-'));
    try {
      writeFixtureCueDir(srcRoot);
      sync(['chrome', '--source', srcRoot], ctx());
      const copied = path.join(distConfigs(), 'cues', 'demo-cue', 'CUE.md');
      assert.strictEqual(fs.existsSync(copied), true);
      assert.strictEqual(fs.existsSync(path.join(distConfigs(), 'index.json')), true);
      assert.strictEqual(fs.existsSync(path.join(distConfigs(), '.version')), true);
      assert.match(logs.join('\n'), /synced \d+ file\(s\)/);
    } finally {
      fs.rmSync(srcRoot, { recursive: true, force: true });
    }
  });

  it('happy: default (no flags) source is ~/.cues/ when it exists', () => {
    const userCues = path.join(tmpHome, '.cues');
    writeFixtureCueDir(userCues);
    sync(['chrome'], ctx());
    assert.strictEqual(fs.existsSync(path.join(distConfigs(), 'cues', 'demo-cue', 'CUE.md')), true);
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe('opencues sync chrome — edge cases', () => {
  it('edge: a non-chrome-compatible folder is dropped and counted, not copied', () => {
    const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sync-src-'));
    try {
      writeFixtureCueDir(srcRoot);
      writeFixtureNonChromeCueDir(srcRoot);
      sync(['chrome', '--source', srcRoot], ctx());
      assert.strictEqual(fs.existsSync(path.join(distConfigs(), 'cues', 'demo-cue', 'CUE.md')), true);
      assert.strictEqual(fs.existsSync(path.join(distConfigs(), 'cues', 'not-for-chrome')), false);
      assert.match(logs.join('\n'), /skipped 1 entry\(ies\) flagged as non-chrome/);
    } finally {
      fs.rmSync(srcRoot, { recursive: true, force: true });
    }
  });

  it('edge: --pack <name> resolves ~/.cues/packs/<name> when present', () => {
    const packDir = path.join(tmpHome, '.cues', 'packs', 'demo-pack');
    writeFixtureCueDir(packDir);
    sync(['chrome', '--pack', 'demo-pack'], ctx());
    assert.strictEqual(fs.existsSync(path.join(distConfigs(), 'cues', 'demo-cue', 'CUE.md')), true);
  });

  it('edge: --include layers an extra source on top of the default (later overlays earlier on same-name files)', () => {
    const userCues = path.join(tmpHome, '.cues');
    writeFixtureCueDir(userCues); // base "demo-cue" with match: contract

    const includeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sync-include-'));
    try {
      const dir = path.join(includeRoot, 'cues', 'demo-cue');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'CUE.md'), [
        '---', 'name: demo-cue', 'match: overridden', '---', '', 'overlay body', '',
      ].join('\n'));

      sync(['chrome', '--include', includeRoot], ctx());
      const copied = fs.readFileSync(path.join(distConfigs(), 'cues', 'demo-cue', 'CUE.md'), 'utf8');
      assert.match(copied, /match: overridden/, '--include source must overlay the user-level default on same-name collision');
    } finally {
      fs.rmSync(includeRoot, { recursive: true, force: true });
    }
  });

  it('edge: --project adds <cwd>/.cues on top of the default sources', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sync-project-'));
    const realCwd = process.cwd();
    try {
      writeFixtureCueDir(path.join(projectDir, '.cues'));
      process.chdir(projectDir);
      sync(['chrome', '--project'], ctx());
      assert.strictEqual(fs.existsSync(path.join(distConfigs(), 'cues', 'demo-cue', 'CUE.md')), true);
    } finally {
      process.chdir(realCwd);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('edge: a second sync run with a removed file wipes the stale copy (no lingering files)', () => {
    const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sync-src-'));
    try {
      const dir = writeFixtureCueDir(srcRoot);
      sync(['chrome', '--source', srcRoot], ctx());
      assert.strictEqual(fs.existsSync(path.join(distConfigs(), 'cues', 'demo-cue', 'CUE.md')), true);

      fs.rmSync(dir, { recursive: true, force: true });
      sync(['chrome', '--source', srcRoot], ctx());
      assert.strictEqual(fs.existsSync(path.join(distConfigs(), 'cues', 'demo-cue')), false);
    } finally {
      fs.rmSync(srcRoot, { recursive: true, force: true });
    }
  });
});

// ─── Invalid input ─────────────────────────────────────────────────────────

describe('opencues sync — invalid input', () => {
  it('invalid: missing <host> exits 2 listing supported hosts', () => {
    assert.throws(() => sync([], ctx()), /__EXIT_2__/);
    assert.match(errs.join('\n'), /missing <host>/);
  });

  it('invalid: unsupported host name exits 2, pointing at CC/OC native hot-reload', () => {
    assert.throws(() => sync(['claude-code'], ctx()), /__EXIT_2__/);
    assert.match(errs.join('\n'), /unsupported host "claude-code"/);
    assert.match(errs.join('\n'), /hot-reload natively/);
  });

  it('invalid: --pack with a nonexistent pack name exits 1', () => {
    assert.throws(() => sync(['chrome', '--pack', 'nope-does-not-exist'], ctx()), /__EXIT_1__/);
    assert.match(errs.join('\n'), /pack "nope-does-not-exist" not found/);
  });

  it('invalid: --include with a nonexistent path exits 1', () => {
    assert.throws(() => sync(['chrome', '--include', path.join(tmpHome, 'does-not-exist')], ctx()), /__EXIT_1__/);
    assert.match(errs.join('\n'), /--include path not found/);
  });

  it('invalid: no sources resolved at all (no ~/.cues, no flags) exits 1', () => {
    assert.throws(() => sync(['chrome'], ctx()), /__EXIT_1__/);
    assert.match(errs.join('\n'), /no sources resolved/);
  });

  it('invalid: --wsl outside of WSL exits 1 with a clear message', () => {
    const savedDistro = process.env.WSL_DISTRO_NAME;
    const savedInterop = process.env.WSL_INTEROP;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    try {
      const userCues = path.join(tmpHome, '.cues');
      writeFixtureCueDir(userCues);
      assert.throws(() => sync(['chrome', '--wsl'], ctx()), /__EXIT_1__/);
      assert.match(errs.join('\n'), /requires running under WSL/);
    } finally {
      if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME; else process.env.WSL_DISTRO_NAME = savedDistro;
      if (savedInterop === undefined) delete process.env.WSL_INTEROP; else process.env.WSL_INTEROP = savedInterop;
    }
  });
});
