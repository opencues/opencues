// Tests for `lib/pick-host.cjs` — the shared interactive host picker used
// by install/uninstall/run. No prior coverage existed. Uses the same
// fake-TTY-stream driving pattern as `prompt.test.cjs` (pickHost is a thin
// wrapper over `prompt.select`, so we drive it the same way).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

function freshPickHost() {
  delete require.cache[require.resolve('./pick-host.cjs')];
  delete require.cache[require.resolve('./prompt.cjs')];
  return require('./pick-host.cjs');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function drive(makePromise, keys) {
  const stdout = new PassThrough(); stdout.isTTY = true; stdout.columns = 80; stdout.rows = 24;
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  try {
    const p = makePromise(freshPickHost());
    await sleep(50);
    for (const k of keys) { stdin.write(k); await sleep(25); }
    await sleep(15);
    return await p;
  } finally {
    Object.defineProperty(process, 'stdin', realIn);
    Object.defineProperty(process, 'stdout', realOut);
  }
}
const ENTER = '\r', DOWN = '\x1b[B', UP = '\x1b[A';

function silenceLog(fn) {
  const orig = console.log;
  console.log = () => {};
  return fn().finally(() => { console.log = orig; });
}

// ─── Happy path ────────────────────────────────────────────────────────────

test('happy: Enter picks the first host', async () => {
  const v = await silenceLog(() => drive(
    ({ pickHost }) => pickHost(['claude-code', 'opencode'], { verb: 'Install which host' }),
    [ENTER],
  ));
  assert.strictEqual(v, 'claude-code');
});

test('happy: Down then Enter picks the second host', async () => {
  const v = await silenceLog(() => drive(
    ({ pickHost }) => pickHost(['claude-code', 'opencode'], {}),
    [DOWN, ENTER],
  ));
  assert.strictEqual(v, 'opencode');
});

test('happy: navigating to the Cancel row returns null', async () => {
  // 2 hosts + spacer + Cancel: Down x2 lands on Cancel (spacer is
  // non-selectable and skipped by the clamp/selectable-index logic).
  const v = await silenceLog(() => drive(
    ({ pickHost }) => pickHost(['claude-code', 'opencode'], {}),
    [DOWN, DOWN, ENTER],
  ));
  assert.strictEqual(v, null);
});

// ─── Edge cases ────────────────────────────────────────────────────────────

test('edge: opts.allowAll adds an --all choice as the second row', async () => {
  const v = await silenceLog(() => drive(
    ({ pickHost }) => pickHost(['claude-code', 'opencode'], { allowAll: true }),
    [DOWN, DOWN, ENTER], // claude-code -> opencode -> all
  ));
  assert.strictEqual(v, '--all');
});

test('edge: single-host list — Enter picks the only host', async () => {
  const v = await silenceLog(() => drive(
    ({ pickHost }) => pickHost(['claude-code'], {}),
    [ENTER],
  ));
  assert.strictEqual(v, 'claude-code');
});

test('edge: custom verb text is printed before the menu', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await drive(
      ({ pickHost }) => pickHost(['claude-code'], { verb: 'Which host to nuke' }),
      [ENTER],
    );
  } finally {
    console.log = orig;
  }
  assert.ok(
    logs.some(l => l.includes('Which host to nuke')),
    `expected the custom verb in printed output, got: ${JSON.stringify(logs)}`,
  );
});

// ─── Invalid input ─────────────────────────────────────────────────────────

test('invalid: empty hosts array — only spacer + Cancel are selectable, Enter cancels', async () => {
  const v = await silenceLog(() => drive(
    ({ pickHost }) => pickHost([], {}),
    [ENTER],
  ));
  assert.strictEqual(v, null);
});

test('invalid: Ctrl-C (Esc) during selection resolves to null, not a rejection', async () => {
  const ESC = '\x1b';
  const v = await silenceLog(() => drive(
    ({ pickHost }) => pickHost(['claude-code', 'opencode'], {}),
    [ESC],
  ));
  assert.strictEqual(v, null);
});
