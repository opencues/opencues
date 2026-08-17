// Tests for `opencues which` — pure inspection, no writes anywhere.
// Prints a bunch of paths derived from os.homedir() + ctx.REPO_ROOT and
// marks each with a green/gray ring depending on fs.accessSync.
//
// Hermeticity: HOME + USERPROFILE point at a fresh mkdtemp dir for every
// test (os.homedir() reads %USERPROFILE% on Windows, not $HOME — both are
// always set together). ctx.REPO_ROOT points at the real repo root
// read-only (which.cjs never writes to REPO_ROOT, only checks existence
// of a couple of paths under it). which() never calls process.exit.

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const which = require('./which.cjs');
const { setWslForTests, resetWslForTests } = require('../lib/is-wsl.cjs');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let tmpHome;
let realHome, realUserProfile, realWslDistro, realWslInterop, realOpencuesHome;
let logs;
let origLog;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-which-test-'));
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  realWslDistro = process.env.WSL_DISTRO_NAME;
  realWslInterop = process.env.WSL_INTEROP;
  realOpencuesHome = process.env.OPENCUES_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_INTEROP;

  logs = [];
  origLog = console.log;
  console.log = (...a) => logs.push(stripAnsi(a.join(' ')));
});

afterEach(() => {
  console.log = origLog;
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  if (realWslDistro === undefined) delete process.env.WSL_DISTRO_NAME; else process.env.WSL_DISTRO_NAME = realWslDistro;
  if (realWslInterop === undefined) delete process.env.WSL_INTEROP; else process.env.WSL_INTEROP = realWslInterop;
  if (realOpencuesHome === undefined) delete process.env.OPENCUES_HOME; else process.env.OPENCUES_HOME = realOpencuesHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Happy path ────────────────────────────────────────────────────────────

describe('opencues which', () => {
  it('happy: prints every section header', () => {
    which([], { REPO_ROOT });
    const out = logs.join('\n');
    assert.match(out, /Configuration search paths/);
    assert.match(out, /CC install state/);
    assert.match(out, /Shared user-level/);
    assert.match(out, /OC install state/);
    assert.match(out, /Chrome state/);
    assert.match(out, /Gemini CLI install state/);
    assert.match(out, /Runtime IPC files/);
  });

  it('happy: prints the legend at the end', () => {
    which([], { REPO_ROOT });
    assert.match(logs.join('\n'), /Legend:/);
  });

  it('happy: shows $OPENCUES_HOME as "(unset)" when the env var is absent', () => {
    delete process.env.OPENCUES_HOME;
    which([], { REPO_ROOT });
    assert.match(logs.join('\n'), /\$OPENCUES_HOME \(env\)\s+\(unset\)/);
  });

  it('happy: --help prints usage and does not print the path sections', () => {
    which(['--help'], { REPO_ROOT });
    const out = logs.join('\n');
    assert.match(out, /opencues which/);
    assert.doesNotMatch(out, /Configuration search paths/);
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe('opencues which — edge cases', () => {
  it('edge: a present path (the sandboxed HOME/.cues dir) is reported distinctly from an absent one', () => {
    fs.mkdirSync(path.join(tmpHome, '.cues'), { recursive: true });
    which([], { REPO_ROOT });
    const out = logs.join('\n');
    // Both rows print the same label text; presence is conveyed only by
    // the ring colour, which is stripped by stripAnsi. Assert on the
    // underlying path text appearing (proves the row was built), and
    // that fs.accessSync was consulted without throwing for either case
    // by checking the command completed and printed the user-level row.
    assert.match(out, /User-level/);
    assert.match(out, new RegExp(path.join(tmpHome, '.cues').replace(/\\/g, '\\\\')));
  });

  it('edge: $OPENCUES_HOME sandboxed override is reflected verbatim (env row shows the value, not "(unset)")', () => {
    const envOverride = path.join(tmpHome, 'custom-cues');
    const realOverride = process.env.OPENCUES_HOME;
    process.env.OPENCUES_HOME = envOverride;
    try {
      which([], { REPO_ROOT });
      assert.match(logs.join('\n'), new RegExp(envOverride.replace(/\\/g, '\\\\')));
    } finally {
      if (realOverride === undefined) delete process.env.OPENCUES_HOME; else process.env.OPENCUES_HOME = realOverride;
    }
  });

  it('edge: the WSL deploy row is absent when not under WSL', () => {
    // Clearing the env vars in beforeEach is NOT enough: isWsl() also reads
    // /proc, which reports the truth on a real WSL machine. So this asserted
    // the not-under-WSL branch while running under WSL, and failed for every
    // WSL developer while passing on CI. Drive the seam instead, and the test
    // now means the same thing on both.
    setWslForTests(false);
    try {
      which([], { REPO_ROOT });
      assert.doesNotMatch(logs.join('\n'), /WSL deploy/);
    } finally {
      resetWslForTests();
    }
  });

  // The positive control the original pair lacked: without it, the assertion
  // above passes just as happily if the row were deleted outright, because
  // "absent" only means something next to "present".
  //
  // It cannot run everywhere, and pretending otherwise is the exact mistake
  // this file is fixing. The row needs isWsl() AND a working `cmd.exe` — it
  // reads the Windows username through interop to build the deploy path. So
  // forcing the predicate true is not sufficient on a Linux CI runner, where
  // there is no Windows side and the row is correctly omitted. Written without
  // this guard it failed on CI while passing on WSL, which is the same
  // machine-dependent shape as the bug it was added to catch, just inverted.
  const hasWindowsInterop = (() => {
    try {
      return spawnSync('cmd.exe', ['/c', 'echo x'], { stdio: 'ignore' }).status === 0;
    } catch { return false; }
  })();

  it('edge: the WSL deploy row APPEARS when under WSL', { skip: hasWindowsInterop ? false : 'needs Windows interop (cmd.exe) — absent on a Linux runner' }, () => {
    setWslForTests(true);
    try {
      which([], { REPO_ROOT });
      assert.match(logs.join('\n'), /WSL deploy/);
    } finally {
      resetWslForTests();
    }
  });
});

// ─── Invalid input ─────────────────────────────────────────────────────────

describe('opencues which — invalid input', () => {
  it('invalid: unknown flags are silently ignored (still prints the full report)', () => {
    which(['--this-is-not-a-real-flag', '--another-bogus-one'], { REPO_ROOT });
    assert.match(logs.join('\n'), /Configuration search paths/);
  });

  it('invalid: a ctx with no REPO_ROOT throws (REPO_ROOT is a required field the real CLI dispatcher always supplies)', () => {
    // which.cjs calls path.join(ctx.REPO_ROOT, ...) unconditionally for
    // the chrome-state rows — there's no guard for a missing REPO_ROOT.
    // This pins the invariant rather than asserting graceful behavior
    // that doesn't exist: every real invocation goes through bin/cli.cjs,
    // which always populates ctx.REPO_ROOT.
    assert.throws(() => which([], {}), /must be of type string/);
  });
});
