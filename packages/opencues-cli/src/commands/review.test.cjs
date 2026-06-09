// Tests for `opencues review` static-pattern denylist hardening (INFOSEC F5).
//
// What we pin:
//   - .constructor / ["constructor"] / Reflect / globalThis / proto-walk
//     are hard blockers (sev: 'error'), not warnings.
//   - The scan covers BOTH stripped and raw source — payloads hidden in
//     string literals can no longer slip past via `stripCommentsAndStrings`.
//   - Pre-fix: a vm-escape PoC using Promise.constructor returned no
//     findings. Post-fix: it returns a sev: 'error'.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { _internal } = require('./review.cjs');
const { staticChecks } = _internal;

function fm() {
  return {
    name: 'pwned',
    blankKeywords: ['pwned'],
    userBlankCapabilities: {},
    userBlankNetwork: [],
    userBlankSecrets: [],
    userBlankSecretBindings: {},
  };
}

function severities(findings, msgPattern) {
  return findings.filter(f => msgPattern.test(f.msg)).map(f => f.sev);
}

test('F5: .constructor access is a hard blocker', () => {
  const src = `
    export async function get() {
      const p = Promise.constructor('return process')();
      return { tip: p.env.GROQ_API_KEY };
    }
  `;
  const findings = staticChecks(fm(), src);
  assert.deepStrictEqual(severities(findings, /\.constructor/), ['error']);
});

test('F5: ["constructor"] bracket form is a hard blocker', () => {
  const src = `
    export async function get() {
      const p = Promise["constructor"]('return process')();
      return { tip: p.env.GROQ_API_KEY };
    }
  `;
  const findings = staticChecks(fm(), src);
  assert.deepStrictEqual(severities(findings, /bracket form/), ['error']);
});

test('F5: Reflect reference is a hard blocker', () => {
  const findings = staticChecks(fm(), 'export async function get() { return Reflect.apply(x, [], []); }');
  assert.deepStrictEqual(severities(findings, /Reflect/), ['error']);
});

test('F5: globalThis reference is a hard blocker', () => {
  const findings = staticChecks(fm(), 'export async function get() { return globalThis.process.env; }');
  assert.deepStrictEqual(severities(findings, /globalThis/), ['error']);
});

test('F5: __proto__ access is a hard blocker', () => {
  const findings = staticChecks(fm(), 'export async function get() { return ({}).__proto__.constructor; }');
  assert.deepStrictEqual(severities(findings, /__proto__/), ['error']);
});

test('F5: Object.getPrototypeOf is a hard blocker', () => {
  const findings = staticChecks(fm(), 'export async function get() { return Object.getPrototypeOf({}); }');
  assert.deepStrictEqual(severities(findings, /PrototypeOf/), ['error']);
});

test('F5: Object.setPrototypeOf is a hard blocker', () => {
  const findings = staticChecks(fm(), 'export async function get() { Object.setPrototypeOf({}, null); }');
  assert.deepStrictEqual(severities(findings, /PrototypeOf/), ['error']);
});

test('F5: payload hidden in string literal is still flagged via raw scan', () => {
  // The pre-F5 review stripped string literals before scanning, so a
  // payload like `Promise['cons'+'tructor']('return process')()` had
  // every telltale token removed before the regexes ran. The raw scan
  // catches the string-concat fragments.
  const src = `
    export async function get() {
      // Comment to ensure stripping still runs
      const tok = 'cons' + 'tructor';
      const p = Promise[tok]('return ' + 'process')();
      return { tip: 'k=' + p.env.GROQ_API_KEY };
    }
  `;
  const findings = staticChecks(fm(), src);
  // Raw scan should catch the concat-fragment pattern.
  const concatHits = findings.filter(f => /string-concatenates/.test(f.msg));
  assert.ok(concatHits.length > 0, 'expected raw-scan to flag concat fragments');
});

test('F5: clean code (no escape patterns) produces no error-level findings', () => {
  const src = `
    export async function get(arg) {
      return { tip: 'hello ' + arg };
    }
  `;
  const findings = staticChecks(fm(), src);
  const errors = findings.filter(f => f.sev === 'error');
  assert.deepStrictEqual(errors, [], `expected no errors, got: ${JSON.stringify(errors)}`);
});

test('F5: stripped scan still catches dynamic import as a hard blocker', () => {
  // Pre-existing rule — confirm we didn't regress it.
  const findings = staticChecks(fm(), 'export async function get() { return import("./x.js"); }');
  assert.deepStrictEqual(severities(findings, /dynamic `import\(\)`/), ['error']);
});

test('F5: stripped scan still catches eval as a warning', () => {
  const findings = staticChecks(fm(), 'export async function get() { return eval("1+1"); }');
  assert.deepStrictEqual(severities(findings, /`eval\(`/), ['warn']);
});
