// lib/prompt.cjs — interactive prompt toolkit (the input counterpart to
// lib/style.cjs's output helpers). Thin wrapper over `enquirer` — a small,
// widely-used, CJS, *themeable* prompt library (npm/yarn use it). Chosen over a
// hand-rolled readline version (failed cross-terminal raw input on WSL) and
// over `prompts` (no way to drop the `?` prefix or recolor the pointer).
//
// Commands depend on this in-house API (select/confirm/input/secret), not on
// `enquirer` directly, so the lib is swappable in one file and the styling is
// owned here. The caller builds each choice's `label` (so column layout /
// status text lives in the command); this file owns the chrome: no `?` prefix,
// a white selection arrow, dimmed-and-skipped disabled rows, separators.
//
// HARD RULES (so interactivity never breaks scripting):
//   1. TTY-aware — `isInteractive()` is false in CI / pipes / `--no-interactive`
//      / OPENCUES_NO_INTERACTIVE; the prompts here throw in a non-TTY.
//   2. Flags still win — go interactive only when positional args were omitted.

'use strict';

const { Select, Confirm, Input, Password } = require('enquirer');
const { dim, brightWhite } = require('./style.cjs');

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

// White selection arrow (enquirer's default is a cyan ▸); no `?` prefix.
class OcSelect extends Select {
  pointer(choice, i) {
    return this.index === i ? brightWhite('❯') : ' ';
  }
}

/**
 * Single-select menu. `choices`: `{ label, value, disabled?, separator? }`.
 * `label` is the fully-formatted row (the command owns column layout). Returns
 * the chosen `value`, or `opts.cancelValue ?? null` on Esc/Ctrl-C. Disabled
 * rows are dimmed + skipped; `separator: true` renders a non-selectable divider.
 */
async function select(message, choices, opts = {}) {
  assertTTY('select');
  const valueById = new Map();
  const echoices = choices.map((c, i) => {
    const id = `c${i}`;
    valueById.set(id, c.value);
    return c.separator
      ? { role: 'separator', message: c.label || dim('────') }
      : { name: id, message: c.disabled ? dim(c.label) : c.label, disabled: Boolean(c.disabled) };
  });
  const prompt = new OcSelect({ name: 'value', message, prefix: '', choices: echoices });
  try {
    const name = await prompt.run();
    return valueById.has(name) ? valueById.get(name) : (opts.cancelValue ?? null);
  } catch {
    return opts.cancelValue ?? null; // Esc / Ctrl-C
  }
}

/** y/N confirm. Cancel → `opts.default` (false). */
async function confirm(message, opts = {}) {
  assertTTY('confirm');
  const def = opts.default ?? false;
  try {
    return Boolean(await new Confirm({ name: 'v', message, initial: def, prefix: '' }).run());
  } catch {
    return def;
  }
}

/** Free-text input. Empty / cancel → `opts.default` (or ''). */
async function input(message, opts = {}) {
  assertTTY('input');
  try {
    const v = await new Input({ name: 'v', message, initial: opts.default, prefix: '' }).run();
    return v && String(v).trim() ? String(v).trim() : (opts.default || '');
  } catch {
    return opts.default || '';
  }
}

/** Masked input (for API keys etc.). Cancel → ''. */
async function secret(message) {
  assertTTY('secret');
  try {
    return String((await new Password({ name: 'v', message, prefix: '' }).run()) || '');
  } catch {
    return '';
  }
}

module.exports = { isInteractive, select, confirm, input, secret };
