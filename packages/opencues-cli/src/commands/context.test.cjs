// Tests for `opencues context [list]` — unified LLM-prompt-context
// inspector (identity-context / blank-context / ambient-context).
//
// HERMETICITY: context.cjs resolves `~/.cues/...` paths off a MODULE-SCOPE
// `const HOME = os.homedir();` (evaluated ONCE, at require() time — not
// read fresh per call). That means overriding `process.env.HOME` in a
// per-test `beforeEach` (the pattern used elsewhere in this package) is
// silently ineffective here: the module has already frozen the real
// homedir by the time the test runs. This was caught empirically — an
// early draft of this file used `beforeEach`-scoped HOME swaps and the
// tests came back listing the machine's REAL `~/.cues/blanks/` (stocks,
// weather, crypto, ...) instead of the fixtures written to the sandbox.
//
// Fix: set BOTH `HOME` and `USERPROFILE` (on this Windows dev box,
// `os.homedir()` reads `%USERPROFILE%`, not `$HOME` — overriding only one
// leaves the module reading the real profile) to a single sandbox dir
// BEFORE requiring context.cjs, so the module-scope `HOME` constant is
// captured pointing at the sandbox for the lifetime of the process. Each
// test then only needs to reset the sandbox's *contents* (not the env
// var) between runs.

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-context-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

// Required AFTER the sandbox HOME is in place, so its module-scope
// `const HOME = os.homedir();` captures the sandbox, not the real home.
const context = require('./context.cjs');

