// lib/prompt.cjs — zero-dependency interactive prompt toolkit (the input
// counterpart to lib/style.cjs's output helpers). Raw `node:readline` only,
// no third-party prompt library — matches the CLI's no-deps posture.
//
// HARD RULES (so interactivity never breaks scripting):
//   1. TTY-aware — `isInteractive()` is false in CI / pipes / when
//      `--no-interactive` or OPENCUES_NO_INTERACTIVE is set. Callers MUST
//      gate on it and fall back to flags. Calling a prompt in a non-TTY
//      throws (it would hang waiting on stdin otherwise).
//   2. Flags still win — a command should go interactive only when the user
//      omitted the positional args, never as the only path.
//
// Primitives: select (arrow-key single pick), confirm (y/N), input (text),
// secret (masked). multiselect/toggle can be added on top of these later.

'use strict';

const readline = require('node:readline');
const { cyan, dim, bold } = require('./style.cjs');

/** Is a human present on a real terminal (and not opted out)? */
function isInteractive() {
  return Boolean(
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !process.env.OPENCUES_NO_INTERACTIVE &&
    !process.argv.includes('--no-interactive'),
  );
}

function assertTTY(what) {
  if (!isInteractive()) {
    throw new Error(`prompt.${what}() requires an interactive terminal — pass explicit flags in a non-TTY context.`);
  }
}

/**
 * Arrow-key single-select. `choices` is an array of
 * `{ label, value, hint?, disabled? }`. Up/Down (or k/j) move, Enter selects,
 * q/Esc/Ctrl-C cancel (→ resolves null). Disabled rows are shown but skipped.
 */
function select(message, choices, opts = {}) {
  assertTTY('select');
  const out = process.stdout;
  const stdin = process.stdin;

  return new Promise((resolve) => {
    let idx = choices.findIndex(c => !c.disabled);
    if (idx < 0) idx = 0;

    const renderRows = (firstPaint) => {
      if (!firstPaint) readline.moveCursor(out, 0, -choices.length);
      for (let i = 0; i < choices.length; i += 1) {
        readline.clearLine(out, 0);
        const c = choices[i];
        const pointer = i === idx && !c.disabled ? cyan('❯') : ' ';
        const label = c.disabled ? dim(c.label) : (i === idx ? cyan(c.label) : c.label);
        const hint = c.hint ? '  ' + dim(c.hint) : '';
        out.write(`${pointer} ${label}${hint}\n`);
      }
    };

    out.write(bold(message) + '\n');
    renderRows(true);

    readline.emitKeypressEvents(stdin);
    const wasRaw = Boolean(stdin.isRaw);
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener('keypress', onKey);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const move = (dir) => {
      let n = idx;
      for (let guard = 0; guard < choices.length; guard += 1) {
        n = (n + dir + choices.length) % choices.length;
        if (!choices[n].disabled) { idx = n; break; }
      }
      renderRows(false);
    };

    function onKey(_str, key) {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') move(-1);
      else if (key.name === 'down' || key.name === 'j') move(1);
      else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(choices[idx] ? choices[idx].value : null);
      } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        out.write(dim('  (cancelled)\n'));
        resolve(opts.cancelValue ?? null);
      }
    }
    stdin.on('keypress', onKey);
  });
}

/** y/N confirm. Returns a boolean; empty answer → `opts.default` (false). */
function confirm(message, opts = {}) {
  assertTTY('confirm');
  const def = opts.default ?? false;
  const hint = def ? '[Y/n]' : '[y/N]';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message} ${dim(hint)} `, (ans) => {
      rl.close();
      const a = ans.trim().toLowerCase();
      if (a === '') return resolve(def);
      resolve(a === 'y' || a === 'yes');
    });
  });
}

/** Free-text input. Empty answer → `opts.default` (or ''). */
function input(message, opts = {}) {
  assertTTY('input');
  const suffix = opts.default ? dim(` (${opts.default})`) : '';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message}${suffix} `, (ans) => {
      rl.close();
      resolve(ans.trim() || opts.default || '');
    });
  });
}

/** Masked input (for API keys etc.). Echoes `*` per char. */
function secret(message) {
  assertTTY('secret');
  const out = process.stdout;
  const stdin = process.stdin;
  return new Promise((resolve) => {
    out.write(`${message} `);
    readline.emitKeypressEvents(stdin);
    const wasRaw = Boolean(stdin.isRaw);
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const done = (val) => {
      stdin.removeListener('keypress', onKey);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      out.write('\n');
      resolve(val);
    };
    function onKey(str, key) {
      if (!key) return;
      if (key.name === 'return' || key.name === 'enter') return done(buf);
      if (key.ctrl && key.name === 'c') return done('');
      if (key.name === 'backspace') { if (buf) { buf = buf.slice(0, -1); out.write('\b \b'); } return; }
      if (str && str.length === 1 && str >= ' ') { buf += str; out.write('*'); }
    }
    stdin.on('keypress', onKey);
  });
}

module.exports = { isInteractive, select, confirm, input, secret };
