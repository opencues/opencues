// Unit tests for the prompt toolkit's SCRIPTING CONTRACT — the part that must
// never break: interactivity is gated on a real TTY, and a prompt called in a
// non-TTY throws (so callers fall back to flags rather than hang). The
// interactive rendering itself is enquirer's job + validated by hand.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

function freshPrompt() {
  delete require.cache[require.resolve('./prompt.cjs')];
  return require('./prompt.cjs');
}

/** Run `fn(prompt)` with process.std{in,out}.isTTY forced to `tty`. */
async function withTTY(tty, fn) {
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
  Object.defineProperty(process, 'stdin', { value: { isTTY: tty }, configurable: true });
  Object.defineProperty(process, 'stdout', { value: { isTTY: tty, write: () => true }, configurable: true });
  try {
    return await fn(freshPrompt());
  } finally {
    Object.defineProperty(process, 'stdin', realIn);
    Object.defineProperty(process, 'stdout', realOut);
  }
}

test('isInteractive: true on a TTY, false off it', async () => {
  await withTTY(true, (prompt) => assert.strictEqual(prompt.isInteractive(), true));
  await withTTY(false, (prompt) => assert.strictEqual(prompt.isInteractive(), false));
});

test('isInteractive: false when OPENCUES_NO_INTERACTIVE is set, even on a TTY', async () => {
  const prev = process.env.OPENCUES_NO_INTERACTIVE;
  process.env.OPENCUES_NO_INTERACTIVE = '1';
  try {
    await withTTY(true, (prompt) => assert.strictEqual(prompt.isInteractive(), false));
  } finally {
    if (prev === undefined) delete process.env.OPENCUES_NO_INTERACTIVE; else process.env.OPENCUES_NO_INTERACTIVE = prev;
  }
});

test('select / confirm throw in a non-TTY (callers must gate + fall back)', async () => {
  await withTTY(false, async (prompt) => {
    await assert.rejects(() => prompt.select('x', [{ label: 'a', value: 'A' }]), /interactive terminal/);
    await assert.rejects(() => prompt.confirm('x'), /interactive terminal/);
  });
});

// ── Driven toolkit tests — fake TTY streams + scripted keystrokes assert the
// RETURN VALUES (not exact rendering, which is validated by hand). Pins the
// select/confirm/input contracts the commands depend on.

const { PassThrough } = require('node:stream');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function drive(makePromise, keys) {
  const stdout = new PassThrough(); stdout.isTTY = true; stdout.columns = 80; stdout.rows = 24;
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  try {
    const p = makePromise(freshPrompt());
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

test('select: Enter picks the focused (first) item', async () => {
  const v = await drive(p => p.select('', [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]), [ENTER]);
  assert.strictEqual(v, 'a');
});

test('select: Down then Enter picks the second item', async () => {
  const v = await drive(p => p.select('', [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]), [DOWN, ENTER]);
  assert.strictEqual(v, 'b');
});

test('select: navigation clamps at the last item (no wrap)', async () => {
  // 5 downs on a 2-item list must stay on the last, not wrap to the first.
  const v = await drive(p => p.select('', [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]), [DOWN, DOWN, DOWN, DOWN, DOWN, ENTER]);
  assert.strictEqual(v, 'b');
});

test('confirm: default No → Enter returns false; Up → Enter returns true', async () => {
  assert.strictEqual(await drive(p => p.confirm('ok?', { default: false }), [ENTER]), false);
  assert.strictEqual(await drive(p => p.confirm('ok?', { default: false }), [UP, ENTER]), true);
});

test('input: Enter accepts the pre-filled default', async () => {
  const v = await drive(p => p.input('name', { default: 'wilfred' }), [ENTER]);
  assert.strictEqual(v, 'wilfred');
});

test('input: a typed value overrides the default', async () => {
  const v = await drive(p => p.input('name', { default: 'wilfred' }), ['z', ENTER]);
  assert.strictEqual(v, 'z');
});