after(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// Start every test from an empty sandboxed ~/.cues/ (contents only —
// the env var itself stays pointed at tmpHome for the whole suite).
beforeEach(() => {
  try { fs.rmSync(path.join(tmpHome, '.cues'), { recursive: true, force: true }); } catch {}
});

function cuesDir() { return path.join(tmpHome, '.cues'); }

function writeOpenCues(content) {
  fs.mkdirSync(cuesDir(), { recursive: true });
  fs.writeFileSync(path.join(cuesDir(), 'OPENCUES.md'), content);
}

function writeIdentity(content) {
  fs.mkdirSync(cuesDir(), { recursive: true });
  fs.writeFileSync(path.join(cuesDir(), 'IDENTITY.md'), content);
}

function writeBlank(name, content) {
  const dir = path.join(cuesDir(), 'blanks', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BLANK.md'), content);
}

function capture(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  let ret;
  try { ret = fn(); }
  finally { console.log = origLog; console.error = origErr; }
  return { ret, logs: logs.join('\n'), errs: errs.join('\n') };
}

function captureJson(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  let ret;
  try { ret = fn(); }
  finally { process.stdout.write = origWrite; }
  return { ret, json: JSON.parse(chunks.join('')) };
}

// ─── Happy path ─────────────────────────────────────────────────────────────

test('happy: no subcommand prints usage', () => {
  const { ret, logs } = capture(() => context([], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /opencues context/);
  assert.match(logs, /opencues context list/);
});

test('happy: `list` on a completely empty ~/.cues/ reports every source off, zero tokens', () => {
  const { ret, logs } = capture(() => context(['list'], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /identity-context/);
  assert.match(logs, /blank-context/);
  assert.match(logs, /ambient-context/);
  assert.match(logs, /0 tokens available/);
  assert.match(logs, /0\/3 modes active/);
});

test('happy: `list --json` on empty config returns the documented shape', () => {
  const { ret, json } = captureJson(() => context(['list', '--json'], {}));
  assert.strictEqual(ret, 0);
  assert.deepStrictEqual(json.modes, {
    identityContextMode: 'off', blankContextMode: 'off', ambientContextMode: 'off',
  });
  assert.strictEqual(json.identityFile.present, false);
  assert.deepStrictEqual(json.identityFields, []);
  assert.deepStrictEqual(json.blanks, []);
});

test('happy: `list --json` reflects OPENCUES.md modes + an IDENTITY.md field', () => {
  writeOpenCues('---\nidentity-context-mode: safe\nambient-context-mode: on\n---\n');
  writeIdentity('---\nfirst-name: Alice\n---\n');
  const { json } = captureJson(() => context(['list', '--json'], {}));
  assert.strictEqual(json.modes.identityContextMode, 'safe');
  assert.strictEqual(json.modes.ambientContextMode, 'on');
  assert.strictEqual(json.modes.blankContextMode, 'off');
  assert.strictEqual(json.identityFile.present, true);
  assert.strictEqual(json.identityFields.length, 1);
  assert.match(json.identityFields[0].token, /FIRST.NAME/i);
});

test('happy: a blank with an explicit name: matching its folder is discovered as-context', () => {
  writeOpenCues('---\nblank-context-mode: safe\n---\n');
  writeBlank('teststock', '---\ntype: blank\nname: teststock\nas-context: safe\n---\n');
  const { json } = captureJson(() => context(['list', '--json'], {}));
  assert.strictEqual(json.blanks.length, 1);
  assert.strictEqual(json.blanks[0].name, 'teststock');
  assert.strictEqual(json.blanks[0].mode, 'safe');
});

test('happy: `ls` is an alias for `list`', () => {
  const { ret, logs } = capture(() => context(['ls'], {}));
  assert.strictEqual(ret, 0);
  assert.match(logs, /identity-context/);
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test('edge: identity-context-mode raw prints inline values in human-readable output', () => {
  writeOpenCues('---\nidentity-context-mode: raw\n---\n');
  writeIdentity('---\nfirst-name: Alice\n---\n');
  const { logs } = capture(() => context(['list'], {}));
  assert.match(logs, /= "Alice"/);
});

test('edge: malformed OPENCUES.md (no frontmatter fence) degrades to all-off, no crash', () => {
  writeOpenCues('not even close to frontmatter\njust prose\n');
  const { ret, json } = captureJson(() => context(['list', '--json'], {}));
  assert.strictEqual(ret, 0);
  assert.deepStrictEqual(json.modes, {
    identityContextMode: 'off', blankContextMode: 'off', ambientContextMode: 'off',
  });
});

test('edge: an unknown mode value in OPENCUES.md falls back to off rather than crashing', () => {
  writeOpenCues('---\nidentity-context-mode: yolo\n---\n');
  const { json } = captureJson(() => context(['list', '--json'], {}));
  assert.strictEqual(json.modes.identityContextMode, 'off');
});

test('edge: a blank without as-context is not surfaced in blank-context', () => {
  writeBlank('plain', '---\ntype: blank\nname: plain\n---\n');
  const { json } = captureJson(() => context(['list', '--json'], {}));
  assert.deepStrictEqual(json.blanks, []);
});

// ─── Invalid input ──────────────────────────────────────────────────────────

test('invalid: unknown subcommand errors + prints usage, exit code 2', () => {
  const { ret, errs, logs } = capture(() => context(['bogus'], {}));
  assert.strictEqual(ret, 2);
  assert.match(errs, /unknown subcommand 'bogus'/);
  assert.match(logs, /opencues context/);
});

// ─── Known bug ──────────────────────────────────────────────────────────────
//
// discoverBlanks() calls:
//   core.cuesMd.parseSingleCueMd(content, e.name, path.join(BLANKS_DIR, e.name))
// but the real signature (packages/opencues-core/src/cues-md.ts) is
// `parseSingleCueMd(content, folderPath, nameOverride)`. The two
// positional args are swapped: `e.name` (bare folder name, e.g.
// "teststock") lands in the `folderPath` slot, and the FULL absolute
// path lands in `nameOverride`. When a BLANK.md omits an explicit
// `name:` field, the parser falls back to `frontmatter.name ||
// nameOverride`, so `blank.name` becomes the full absolute path instead
// of the folder name, and `result.blanks` gets keyed by that full path.
// context.cjs then looks the config up via `parsed.blanks[e.name]`
// (bare folder name) — a guaranteed miss — so the blank is silently
// dropped from `opencues context list`, even though it opted in via
// `as-context: safe`. Every shipped defaults/blanks/*/BLANK.md happens
// to declare an explicit `name:` matching its folder, which is why this
// has gone unnoticed — it only bites BLANK.md authors who rely on the
// documented "name defaults to folder" behaviour.
//
// Proposed fix: swap the two arguments at the call site in
// discoverBlanks() to `parseSingleCueMd(content, path.join(BLANKS_DIR,
// e.name), e.name)`.
test('BUG: a blank with no explicit name: is silently dropped from context list', { todo: true }, () => {
  writeOpenCues('---\nblank-context-mode: safe\n---\n');
  writeBlank('teststock', '---\ntype: blank\nas-context: safe\n---\n'); // no `name:` field
  const { json } = captureJson(() => context(['list', '--json'], {}));
  assert.strictEqual(json.blanks.length, 1); // currently fails: json.blanks is []
  assert.strictEqual(json.blanks[0].name, 'teststock');
});
