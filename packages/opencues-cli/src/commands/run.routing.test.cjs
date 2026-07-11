// Tests for `opencues run <host>`'s pure dispatch/routing logic: `--help`
// before a host is named, missing/unknown-host errors, alias resolution
// (the fallback host resolver), and each per-host launcher's early
// `fs.existsSync` guard (fork/binary not found) — all BEFORE any real
// process would be spawned.
//
// Explicitly OUT of scope (per this pass's brief — full orchestration
// coverage isn't the goal, and this repo's shell-level gates already
// exercise the real launch paths):
//   - `ensureFreshBundle` (run.cjs) — not exported, and every path through
//     it either (a) returns early with no side effect [already re-derived
//     here for free via the "host not installed" case, since our sandboxed
//     HOME never has a real fork] or (b) re-spawns `node cli.cjs install
//     <host> --yes` for the 'stale' case, a real recursive install we must
//     not trigger from a unit test. version-markers.cjs's OWN drift-status
//     decision logic (checkDrift / enumerateInstalledHosts) already has
//     dedicated coverage in version-markers.test.cjs.
//   - opencode's `bun` presence check + the actual `bun run dev` spawn,
//     and gemini-cli/shell's real spawnSync — never reached here because
//     every test deliberately keeps the fork/binary lookup failing (see
//     hermeticity note below), so the guard fires and returns before any
//     spawnSync call.
//
// What IS exercised for real: runCC's `--bin` explicit-override branch and
// its native-binary-vs-cli.js precedence, using spawnSync against files
// that are guaranteed not to be valid executables — Node/Windows fails the
// exec attempt immediately (verified: `UNKNOWN`/ENOENT, no hang, nothing
// runs) so this is safe to drive for real rather than mocking spawnSync.
//
// Hermeticity — every test sandboxes:
//   - HOME + USERPROFILE → a throwaway mkdtemp dir, so runCC/runOC/runGemini
//     never see this machine's real ~/claude-code-cues, ~/opencode-cues,
//     or ~/gemini-cli-cues (os.homedir() reads %USERPROFILE% on Windows,
//     not $HOME — both are always set together).
//   - PATH → a throwaway empty dir, so runCC's PATH-fallback `which` probe
//     can never resolve this machine's real `claude` / `claude-cues`
//     binaries (which per this repo's own CLAUDE.md ARE installed on this
//     machine at ~/claude-code-cues and ~/.local/bin/claude).
//   - ctx.REPO_ROOT → a throwaway mkdtemp dir (no integrations/shell/bin/
//     oc-shell), so runShell's existence guard fails closed instead of
//     finding and spawning the real script.
//   - OPENCUES_NO_INTERACTIVE / OPENCUES_NO_UPDATE_CHECK → force the
//     non-interactive path and skip the (already cache-only, HOME-scoped)
//     update notice outright.
// Every test also passes `--skip-banner` (module-level `_skipBanner` in
// run.cjs latches true for the lifetime of the process once set — tests
// don't depend on banner content, so this keeps output deterministic
// regardless of test execution order within this file) and
// `--no-rebuild-check` (skips ensureFreshBundle entirely — see above).

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const run = require('./run.cjs');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const SKIP = ['--skip-banner', '--no-rebuild-check'];

let fakeRepoRoot;
let tmpHome;
let emptyPathDir;
let logs, errs;
let origLog, origErr, origWarn, origExit;
const savedEnv = {};

