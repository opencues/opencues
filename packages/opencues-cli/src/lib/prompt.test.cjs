// Unit tests for the zero-dep prompt toolkit. Drives `select`/`confirm` with a
// fake interactive stdin/stdout (EventEmitter) + synthetic keypress events, so
// the navigation + parse logic is pinned without a real terminal.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

function makeFakeStdin() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = (v) => { s.isRaw = v; };
  s.resume = () => {};
  s.pause = () => {};
  s.setEncoding = () => {};
  return s;
}
function makeFakeStdout() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.columns = 80;
  s.rows = 24;
  s.write = () => true; // swallow render output (incl. readline cursor escapes)
  return s;
}

/** Swap in fake TTY streams, run `fn(stdin)`, restore. */
async function withFakeTTY(fn) {
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
  const realEnv = process.env.OPENCUES_NO_INTERACTIVE;
  delete process.env.OPENCUES_NO_INTERACTIVE;
  const stdin = makeFakeStdin();
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: makeFakeStdout(), configurable: true });
  // Fresh require so isInteractive() reads the swapped streams.
  delete require.cache[require.resolve('./prompt.cjs')];
  const prompt = require('./prompt.cjs');
  try {
    return await fn(prompt, stdin);
  } finally {
    Object.defineProperty(process, 'stdin', realIn);
    Object.defineProperty(process, 'stdout', realOut);
    if (realEnv !== undefined) process.env.OPENCUES_NO_INTERACTIVE = realEnv;
    delete require.cache[require.resolve('./prompt.cjs')];
  }
}

// Emit keypress events on the next tick so select's listener is attached first.
function feed(stdin, keys) {
  let i = 0;
  const tick = () => {
    if (i >= keys.length) return;
    const name = keys[i++];
    stdin.emit('keypress', '', { name });
    setImmediate(tick);
  };
  setImmediate(tick);
}

test('select: down then enter picks the second choice', async () => {
  const val = await withFakeTTY(async (prompt, stdin) => {
    const p = prompt.select('pick', [
      { label: 'a', value: 'A' },
      { label: 'b', value: 'B' },
      { label: 'c', value: 'C' },
    ]);
    feed(stdin, ['down', 'return']);
    return p;
  });
  assert.strictEqual(val, 'B');
});

test('select: skips a disabled first row when moving', async () => {
  const val = await withFakeTTY(async (prompt, stdin) => {
    const p = prompt.select('pick', [
      { label: 'header', value: null, disabled: true },
      { label: 'x', value: 'X' },
      { label: 'y', value: 'Y' },
    ]);
    feed(stdin, ['down', 'return']); // starts on X (first enabled), down → Y
    return p;
  });
  assert.strictEqual(val, 'Y');
});

test('select: q cancels → null', async () => {
  const val = await withFakeTTY(async (prompt, stdin) => {
    const p = prompt.select('pick', [{ label: 'a', value: 'A' }]);
    feed(stdin, ['q']);
    return p;
  });
  assert.strictEqual(val, null);
});

test('confirm: empty answer uses the default', async () => {
  const val = await withFakeTTY(async (prompt, stdin) => {
    const p = prompt.confirm('ok?', { default: true });
    // confirm uses readline.question on the stream; simulate the line.
    setImmediate(() => stdin.emit('keypress', '\r', { name: 'return' }));
    // readline reads 'data'/'line' — feed an empty line directly:
    setImmediate(() => stdin.emit('data', '\n'));
    return p;
  });
  assert.strictEqual(val, true);
});

test('isInteractive: false when OPENCUES_NO_INTERACTIVE is set', async () => {
  await withFakeTTY(async (prompt) => {
    process.env.OPENCUES_NO_INTERACTIVE = '1';
    // re-require to re-read env
    delete require.cache[require.resolve('./prompt.cjs')];
    const p2 = require('./prompt.cjs');
    assert.strictEqual(p2.isInteractive(), false);
    delete process.env.OPENCUES_NO_INTERACTIVE;
  });
});
