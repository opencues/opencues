// Unit tests for the prompt toolkit. Uses `prompts.inject()` (the library's
// own test hook) to drive select/confirm without a real terminal, behind a
// faked-TTY guard so isInteractive() passes.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const prompts = require('prompts');

/** Run `fn(prompt)` with process.std{in,out}.isTTY forced true. */
async function withTTY(fn) {
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
  const realEnv = process.env.OPENCUES_NO_INTERACTIVE;
  delete process.env.OPENCUES_NO_INTERACTIVE;
  Object.defineProperty(process, 'stdin', { value: { isTTY: true }, configurable: true });
  Object.defineProperty(process, 'stdout', { value: { isTTY: true, write: () => true, columns: 80, rows: 24 }, configurable: true });
  delete require.cache[require.resolve('./prompt.cjs')];
  const prompt = require('./prompt.cjs');
  try {
    return await fn(prompt);
  } finally {
    Object.defineProperty(process, 'stdin', realIn);
    Object.defineProperty(process, 'stdout', realOut);
    if (realEnv !== undefined) process.env.OPENCUES_NO_INTERACTIVE = realEnv;
    delete require.cache[require.resolve('./prompt.cjs')];
  }
}

test('select: returns the chosen choice value', async () => {
  await withTTY(async (prompt) => {
    prompts.inject([{ toggle: 'myfetch' }]);
    const v = await prompt.select('pick', [
      { label: 'a', value: 'A', disabled: true },
      { label: 'myfetch', value: { toggle: 'myfetch' } },
      { label: 'done', value: { done: true } },
    ]);
    assert.deepStrictEqual(v, { toggle: 'myfetch' });
  });
});

test('select: cancel → null', async () => {
  await withTTY(async (prompt) => {
    prompts.inject([new Error('cancel')]); // injecting an Error simulates cancel
    const v = await prompt.select('pick', [{ label: 'a', value: 'A' }]);
    assert.strictEqual(v, null);
  });
});

test('confirm: returns the injected boolean', async () => {
  await withTTY(async (prompt) => {
    prompts.inject([true]);
    assert.strictEqual(await prompt.confirm('ok?'), true);
  });
});

test('confirm: cancel falls back to the default', async () => {
  await withTTY(async (prompt) => {
    prompts.inject([new Error('cancel')]);
    assert.strictEqual(await prompt.confirm('ok?', { default: true }), true);
  });
});

test('isInteractive: false in a non-TTY (piped) context', () => {
  // The test runner's stdin is not a TTY → interactive must be off.
  delete require.cache[require.resolve('./prompt.cjs')];
  const prompt = require('./prompt.cjs');
  assert.strictEqual(prompt.isInteractive(), false);
});

test('select: throws in a non-TTY (callers must gate + fall back)', async () => {
  delete require.cache[require.resolve('./prompt.cjs')];
  const prompt = require('./prompt.cjs');
  await assert.rejects(() => prompt.select('x', [{ label: 'a', value: 'A' }]), /interactive terminal/);
});
