// Tests for `opencues install`'s pure dispatch/routing logic: `--help`
// before a host is named, the missing-host and unknown-host error paths,
// alias resolution (the fallback host resolver's name map), `--all`
// expansion, and `runHostInstaller`'s "installer not found" short-circuit.
//
// Explicitly OUT of scope (per this pass's brief): the real per-host
// installers (integrations/<host>/bin/install.cjs), seed-configs writes,
// network calls (update-check), and any subprocess spawn that would
// actually install something. See install.skillplugin.test.cjs for the
// `install skill` / `install plugin` sub-commands (file-only side effects,
// sandboxed under a fake HOME).
//
// Hermeticity: ctx.REPO_ROOT is a throwaway mkdtemp dir for every test.
// It deliberately has:
//   - none of packages/opencues-core/dist/** → forces install.cjs's
//     loadHostResolver into its fallback branch (a plain alias map), so
//     resolution is deterministic and doesn't depend on the real build.
//   - none of integrations/*/bin/install.cjs → runHostInstaller's
//     `fs.existsSync(installer)` guard returns BEFORE any spawnSync call,
//     so no real installer, network call, or subprocess ever runs.
//   - no pnpm-workspace.yaml / packages/opencues-runtime/node_modules →
//     ensureWorkspaceDeps / ensureNativeBindings both take their early
//     "nothing to check" return with no spawnSync either.
// Every test that proceeds past host resolution passes `--dry-run` so the
// `!passthrough.includes('--dry-run')` gate skips the seed-configs call
// entirely (seed-configs.cjs is a REAL sibling module resolved by relative
// path regardless of ctx.REPO_ROOT, so it must never actually run here).
// HOME/USERPROFILE are additionally sandboxed to a mkdtemp dir as
// defense-in-depth even though nothing on these tested paths reads them.
// process.exit is mocked to throw `__EXIT_<code>__` so control flow halts
// exactly where the real CLI process would have exited, and the assertion
// can inspect the exit code from the thrown message.

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const install = require('./install.cjs');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let fakeRepoRoot;
let tmpHome;
let logs, errs;
let origLog, origErr, origExit;
const savedEnv = {};