beforeEach(() => {
  fakeRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-run-routing-repo-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-run-routing-home-'));
  emptyPathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-run-routing-path-'));

  for (const k of ['HOME', 'USERPROFILE', 'PATH', 'OPENCUES_NO_INTERACTIVE', 'OPENCUES_NO_UPDATE_CHECK', 'OPENCODE_CUES_DIR', 'GEMINI_CLI_CUES_DIR']) {
    savedEnv[k] = process.env[k];
  }
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.PATH = emptyPathDir;
  process.env.OPENCUES_NO_INTERACTIVE = '1';
  process.env.OPENCUES_NO_UPDATE_CHECK = '1';
  delete process.env.OPENCODE_CUES_DIR;
  delete process.env.GEMINI_CLI_CUES_DIR;

  logs = [];
  errs = [];
  origLog = console.log;
  origErr = console.error;
  origWarn = console.warn;
  origExit = process.exit;
  console.log = (...a) => logs.push(stripAnsi(a.join(' ')));
  console.error = (...a) => errs.push(stripAnsi(a.join(' ')));
  // runCC's PATH-fallback path uses console.warn (not console.error) for
  // its "patched install not found" lines — capture into the same bucket
  // so assertions can look in one place and the test run stays quiet.
  console.warn = (...a) => errs.push(stripAnsi(a.join(' ')));
  process.exit = (code) => { throw new Error(`__EXIT_${code}__`); };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  console.warn = origWarn;
  process.exit = origExit;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(fakeRepoRoot, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(emptyPathDir, { recursive: true, force: true });
});

describe('run dispatch — --help / missing host / unknown host', () => {
  it('`--help` before any host prints usage and resolves without exiting', async () => {
    await run(['--help'], { REPO_ROOT: fakeRepoRoot });
    assert.match(logs.join('\n'), /opencues run <host>/);
    assert.strictEqual(errs.length, 0);
  });

  it('missing host in a non-interactive context exits 2, listing every known host', async () => {
    await assert.rejects(() => run([], { REPO_ROOT: fakeRepoRoot }), /__EXIT_2__/);
    const out = errs.join('\n');
    assert.match(out, /missing <host>/);
    assert.match(out, /chrome, claude-code, gemini-cli, opencode, shell/);
  });

  it('unknown host name exits 2, naming the bad value', async () => {
    await assert.rejects(() => run(['not-a-real-host', ...SKIP], { REPO_ROOT: fakeRepoRoot }), /__EXIT_2__/);
    assert.match(errs.join('\n'), /unknown host "not-a-real-host"/);
  });

  it('a flag AFTER the host name is forwarded, not treated as --help (curl/git-style passthrough)', async () => {
    // '--help' after 'chrome' must reach chrome's handler untouched — chrome
    // never inspects its passthrough args and never errors, so this proves
    // the flag wasn't intercepted as opencues's own --help.
    await run(['chrome', '--help', ...SKIP], { REPO_ROOT: fakeRepoRoot });
    assert.match(logs.join('\n'), /Load the extension in chrome:\/\/extensions/);
    assert.ok(!logs.join('\n').includes('opencues run <host>'), 'must not have printed opencues\'s own --help text');
  });
});

describe('run dispatch — alias resolution (fallback resolver)', () => {
  it('"chrome" reaches the chrome handler (no exit, no spawn)', async () => {
    await run(['chrome', ...SKIP], { REPO_ROOT: fakeRepoRoot });
    assert.match(logs.join('\n'), /Load the extension in chrome:\/\/extensions/);
  });

  it('opencode aliases (oc, opencode) reach runOC\'s fork-existence guard', async () => {
    for (const alias of ['oc', 'opencode']) {
      errs.length = 0;
      await assert.rejects(() => run([alias, ...SKIP], { REPO_ROOT: fakeRepoRoot }), /__EXIT_1__/, `alias "${alias}"`);
      assert.match(errs.join('\n'), /doesn't look like an opencode checkout/, `alias "${alias}"`);
    }
  });

  it('gemini-cli aliases (gemini, geminicli, gemini-cli) reach runGemini\'s fork-existence guard', async () => {
    for (const alias of ['gemini', 'geminicli', 'gemini-cli']) {
      errs.length = 0;
      await assert.rejects(() => run([alias, ...SKIP], { REPO_ROOT: fakeRepoRoot }), /__EXIT_1__/, `alias "${alias}"`);
      assert.match(errs.join('\n'), /doesn't look like a gemini-cli checkout/, `alias "${alias}"`);
    }
  });

  it('shell aliases (term, oc-edit, shell) reach runShell\'s oc-shell-existence guard', async () => {
    for (const alias of ['term', 'oc-edit', 'shell']) {
      errs.length = 0;
      await assert.rejects(() => run([alias, ...SKIP], { REPO_ROOT: fakeRepoRoot }), /__EXIT_1__/, `alias "${alias}"`);
      assert.match(errs.join('\n'), /oc-shell not found at/, `alias "${alias}"`);
    }
  });

  it('claude-code aliases (cc, claude, claudecode, claude-code) all reach runCC and fail closed with no fork + empty PATH', async () => {
    for (const alias of ['cc', 'claude', 'claudecode', 'claude-code']) {
      errs.length = 0;
      await assert.rejects(() => run([alias, ...SKIP], { REPO_ROOT: fakeRepoRoot }), /__EXIT_127__/, `alias "${alias}"`);
      assert.match(errs.join('\n'), /no binary found/, `alias "${alias}"`);
    }
  });
});

describe('run opencode/gemini-cli — fork path resolution precedence', () => {
  it('--target overrides the default fork path and is named in the error', async () => {
    const explicit = path.join(tmpHome, 'my-custom-opencode-fork');
    await assert.rejects(() => run(['opencode', '--target', explicit, ...SKIP], { REPO_ROOT: fakeRepoRoot }), /__EXIT_1__/);
    assert.ok(errs.join('\n').includes(explicit), 'error should name the explicit --target path');
  });

  it('OPENCODE_CUES_DIR env var is used when --target is absent', async () => {
    const envFork = path.join(tmpHome, 'env-opencode-fork');
    process.env.OPENCODE_CUES_DIR = envFork;
    await assert.rejects(() => run(['opencode', ...SKIP], { REPO_ROOT: fakeRepoRoot }), /__EXIT_1__/);
    assert.ok(errs.join('\n').includes(envFork), 'error should name the env-derived fork path');
  });

  it('GEMINI_CLI_CUES_DIR env var is used when --target is absent', async () => {
    const envFork = path.join(tmpHome, 'env-gemini-fork');
    process.env.GEMINI_CLI_CUES_DIR = envFork;
    await assert.rejects(() => run(['gemini-cli', ...SKIP], { REPO_ROOT: fakeRepoRoot }), /__EXIT_1__/);
    assert.ok(errs.join('\n').includes(envFork), 'error should name the env-derived fork path');
  });

  it('--target for gemini-cli overrides the env var (flag beats env)', async () => {
    process.env.GEMINI_CLI_CUES_DIR = path.join(tmpHome, 'env-fork-should-be-ignored');
    const explicit = path.join(tmpHome, 'flag-fork-wins');
    await assert.rejects(() => run(['gemini-cli', '--target', explicit, ...SKIP], { REPO_ROOT: fakeRepoRoot }), /__EXIT_1__/);
    const out = errs.join('\n');
    assert.ok(out.includes(explicit), 'flag-derived path should be named');
    assert.ok(!out.includes('env-fork-should-be-ignored'), 'env-derived path must be ignored once --target is present');
  });
});

describe('run claude-code — native-binary vs cli.js precedence + --bin override', () => {
  it('a native binary at the fork path is preferred over cli.js and attempted (fails closed — not a real executable)', async () => {
    const binDir = path.join(tmpHome, 'claude-code-cues', 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const nativeBin = path.join(binDir, 'claude.exe');
    fs.writeFileSync(nativeBin, 'not a real PE binary\n');
    // Also drop a cli.js at the lower-priority location to prove native wins.
    const cliJsDir = path.dirname(binDir);
    fs.writeFileSync(path.join(cliJsDir, 'cli.js'), '// not real\n');

    await assert.rejects(() => run(['claude-code', ...SKIP], { REPO_ROOT: fakeRepoRoot }), /__EXIT_127__/);
    const out = errs.join('\n');
    assert.ok(out.includes('failed to launch'), 'spawnSync on the dummy file must fail, not hang or succeed');
    assert.ok(out.includes(nativeBin), 'the attempted binary must be the NATIVE one, proving native-over-cli.js precedence');
  });

  it('--bin overrides the fork detection entirely, splicing --bin/<value> out of the forwarded args', async () => {
    const explicitBin = path.join(tmpHome, 'definitely-not-a-real-binary-xyz');
    await assert.rejects(
      () => run(['claude-code', '--bin', explicitBin, '--continue', ...SKIP], { REPO_ROOT: fakeRepoRoot }),
      /__EXIT_127__/,
    );
    const out = errs.join('\n');
    assert.ok(out.includes('failed to launch'), 'spawnSync on a nonexistent explicit binary must fail closed');
    assert.ok(out.includes(explicitBin), 'the attempted binary must be the --bin override, not a fork-detected path');
  });
});
