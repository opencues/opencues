// Tests for `opencues help [<command>]` — the top-level status dashboard
// + command index, and its `--command` forwarding shortcut.
//
// HERMETICITY:
//  - `configRows()` inside help.cjs calls `os.homedir()` fresh on every
//    invocation (not cached at module scope), so a per-test HOME/
//    USERPROFILE swap via beforeEach/afterEach is sufficient — same
//    shape as debug.test.cjs and edit.test.cjs.
//  - Every provider env var help.cjs reads (`GROQ_API_KEY`, etc., per
//    @opencues/core's provider registry, plus the hardcoded
//    `FINNHUB_API_KEY`) is cleared/restored around each test so the
//    real developer machine's configured keys can never leak into an
//    assertion about "no keys configured".
//  - `ctx.REPO_ROOT` legitimately points at the real monorepo root (help
//    loads the real, already-built `@opencues/core` provider registry
//    read-only, exactly like production) — nothing is written there.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const help = require('./help.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PKG_DIR = path.resolve(__dirname, '..', '..');

const PROVIDER_ENV_KEYS = [
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY', 'CEREBRAS_API_KEY', 'OPENCODE_ZEN_API_KEY',
  'OLLAMA_API_KEY', 'FINNHUB_API_KEY',
];

let realHome, realUserProfile, tmpHome;
let savedProviderEnv = {};

beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-help-test-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  savedProviderEnv = {};
  for (const k of PROVIDER_ENV_KEYS) {
    savedProviderEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  for (const k of PROVIDER_ENV_KEYS) {
    if (savedProviderEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedProviderEnv[k];
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function ctx() { return { pkg: { version: 'test' }, PKG_DIR, REPO_ROOT }; }

function cuesDir() { return path.join(tmpHome, '.cues'); }

function writeOpenCues(content) {
  fs.mkdirSync(cuesDir(), { recursive: true });
  fs.writeFileSync(path.join(cuesDir(), 'OPENCUES.md'), content);
}

function writeCue(name) {
  const dir = path.join(cuesDir(), 'cues', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CUE.md'), '---\ntype: alternatives\n---\n');
}

function writeBlank(name) {
  const dir = path.join(cuesDir(), 'blanks', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BLANK.md'), '---\ntype: blank\nname: ' + name + '\n---\n');
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

// ─── Happy path ─────────────────────────────────────────────────────────────

test('happy: no-arg help prints banner, status dashboard, and every command section', () => {
  const { logs } = capture(() => help([], ctx()));
  assert.match(logs, /OpenCues/);
  assert.match(logs, /no config — run `opencues seed-configs`/);
  assert.match(logs, /Usage: opencues <command> \[options\]/);
  assert.match(logs, /Setup/);
  assert.match(logs, /Authoring/);
  assert.match(logs, /Run \/ inspect/);
  assert.match(logs, /Per-host details/);
  assert.match(logs, /Configs/);
  assert.match(logs, /Examples/);
});

test('happy: cue/blank counts reflect what is actually on disk under ~/.cues/', () => {
  writeCue('formal');
  writeCue('casual');
  writeBlank('volume');
  const { logs } = capture(() => help([], ctx()));
  assert.match(logs, /\(2 cues, 1 blanks, 0 auditors\)/);
});

test('happy: `help debug` forwards to debug.cjs\'s own --help output', () => {
  const { logs } = capture(() => help(['debug'], ctx()));
  assert.match(logs, /opencues debug \[on\|off\] \[--project\]/);
  // Forwarding returns early — the top-level dashboard must not also print.
  assert.doesNotMatch(logs, /Usage: opencues <command>/);
});

test('happy: `help cleanup` forwards to cleanup.cjs\'s own --help output', () => {
  const { logs } = capture(() => help(['cleanup'], ctx()));
  assert.match(logs, /opencues cleanup — find and kill orphan host processes/);
});

test('happy: printStatus renders the same dashboard block without the Usage/section index', () => {
  const { logs } = capture(() => help.printStatus(ctx()));
  assert.match(logs, /Paths:/);
  assert.doesNotMatch(logs, /Usage: opencues <command>/);
  assert.doesNotMatch(logs, /Setup/);
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test('edge: unknown subcommand logs an error but still falls through to the full dashboard', () => {
  const { logs, errs } = capture(() => help(['not-a-real-command'], ctx()));
  assert.match(errs, /unknown command "not-a-real-command"/);
  assert.match(logs, /Usage: opencues <command> \[options\]/);
});

test('edge: no configured provider key falls back to the cerebras default + shows the auto-route hint', () => {
  const { logs } = capture(() => help([], ctx()));
  assert.match(logs, /Cerebras/);
  assert.match(logs, /no keys set — set any of/);
});

test('edge: an explicit llm-provider in OPENCUES.md silences the auto-route hint', () => {
  writeOpenCues('---\nllm-provider: anthropic\n---\n');
  const { logs } = capture(() => help([], ctx()));
  assert.doesNotMatch(logs, /auto-routed/);
  assert.doesNotMatch(logs, /no keys set/);
});

test('edge: a configured provider key surfaces the auto-routed hint naming the chain', () => {
  process.env.CEREBRAS_API_KEY = 'csk_test_1234';
  const { logs } = capture(() => help([], ctx()));
  assert.match(logs, /auto-routed \(cerebras > groq/);
});

test('edge: a per-bucket provider override wins over the global llm-provider for that bucket only', () => {
  writeOpenCues('---\nllm-provider: anthropic\ncues-llm-provider: openai\n---\n');
  const { logs } = capture(() => help([], ctx()));
  assert.match(logs, /cues:\s*OpenAI/);
  assert.match(logs, /auditors:\s*Claude/);
  assert.match(logs, /blanks:\s*Claude/);
});

test('edge: no ~/.cues/ at all (not even the directory) does not crash', () => {
  // beforeEach already gives a fresh tmpHome with nothing under it.
  assert.strictEqual(fs.existsSync(cuesDir()), false);
  const { logs } = capture(() => help([], ctx()));
  assert.match(logs, /no config — run `opencues seed-configs`/);
});

// ─── Invalid input ──────────────────────────────────────────────────────────

test('invalid: help forwarding a command name that collides with a non-command file still degrades to the dashboard', () => {
  const { logs, errs } = capture(() => help(['package'], ctx())); // no src/commands/package.cjs
  assert.match(errs, /unknown command "package"/);
  assert.match(logs, /Usage: opencues <command> \[options\]/);
});

test('invalid: malformed OPENCUES.md (no frontmatter fence) does not crash and falls back to defaults', () => {
  writeOpenCues('not frontmatter at all\n');
  const { logs } = capture(() => help([], ctx()));
  assert.match(logs, /Cerebras/); // falls back to the default provider
});