beforeEach(() => {
  fakeRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-install-routing-repo-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-install-routing-home-'));

  savedEnv.HOME = process.env.HOME;
  savedEnv.USERPROFILE = process.env.USERPROFILE;
  savedEnv.OPENCUES_NO_INTERACTIVE = process.env.OPENCUES_NO_INTERACTIVE;
  savedEnv.OPENCUES_SKIP_DEPS_GATE = process.env.OPENCUES_SKIP_DEPS_GATE;
  savedEnv.OPENCUES_SKIP_NATIVE_PROBE = process.env.OPENCUES_SKIP_NATIVE_PROBE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // os.homedir() reads %USERPROFILE% on Windows, not $HOME
  // Belt-and-suspenders: force non-interactive even if the test runner
  // ever gains a real TTY, and skip the two probes that shell out —
  // both already no-op via the fake REPO_ROOT, but this pins the same
  // outcome even if that fs-existence trick regresses later.
  process.env.OPENCUES_NO_INTERACTIVE = '1';
  process.env.OPENCUES_SKIP_DEPS_GATE = '1';
  process.env.OPENCUES_SKIP_NATIVE_PROBE = '1';

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
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(fakeRepoRoot, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('install dispatch — --help / missing host / unknown host', () => {
  it('`--help` before any host prints usage and resolves without exiting', async () => {
    await install(['--help'], { REPO_ROOT: fakeRepoRoot });
    assert.match(logs.join('\n'), /opencues install <host>/);
    assert.strictEqual(errs.length, 0);
  });

  it('missing host in a non-interactive context exits 2, listing every known host', async () => {
    await assert.rejects(() => install([], { REPO_ROOT: fakeRepoRoot }), /__EXIT_2__/);
    const out = errs.join('\n');
    assert.match(out, /missing <host>/);
    // Per host, not as one contiguous substring. The old form pinned the
    // exact comma-joined prefix, so it failed on any host being ADDED —
    // which is not a regression, and the failure said nothing about what
    // was actually wrong. Each host named individually keeps the intent
    // ("every known host is offered") and survives the list growing.
    for (const host of ['chrome', 'claude-code', 'dsh', 'gemini-cli', 'opencode', 'shell', 'windows']) {
      assert.ok(out.includes(host), `missing-host error should name ${host}; got: ${out}`);
    }
    assert.match(out, /--all/);
  });

  it('the fallback host list matches core\'s HOSTS', () => {
    // This suite deliberately runs with no core dist, forcing install.cjs's
    // pre-build FALLBACK resolver — a hand-maintained copy of core's HOSTS.
    // Two copies of a list is a drift surface, so pin them together: adding
    // a host to core and forgetting the fallback would otherwise mean
    // `opencues install <new-host>` worked normally and then mysteriously
    // reported "unknown host" on any machine that had not built core yet.
    let core;
    try {
      core = require('../../../opencues-core/dist/host-compat.js');
    } catch {
      // Core not built in this environment — nothing to compare against,
      // and failing here would make the suite depend on build order.
      return;
    }
    const fallback = ['chrome', 'claude-code', 'dsh', 'gemini-cli', 'opencode', 'shell', 'windows'];
    assert.deepStrictEqual(core.HOSTS.slice().sort(), fallback.slice().sort());
  });

  it('unknown host name exits 2, naming the bad value', async () => {
    await assert.rejects(() => install(['not-a-real-host', '--dry-run'], { REPO_ROOT: fakeRepoRoot }), /__EXIT_2__/);
    assert.match(errs.join('\n'), /unknown host "not-a-real-host"/);
  });
});

describe('install dispatch — alias resolution (fallback resolver)', () => {
  // Each alias must resolve to its canonical folder BEFORE runHostInstaller
  // is reached — proven here because the fake REPO_ROOT has no installer
  // for ANY host, so the "not found" message always fires and always names
  // the *resolved* folder, not the raw alias the user typed.
  const cases = [
    ['cc', 'claude-code'],
    ['claude', 'claude-code'],
    ['claudecode', 'claude-code'],
    ['claude-code', 'claude-code'],
    ['oc', 'opencode'],
    ['opencode', 'opencode'],
    ['gemini', 'gemini-cli'],
    ['geminicli', 'gemini-cli'],
    ['gemini-cli', 'gemini-cli'],
    ['term', 'shell'],
    ['oc-edit', 'shell'],
    ['shell', 'shell'],
    ['chrome', 'chrome'],
    // chrome-host is a special sub-action (install-host), but still
    // resolves to the 'chrome' folder for the installer lookup.
    ['chrome-host', 'chrome'],
  ];
  for (const [alias, folder] of cases) {
    it(`"${alias}" resolves to the "${folder}" folder`, async () => {
      await assert.rejects(() => install([alias, '--dry-run'], { REPO_ROOT: fakeRepoRoot }), /__EXIT_1__/);
      assert.match(errs.join('\n'), new RegExp(`installer not found for "${folder}"`));
    });
  }
});

describe('install dispatch — --all expansion + exit-code propagation', () => {
  it('expands to every known host and exits non-zero when every installer is missing', async () => {
    await assert.rejects(() => install(['--all', '--dry-run'], { REPO_ROOT: fakeRepoRoot }), /__EXIT_1__/);
    const out = errs.join('\n');
    for (const host of ['chrome', 'claude-code', 'gemini-cli', 'opencode', 'shell']) {
      assert.match(out, new RegExp(`installer not found for "${host}"`));
    }
  });
});

describe('install dispatch — install skill/plugin sub-command routing', () => {
  it('`install skill --help` does not fall through to top-level help or host resolution', async () => {
    await install(['skill', '--help'], { REPO_ROOT: fakeRepoRoot });
    assert.match(logs.join('\n'), /opencues install skill <name>/);
    // Must not have hit the "missing <host>" branch.
    assert.strictEqual(errs.length, 0);
  });

  it('`install plugin --help` does not fall through to top-level help or host resolution', async () => {
    await install(['plugin', '--help'], { REPO_ROOT: fakeRepoRoot });
    assert.match(logs.join('\n'), /opencues install plugin <name>/);
    assert.strictEqual(errs.length, 0);
  });
});
