// Tests for `opencues cleanup` — orphan host-process finder/killer.
//
// HERMETICITY: this command never touches the filesystem or $HOME — it
// only shells out to `ps` (via `node:child_process`'s `spawnSync`) and
// sends signals via `process.kill`. Both are stubbed out below so the
// suite can never (a) shell out to the real `ps` on this machine or
// (b) send a real SIGTERM/SIGKILL to a real pid. `spawnSync` is
// destructured by cleanup.cjs at require-time (`const { spawnSync } =
// require('node:child_process')`), so the stub MUST be installed on the
// `node:child_process` module BEFORE cleanup.cjs is first required —
// otherwise cleanup.cjs would have already captured the real function
// reference. `process.kill` is read live (not destructured), so it can
// be swapped freely per-test.

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const cp = require('node:child_process');
const realSpawnSync = cp.spawnSync;
let fakePsOutput = '';
let fakePsStatus = 0;
cp.spawnSync = (cmd, args, opts) => {
  if (cmd === 'ps') return { status: fakePsStatus, stdout: Buffer.from(fakePsOutput) };
  return realSpawnSync(cmd, args, opts);
};

// eslint-disable-next-line import/order -- must load after the stub above
const cleanup = require('./cleanup.cjs');

after(() => { cp.spawnSync = realSpawnSync; });

const realKill = process.kill;
let killBehavior = () => true; // default: every kill "succeeds"
process.kill = (pid, sig) => {
  if (!killBehavior(pid, sig)) { const e = new Error('EPERM (fake)'); throw e; }
  return true;
};
after(() => { process.kill = realKill; });

beforeEach(() => {
  fakePsOutput = '';
  fakePsStatus = 0;
  killBehavior = () => true;
});

function psLine(pid, ppid, elapsed, args) {
  return `${pid} ${ppid} ${elapsed} ${args}`;
}

function capture(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  process.stdout.write = (chunk) => { logs.push(String(chunk)); return true; };
  let ret;
  try { ret = fn(); }
  finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
  }
  return { ret, logs: logs.join('\n'), errs: errs.join('\n') };
}

// ─── Happy path ─────────────────────────────────────────────────────────────

