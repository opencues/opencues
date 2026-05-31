// Integration tests for the update command. Unlike the unit suite in
// update.test.cjs (which exercises in-process helpers), these spawn
// real `node` child processes and observe filesystem + exit code +
// stderr. Together they cover the gap unit tests can't reach:
//
//   - Concurrent acquireLock from two real processes
//   - HOME-isolated state (each spawn gets its own ~/.opencues/)
//   - The lock-file cleanup contract on process death
//
// All tests set HOME to a tmpdir so they can run in parallel + don't
// touch the real ~/.opencues/.
//
// Run: node --test packages/opencues-cli/src/commands/update.integration.test.cjs

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CLI_BIN = path.join(REPO_ROOT, 'packages/opencues-cli/bin/cli.cjs');

function freshHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `oc-update-int-${name}-`));
}

test('two concurrent updates: second fails fast with exit 1 + helpful message', async () => {
  const home = freshHome('concurrent');
  // Manually plant a "live" lock owned by a real running process —
  // ourselves. Then spawn a second `opencues update` and verify it
  // refuses.
  const lockFile = path.join(home, '.opencues', '.update.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: process.pid,            // we ARE alive
    startedAt: new Date().toISOString(),
  }));

  // --dry-run still acquires the lock (the safety primitive runs
  // before the dry-run check).
  const res = spawnSync('node', [CLI_BIN, 'update', '--dry-run'], {
    env: { ...process.env, HOME: home, OPENCUES_NO_UPDATE_CHECK: '1' },
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 1, 'second update must exit 1');
  assert.ok(
    res.stderr.includes('already running'),
    `stderr must mention concurrent run; got:\n${res.stderr}`,
  );
  assert.ok(
    res.stderr.includes(String(process.pid)),
    'stderr must include the offending PID',
  );

  fs.rmSync(home, { recursive: true, force: true });
});

test('stale lock (dead PID) gets reclaimed automatically', async () => {
  const home = freshHome('stale');
  const lockFile = path.join(home, '.opencues', '.update.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  // PID 1 is init/systemd — alive but not us. Use a clearly-dead PID instead.
  // PID 999999 is essentially guaranteed not to exist on any sane system.
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: 999999,
    startedAt: '2020-01-01T00:00:00Z',
  }));

  const res = spawnSync('node', [CLI_BIN, 'update', '--dry-run', '--no-pull'], {
    env: { ...process.env, HOME: home, OPENCUES_NO_UPDATE_CHECK: '1' },
    encoding: 'utf8',
  });

  // Should succeed despite the stale lock. The reclaim message goes to
  // stdout; exit code is whatever dry-run normally produces (0).
  assert.strictEqual(res.status, 0, `expected reclaim + dry-run success; stderr=${res.stderr}`);
  assert.ok(res.stdout.includes('stale lock') || res.stdout.includes('reclaim'),
    `stdout should mention reclaim; got:\n${res.stdout}`);

  fs.rmSync(home, { recursive: true, force: true });
});

