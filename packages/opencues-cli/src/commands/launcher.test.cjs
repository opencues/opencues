// Tests for `opencues` (no args) — the interactive launcher.
//
// Zero prior coverage. launcher.cjs has two regimes:
//   1. Non-TTY (pipe/CI): falls back to `help(argv, ctx)` verbatim — the
//      scriptable, testable path.
//   2. TTY: an interactive menu loop that requires OTHER command modules
//      (config/set-key/identity/debug/show/install/run/doctor/check-keys)
//      on selection. Driving a full row-selection here would mean also
//      faking each of those submodules' own interactive flows (several of
//      which touch the network or the filesystem) — out of scope for this
//      pass. What IS in scope and fully exercised: entering the loop,
//      rendering the menu + status header, and the Esc/Ctrl-C cancel exit
//      (prompt.select's documented cancelValue-on-cancel contract), which
//      covers launcher.cjs's own control flow without reaching into any
//      submodule. See the file's own header comment for why this split is
//      the right cut line for a runtime-contract test (not an LLM/host
//      content test).
//
// Hermeticity: HOME + USERPROFILE point at a fresh mkdtemp dir per test
// (help.cjs's printStatus reads os.homedir() for the config/keys grid).
// TTY-faking follows lib/prompt.test.cjs's `withTTY`/`drive` pattern
// exactly (fake PassThrough streams — never the real terminal).

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');

const PKG_DIR = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');

let realHome, realUserProfile;
let tmpHome;

beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-launcher-home-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// help.cjs (which launcher falls back to / is driven from) destructures
// `ctx.pkg.version` directly with no fallback — unlike style.cjs's more
// defensive `cliVersion()`. The real cli.cjs dispatcher always supplies a
// fully-formed `{ pkg, PKG_DIR, REPO_ROOT }`, so tests must match that
// shape rather than the partial ctx some other commands tolerate.
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
function ctx() { return { pkg, PKG_DIR, REPO_ROOT }; }

function freshLauncher() {
  delete require.cache[require.resolve('./launcher.cjs')];
  delete require.cache[require.resolve('./help.cjs')];
  delete require.cache[require.resolve('../lib/prompt.cjs')];
  return require('./launcher.cjs');
}

function silence(fn) {
  const origLog = console.log, origErr = console.error;
  const calls = [], errCalls = [];
  console.log = (...a) => calls.push(a.join(' '));
  console.error = (...a) => errCalls.push(a.join(' '));
  return Promise.resolve(fn()).finally(() => { console.log = origLog; console.error = origErr; })
    .then((r) => ({ result: r, calls, errCalls }));
}

/** Force process.std{in,out}.isTTY for the duration of fn(). */
async function withTTY(tty, fn) {
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
  Object.defineProperty(process, 'stdin', { value: { isTTY: tty }, configurable: true });
  Object.defineProperty(process, 'stdout', { value: { isTTY: tty, write: () => true }, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', realIn);
    Object.defineProperty(process, 'stdout', realOut);
  }
}

/** Fake-TTY PassThrough streams driving the real enquirer prompt, mirroring lib/prompt.test.cjs's `drive`. */
async function driveLauncher(argv, keys) {
  const stdout = new PassThrough(); stdout.isTTY = true; stdout.columns = 80; stdout.rows = 24;
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  const origLog = console.log;
  console.log = () => {}; // banner/status noise — not asserted on in the driven tests
  const launcher = freshLauncher();
  try {
    const p = launcher(argv, ctx());
    await new Promise(r => setTimeout(r, 50));
    for (const k of keys) { stdin.write(k); await new Promise(r => setTimeout(r, 25)); }
    await new Promise(r => setTimeout(r, 15));
    return await p;
  } finally {
    console.log = origLog;
    Object.defineProperty(process, 'stdin', realIn);
    Object.defineProperty(process, 'stdout', realOut);
  }
}
const ESC = '\x1b';

// ─── Happy path ────────────────────────────────────────────────────────────

test('happy: non-TTY falls back to help() verbatim (same banner + command list)', async () => {
  await withTTY(false, async () => {
    const launcher = freshLauncher();
    const help = require('./help.cjs');
    const { calls: launcherCalls } = await silence(() => launcher([], ctx()));
    const { calls: helpCalls } = await silence(() => help([], ctx()));
    assert.deepStrictEqual(launcherCalls, helpCalls);
  });
});

test('happy: non-TTY forwards argv through to help() (e.g. a specific command name)', async () => {
  await withTTY(false, async () => {
    const launcher = freshLauncher();
    const help = require('./help.cjs');
    const { calls: launcherCalls } = await silence(() => launcher(['list'], ctx()));
    const { calls: helpCalls } = await silence(() => help(['list'], ctx()));
    assert.deepStrictEqual(launcherCalls, helpCalls);
  });
});

test('happy: on a TTY, Esc immediately cancels without invoking any submodule', async () => {
  const result = await driveLauncher([], [ESC]);
  // launcher returns undefined on `pick == null` (the cancel path) without
  // ever reaching the require(mod)(...) dispatch below it.
  assert.strictEqual(result, undefined);
});

// ─── Edge cases ────────────────────────────────────────────────────────────

test('edge: non-TTY with --no-interactive explicitly set still falls back to help (belt-and-braces)', async () => {
  await withTTY(true, async () => {
    const prevFlag = process.argv.includes('--no-interactive');
    if (!prevFlag) process.argv.push('--no-interactive');
    try {
      const launcher = freshLauncher();
      const help = require('./help.cjs');
      const { calls: launcherCalls } = await silence(() => launcher([], ctx()));
      const { calls: helpCalls } = await silence(() => help([], ctx()));
      assert.deepStrictEqual(launcherCalls, helpCalls);
    } finally {
      if (!prevFlag) process.argv.pop();
    }
  });
});

test('edge: OPENCUES_NO_INTERACTIVE env var forces the non-TTY fallback even with isTTY true', async () => {
  await withTTY(true, async () => {
    const prev = process.env.OPENCUES_NO_INTERACTIVE;
    process.env.OPENCUES_NO_INTERACTIVE = '1';
    try {
      const launcher = freshLauncher();
      const help = require('./help.cjs');
      const { calls: launcherCalls } = await silence(() => launcher([], ctx()));
      const { calls: helpCalls } = await silence(() => help([], ctx()));
      assert.deepStrictEqual(launcherCalls, helpCalls);
    } finally {
      if (prev === undefined) delete process.env.OPENCUES_NO_INTERACTIVE; else process.env.OPENCUES_NO_INTERACTIVE = prev;
    }
  });
});

// ─── Invalid input ─────────────────────────────────────────────────────────

test('invalid: unrecognised argv passed through in the non-TTY path does not crash help()', async () => {
  await withTTY(false, async () => {
    const launcher = freshLauncher();
    await assert.doesNotReject(() => silence(() => launcher(['--totally-not-a-real-flag'], ctx())));
  });
});

test('invalid: an unknown subcommand name forwarded through non-TTY help() prints "unknown command", not a crash', async () => {
  await withTTY(false, async () => {
    const launcher = freshLauncher();
    const { errCalls } = await silence(() => launcher(['not-a-real-command'], ctx()));
    assert.ok(errCalls.some(l => l.includes('unknown command')));
  });
});
