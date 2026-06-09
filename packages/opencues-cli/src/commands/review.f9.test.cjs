// Tests for F9 explicit-sandbox requirement on blankScript: blanks (INFOSEC F9).
//
// Pre-F9 a blankScript: blank without `sandbox:` silently ran unconfined.
// Post-F9 it's an install-time hard error AND a runtime refusal.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { _internal } = require('./review.cjs');
const { staticChecks } = _internal;

function fm(overrides = {}) {
  return {
    name: 'demo',
    blankKeywords: ['demo'],
    userBlankCapabilities: {},
    userBlankNetwork: [],
    userBlankSecrets: [],
    userBlankSecretBindings: {},
    blankScript: './x.sh',
    ...overrides,
  };
}

test('F9: blankScript without sandbox is a HARD ERROR', () => {
  const findings = staticChecks(fm({ sandbox: undefined }), '');
  const errors = findings.filter(f => f.sev === 'error' && /F9/.test(f.msg));
  assert.strictEqual(errors.length, 1, `expected 1 F9 error, got: ${JSON.stringify(errors)}`);
  assert.match(errors[0].msg, /must.*sandbox|sandbox.*strict|sandbox.*off/i);
});

test('F9: blankScript with sandbox: strict is clean (no F9 finding)', () => {
  const findings = staticChecks(fm({ sandbox: 'strict' }), '');
  const f9 = findings.filter(f => /F9/.test(f.msg));
  assert.strictEqual(f9.length, 0);
});

test('F9: blankScript with sandbox: off produces a WARN (not error)', () => {
  const findings = staticChecks(fm({ sandbox: 'off' }), '');
  const offWarn = findings.filter(f => /sandbox: off/.test(f.msg));
  assert.strictEqual(offWarn.length, 1);
  assert.strictEqual(offWarn[0].sev, 'warn');
});

test('F9: blankScript with bogus sandbox value is a HARD ERROR', () => {
  const findings = staticChecks(fm({ sandbox: 'kinda-strict' }), '');
  const errors = findings.filter(f => f.sev === 'error' && /F9/.test(f.msg));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].msg, /only.*strict.*off|strict.*or.*off/i);
});

test('F9: non-scripted blank (no blankScript) is unaffected', () => {
  const findings = staticChecks(fm({ blankScript: undefined, sandbox: undefined }), '');
  const f9 = findings.filter(f => /F9/.test(f.msg));
  assert.strictEqual(f9.length, 0);
});