test('happy: lists a matching orphan process (claude-code) without --kill', () => {
  fakePsOutput = psLine(88888, 1, '01:00:00', '/usr/bin/node /home/user/claude-code-cues/cli.js --flag') + '\n';
  const { ret, logs } = capture(() => cleanup([], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /Found 1 orphan process/);
  assert.match(logs, /88888/);
  assert.match(logs, /claude-code/);
});

test('happy: reports no orphans when ps output has no host matches', () => {
  fakePsOutput = psLine(1, 0, '10:00', '/sbin/init') + '\n';
  const { ret, logs } = capture(() => cleanup([], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /no orphan host processes/);
});

test('happy: --json prints a machine-readable report', () => {
  fakePsOutput = psLine(77777, 1, '00:05', 'bun run --cwd packages/opencode dev') + '\n';
  const { ret, logs } = capture(() => cleanup(['--json'], {}));
  assert.strictEqual(ret, 0);
  const report = JSON.parse(logs);
  assert.strictEqual(report.found, 1);
  assert.strictEqual(report.killed, 0);
  assert.strictEqual(report.orphans[0].pid, 77777);
  assert.strictEqual(report.orphans[0].host, 'opencode');
});

test('happy: --kill SIGTERMs matched orphans and reports success', () => {
  fakePsOutput = psLine(66666, 1, '00:05', 'bun run --cwd packages/opencode dev') + '\n';
  killBehavior = () => true;
  const { ret, logs } = capture(() => cleanup(['--kill'], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /killed 66666/);
  assert.match(logs, /SIGTERM 1\/1/);
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test('edge: --host restricts the scan to one host', () => {
  fakePsOutput = [
    psLine(55555, 1, '00:01', '/usr/bin/node /home/user/claude-code-cues/cli.js'),
    psLine(55556, 1, '00:01', 'bun run --cwd packages/opencode dev'),
  ].join('\n') + '\n';
  const { ret, logs } = capture(() => cleanup(['--host', 'opencode'], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /55556/);
  assert.doesNotMatch(logs, /55555/);
});

test('edge: --project filters orphans whose args do not contain the path', () => {
  fakePsOutput = [
    psLine(44444, 1, '00:01', 'bun run --cwd packages/opencode dev --project /home/alice/book'),
    psLine(44445, 1, '00:01', 'bun run --cwd packages/opencode dev --project /home/bob/book'),
  ].join('\n') + '\n';
  const { ret, logs } = capture(() => cleanup(['--project', '/home/alice/book'], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /44444/);
  assert.doesNotMatch(logs, /44445/);
});

test('edge: --quiet suppresses stdout on a fully successful --kill', () => {
  fakePsOutput = psLine(33333, 1, '00:01', 'bun run --cwd packages/opencode dev') + '\n';
  killBehavior = () => true;
  const { ret, logs, errs } = capture(() => cleanup(['--kill', '--quiet'], {}));
  assert.strictEqual(ret, 0);
  assert.strictEqual(logs.trim(), '');
  assert.strictEqual(errs.trim(), '');
});

test('edge: --help prints usage without scanning processes', () => {
  fakePsOutput = ''; // must not matter — usage() returns before any scan
  const { ret, logs } = capture(() => cleanup(['--help'], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /opencues cleanup/);
});

test('edge: ps itself failing (non-zero status) degrades to "no orphans" rather than crashing', () => {
  fakePsStatus = 1;
  fakePsOutput = '';
  const { ret, logs } = capture(() => cleanup([], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /no orphan host processes/);
});

test('edge: --force without --kill is a no-op (still just lists)', () => {
  fakePsOutput = psLine(11111, 1, '00:01', 'bun run --cwd packages/opencode dev') + '\n';
  const { ret, logs } = capture(() => cleanup(['--force'], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /Found 1 orphan/);
});

test('preflightKill: silently kills matches and returns a found/killed summary', () => {
  fakePsOutput = psLine(10101, 1, '00:01', 'bun run --cwd packages/opencode dev') + '\n';
  killBehavior = () => true;
  const { found, killed } = cleanup.preflightKill({ host: null, project: null });
  assert.strictEqual(found, 1);
  assert.strictEqual(killed, 1);
});

// ─── Invalid input ──────────────────────────────────────────────────────────

test('invalid: unknown --host errors with exit code 2', () => {
  const { ret, errs } = capture(() => cleanup(['--host', 'not-a-real-host'], {}));
  assert.strictEqual(ret, 2);
  assert.match(errs, /unknown host/);
});

test('invalid: --kill reports failures and returns exit code 1 when a signal cannot be delivered', () => {
  fakePsOutput = psLine(22222, 1, '00:01', 'bun run --cwd packages/opencode dev') + '\n';
  killBehavior = () => false;
  const { ret, logs, errs } = capture(() => cleanup(['--kill'], {}));
  assert.strictEqual(ret, 1);
  assert.match(errs, /failed 22222/);
  assert.match(logs, /1 failed/);
});

// ─── Known bug ──────────────────────────────────────────────────────────────
//
// HOST_MATCHERS['gemini-cli'] = ['node .*gemini-cli'] reads like a regex
// but is a plain JS string (no `/.../` literal). findOrphans only runs
// `.test()` on entries that are `instanceof RegExp` — a string entry is
// matched with `p.args.includes(pat)`, which requires the LITERAL text
// "node .*gemini-cli" (including the two literal characters `.` and `*`)
// to appear in the ps line. A real gemini-cli invocation's args (e.g.
// "node /home/user/.opencues/gemini-cli/bundle/gemini.js") never contains
// that literal substring, so this host can never be detected as an
// orphan — cleanup --host gemini-cli is permanently a no-op.
//
// Expected: findOrphans treats the entry as a regex and matches a
// realistic gemini-cli process line.
// Proposed fix: store the entry as a RegExp literal (/node .*gemini-cli/)
// in HOST_MATCHERS instead of the string "node .*gemini-cli".
test('BUG: gemini-cli matcher is a literal string, so it never matches a real process line', { todo: true }, () => {
  fakePsOutput = psLine(20202, 1, '00:01', 'node /home/user/.opencues/gemini-cli/bundle/gemini.js') + '\n';
  const { ret, logs } = capture(() => cleanup(['--host', 'gemini-cli'], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /20202/); // currently fails: actual output is "no orphan host processes"
});
