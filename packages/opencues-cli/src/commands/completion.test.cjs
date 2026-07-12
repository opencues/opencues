// Tests for `opencues completion <bash|zsh|fish>` — shell completion
// script generator.
//
// HERMETICITY: pure string generation — no filesystem, no $HOME, no
// network. Nothing to sandbox here (verified: no `homedir`/`HOME`/
// `USERPROFILE`/`tmpdir` usage in this file or in completion.cjs).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const completion = require('./completion.cjs');

function capture(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  const realExit = process.exit;
  let exitCode = null;
  process.exit = (c) => { exitCode = c; throw new Error('__EXIT__'); };
  let threw = null;
  try { fn(); }
  catch (e) { if (e.message !== '__EXIT__') threw = e; }
  finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = realExit;
  }
  if (threw) throw threw;
  return { logs: logs.join('\n'), errs: errs.join('\n'), exitCode };
}

// ─── Happy path ─────────────────────────────────────────────────────────────

test('happy: bash completion script names the completion function + commands', () => {
  const { logs, exitCode } = capture(() => completion(['bash']));
  assert.strictEqual(exitCode, null);
  assert.match(logs, /_opencues_completions/);
  assert.match(logs, /complete -F _opencues_completions opencues/);
  assert.match(logs, /\binstall\b/);
  assert.match(logs, /\bvalidate\b/);
});

test('happy: zsh completion script wires compdef', () => {
  const { logs } = capture(() => completion(['zsh']));
  assert.match(logs, /compdef _opencues opencues/);
  assert.match(logs, /_describe -t commands/);
});

test('happy: fish completion script emits complete -f -c lines per command', () => {
  const { logs } = capture(() => completion(['fish']));
  assert.match(logs, /complete -f -c opencues -n "__fish_use_subcommand" -a "install"/);
  assert.match(logs, /complete -f -c opencues -l help -l dry-run -l project/);
});

test('happy: --help prints usage and exits cleanly (no shell arg required)', () => {
  const { logs, exitCode } = capture(() => completion(['--help']));
  assert.strictEqual(exitCode, null);
  assert.match(logs, /opencues completion <bash\|zsh\|fish>/);
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test('edge: -h is equivalent to --help', () => {
  const { logs, exitCode } = capture(() => completion(['-h']));
  assert.strictEqual(exitCode, null);
  assert.match(logs, /opencues completion/);
});

test('edge: --help wins even when a shell name also present', () => {
  const { logs } = capture(() => completion(['bash', '--help']));
  assert.match(logs, /opencues completion <bash\|zsh\|fish>/);
});

test('edge: extra trailing flags after the shell name are ignored', () => {
  const { logs, exitCode } = capture(() => completion(['bash', '--verbose']));
  assert.strictEqual(exitCode, null);
  assert.match(logs, /_opencues_completions/);
});

// ─── Invalid input ──────────────────────────────────────────────────────────

test('invalid: missing <shell> exits 2 with an actionable error', () => {
  const { errs, exitCode } = capture(() => completion([]));
  assert.strictEqual(exitCode, 2);
  assert.match(errs, /missing <shell>/);
});

test('invalid: only flags (no positional shell) is treated as missing', () => {
  const { errs, exitCode } = capture(() => completion(['--verbose']));
  assert.strictEqual(exitCode, 2);
  assert.match(errs, /missing <shell>/);
});

test('invalid: unknown shell name exits 2 with the offending name quoted', () => {
  const { errs, exitCode } = capture(() => completion(['powershell']));
  assert.strictEqual(exitCode, 2);
  assert.match(errs, /unknown shell "powershell"/);
});