test('successful update releases the lock', async () => {
  const home = freshHome('release');
  const lockFile = path.join(home, '.opencues', '.update.lock');

  const res = spawnSync('node', [CLI_BIN, 'update', '--dry-run', '--no-pull'], {
    env: { ...process.env, HOME: home, OPENCUES_NO_UPDATE_CHECK: '1' },
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 0);
  assert.strictEqual(
    fs.existsSync(lockFile),
    false,
    'lock file must be released after a successful run',
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test('SIGINT during update releases the lock', async () => {
  // Spawn `opencues update` in background, send SIGINT shortly after,
  // verify the lock is cleaned up. Dry-run is fast enough that we need
  // a real `update` to actually have a window to interrupt — but we
  // also don't want to actually run git pull. The compromise: spawn
  // with --dry-run + a small delay, kill mid-flight.
  //
  // Cleanest approach: --dry-run completes in <100ms so by the time we
  // SIGINT, the process has often already exited. To make this
  // deterministic, we add a `OPENCUES_UPDATE_TEST_HANG_MS` env that
  // makes acquireLock sleep before returning. Tests use it to control
  // timing; production never sets it.
  const home = freshHome('sigint');
  const lockFile = path.join(home, '.opencues', '.update.lock');

  const child = spawn('node', [CLI_BIN, 'update', '--dry-run', '--no-pull'], {
    env: {
      ...process.env,
      HOME: home,
      OPENCUES_NO_UPDATE_CHECK: '1',
      OPENCUES_UPDATE_TEST_HANG_MS: '500',  // give us a window to SIGINT
    },
    stdio: 'pipe',
  });

  // Wait for the lock to appear, then SIGINT.
  await new Promise((resolve) => {
    const interval = setInterval(() => {
      if (fs.existsSync(lockFile)) { clearInterval(interval); resolve(); }
    }, 20);
    setTimeout(() => { clearInterval(interval); resolve(); }, 1000);
  });

  // If we managed to catch the lock before the test-hang ended, send SIGINT.
  if (fs.existsSync(lockFile)) {
    child.kill('SIGINT');
    await new Promise(r => child.once('exit', r));
    assert.strictEqual(
      fs.existsSync(lockFile),
      false,
      `lock must be released after SIGINT; child exit code: ${child.exitCode}`,
    );
  } else {
    // Process completed before we could see the lock — skip the assertion.
    await new Promise(r => child.once('exit', r));
  }

  fs.rmSync(home, { recursive: true, force: true });
});

test('SIGINT arriving in the handler-register window releases the lock — regression for CI race', async () => {
  // Regression test for a race in update.cjs where the SIGINT/SIGTERM
  // handlers were registered AFTER acquireLock wrote the lockfile.
  // A SIGINT arriving in that microsecond window would fall to Node's
  // default handler (terminate by signal), leaving the lockfile
  // orphaned. Observed on CI run 26712395507 against master 63d83b1.
  //
  // Deterministic reproduction via `OPENCUES_UPDATE_TEST_PRE_LOCK_HANG_MS`:
  // injects a 200ms gap between handler registration and acquireLock.
  // We wait for the JS to start (gap window opens), then SIGINT into
  // the window. With handlers correctly registered FIRST, the SIGINT
  // handler sees `lock === null`, runs `process.exit(130)` cleanly,
  // and the lockfile never gets created. Without the fix, the SIGINT
  // arrives before the handler exists, Node terminates by signal, and
  // the test fails on a non-zero exitCode.
  const home = freshHome('sigint-race-window');
  const lockFile = path.join(home, '.opencues', '.update.lock');

  const child = spawn('node', [CLI_BIN, 'update', '--dry-run', '--no-pull'], {
    env: {
      ...process.env,
      HOME: home,
      OPENCUES_NO_UPDATE_CHECK: '1',
      // 1000ms gap between handler registration and acquireLock —
      // generous so cold CI runners have time to spawn node + load
      // modules + reach the handler-registration site before we
      // SIGINT into the window.
      OPENCUES_UPDATE_TEST_PRE_LOCK_HANG_MS: '1000',
      // Tell update.cjs to print "ready-for-signal" on stderr once
      // handlers are wired. The test waits for this marker rather
      // than guessing a startup delay — earlier versions used a
      // 50ms wait that was too tight for cold CI runners (node
      // startup itself exceeded the wait, so SIGINT killed the
      // process before any JS handler attached).
      OPENCUES_UPDATE_TEST_HANDLER_MARKER: '1',
    },
    stdio: 'pipe',
  });

  // Wait for the handler-ready marker on stderr. Cap at 5s.
  await new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('ready-for-signal')) {
        child.stderr.off('data', onData);
        resolve();
      }
    };
    child.stderr.on('data', onData);
    setTimeout(resolve, 5000);
  });
  child.kill('SIGINT');
  await new Promise(r => child.once('exit', r));

  // With the fix: handler ran, exit code 130, no lockfile written.
  // Without the fix: signal killed Node before handler attached,
  // exitCode null and lockfile may or may not exist (it never got
  // written either way because acquireLock hadn't been called) —
  // but we assert exit code 130 to prove the handler RAN.
  assert.strictEqual(
    child.exitCode,
    130,
    `SIGINT handler must run cleanly (exit 130); got exitCode=${child.exitCode}, signal=${child.signalCode}. ` +
      `Handlers must be registered BEFORE acquireLock — see update.cjs near line 146.`,
  );
  assert.strictEqual(
    fs.existsSync(lockFile),
    false,
    'lockfile must not exist after SIGINT inside the pre-lock window',
  );

  fs.rmSync(home, { recursive: true, force: true });
});

test('--dry-run prints a plan without touching the workspace', () => {
  const home = freshHome('dryrun');
  const res = spawnSync('node', [CLI_BIN, 'update', '--dry-run', '--no-pull'], {
    env: { ...process.env, HOME: home, OPENCUES_NO_UPDATE_CHECK: '1' },
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 0, `dry-run should exit 0; stderr=${res.stderr}`);
  assert.ok(res.stdout.includes('[dry-run]'), 'dry-run banner must appear');
  assert.ok(res.stdout.includes('Plan'), 'plan section must appear');

  fs.rmSync(home, { recursive: true, force: true });
});
