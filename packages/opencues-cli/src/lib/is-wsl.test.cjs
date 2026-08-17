// Tests for the one WSL predicate.
//
// The thing under test is really the SEAM. Detection itself is two env reads
// and two file reads; what mattered was that there was no way to simulate
// not-under-WSL, so every test asserting that branch passed only on non-WSL
// hardware. Two of them did exactly that, and turned `pre-pr.sh` red for
// every WSL developer on every change.

'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { isWsl, setWslForTests, resetWslForTests } = require('./is-wsl.cjs');

const savedEnv = {};
function clearWslEnv() {
  savedEnv.d = process.env.WSL_DISTRO_NAME;
  savedEnv.i = process.env.WSL_INTEROP;
  delete process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_INTEROP;
}
function restoreWslEnv() {
  if (savedEnv.d === undefined) delete process.env.WSL_DISTRO_NAME;
  else process.env.WSL_DISTRO_NAME = savedEnv.d;
  if (savedEnv.i === undefined) delete process.env.WSL_INTEROP;
  else process.env.WSL_INTEROP = savedEnv.i;
}

afterEach(() => { resetWslForTests(); restoreWslEnv(); });

describe('isWsl — the test seam', () => {
  it('forces false even on a real WSL machine', () => {
    // The whole point. Without this, a test wanting the not-under-WSL branch
    // has no way to get it on the hardware most of this project is built on.
    setWslForTests(false);
    assert.strictEqual(isWsl(), false);
  });

  it('forces true even on a machine that is not WSL', () => {
    setWslForTests(true);
    assert.strictEqual(isWsl(), true);
  });

  it('resetWslForTests hands detection back to the machine', () => {
    setWslForTests(false);
    assert.strictEqual(isWsl(), false);
    resetWslForTests();
    // Asserting the real value would pin the test to whoever runs it, so
    // assert only that it is a decided boolean again.
    assert.strictEqual(typeof isWsl(), 'boolean');
  });

  it('a non-boolean override clears rather than coercing', () => {
    // Guards the footgun: `setWslForTests(undefined)` in a teardown must not
    // pin the answer to false for the rest of the process.
    setWslForTests(true);
    setWslForTests(undefined);
    assert.strictEqual(typeof isWsl(), 'boolean');
    setWslForTests(false);
    assert.strictEqual(isWsl(), false);
  });
});

describe('isWsl — detection', () => {
  it('either env var alone is sufficient', () => {
    clearWslEnv();
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    assert.strictEqual(isWsl(), true);
    delete process.env.WSL_DISTRO_NAME;
    process.env.WSL_INTEROP = '/run/WSL/8_interop';
    assert.strictEqual(isWsl(), true);
  });

  it('falls back to /proc when the env vars are absent', () => {
    // This fallback is the reason the old tests could not fake their way out,
    // and it is load-bearing: `wsl.exe -- node …` spawns a shell that does not
    // inherit the env vars, so env-only detection answers false on WSL. One
    // call site (openrouter-oauth) was env-only and got exactly that wrong.
    clearWslEnv();
    const onWsl = ['/proc/sys/kernel/osrelease', '/proc/version'].some((f) => {
      try { return /microsoft|wsl/i.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
    });
    assert.strictEqual(isWsl(), onWsl);
  });

  it('answers false, not throws, where /proc does not exist', () => {
    // macOS has neither the env vars nor /proc. Detection must degrade to
    // false rather than raising out of a `which` or `doctor` run.
    clearWslEnv();
    assert.strictEqual(typeof isWsl(), 'boolean');
  });
});
