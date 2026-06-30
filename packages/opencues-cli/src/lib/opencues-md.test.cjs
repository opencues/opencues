// Round-trip tests for the OPENCUES.md scalar read/write helpers. Hermetic —
// mkdtemp + write to a temp file, never the real ~/.cues.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readScalars, readScalar, writeScalar } = require('./opencues-md.cjs');

const FM = `---
voice-mode: active
debug-mode: on
tts-rate: 1.5
---

# Body prose with a colon: not a scalar
some-key: should-be-ignored-in-body
`;

test('readScalar reads a frontmatter value, null when absent', () => {
  assert.strictEqual(readScalar(FM, 'voice-mode'), 'active');
  assert.strictEqual(readScalar(FM, 'tts-rate'), '1.5');
  assert.strictEqual(readScalar(FM, 'nope'), null);
});

test('readScalars parses only the frontmatter block (body prose ignored)', () => {
  const m = readScalars(FM);
  assert.strictEqual(m.get('voice-mode'), 'active');
  assert.strictEqual(m.get('debug-mode'), 'on');
  assert.strictEqual(m.has('some-key'), false); // body, not frontmatter
});

test('writeScalar replaces an existing line in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-md-'));
  const p = path.join(dir, 'OPENCUES.md');
  fs.writeFileSync(p, FM);
  assert.strictEqual(writeScalar(p, 'voice-mode', 'inactive'), true);
  assert.strictEqual(readScalar(fs.readFileSync(p, 'utf8'), 'voice-mode'), 'inactive');
  // other lines untouched
  assert.strictEqual(readScalar(fs.readFileSync(p, 'utf8'), 'debug-mode'), 'on');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeScalar inserts a new line before the closing fence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-md-'));
  const p = path.join(dir, 'OPENCUES.md');
  fs.writeFileSync(p, FM);
  assert.strictEqual(writeScalar(p, 'max-thinking', 'off'), true);
  const after = fs.readFileSync(p, 'utf8');
  assert.strictEqual(readScalar(after, 'max-thinking'), 'off');
  // inserted inside frontmatter (before the body)
  assert.ok(after.indexOf('max-thinking') < after.indexOf('# Body prose'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeScalar returns false for a missing file', () => {
  assert.strictEqual(writeScalar('/no/such/path/OPENCUES.md', 'voice-mode', 'active'), false);
});
