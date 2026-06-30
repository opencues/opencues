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
