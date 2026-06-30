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
// no pointer arrow (rows carry their own coloured ring marker), bold focus,
// dimmed-and-skipped disabled rows, separators, and `dim:true` rows that stay
// gray until focused.
//
// HARD RULES (so interactivity never breaks scripting):
//   1. TTY-aware — `isInteractive()` is false in CI / pipes / `--no-interactive`
//      / OPENCUES_NO_INTERACTIVE; the prompts here throw in a non-TTY.
//   2. Flags still win — go interactive only when positional args were omitted.

'use strict';

const { Select, Confirm, Input, Password } = require('enquirer');
const { dim, bold, brightWhite } = require('./style.cjs');

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

// Drop enquirer's `?` message prefix. A falsy `prefix:` option is ignored
// (enquirer falls back to the question symbol), so the method must be
// overridden to return ''.
const stripPrefix = (Base) => class extends Base {
  async prefix() { return ''; }
};

// Our menus don't use a pointer arrow — the row's own marker (a coloured
// ring built by the caller) carries the state, and focus is shown by the row
// text going bold/bright. So:
//   - pointer()  → '' (no ❯ column)
//   - separator() → '' (no trailing … chrome after the message)
//   - focus emphasis is owned entirely by choiceMessage (bold for normal
//     rows; gray→bright-white for `dim:true` rows). enquirer's own `em` style
//     is neutralised to identity so it can't re-add its default cyan UNDERLINE
//     on the focused row.
//   - choices flagged `dim:true` (e.g. a "Done" row) render dimmed until
//     focused, then bright-white — the "gray until selected" behaviour.
class OcSelect extends stripPrefix(Select) {
  constructor(options) {
    super(options);
    this._dimIds = (options && options._dimIds) || new Set();
    this.styles.em = (s) => s; // identity — kill enquirer's underline-on-focus
  }
  pointer() { return ''; }
  separator() { return ''; }
  choiceMessage(choice, i) {
    const msg = this.resolve(choice.message, this.state, choice, i);
    const focused = this.index === i;
    if (this._dimIds.has(choice.name)) {
      return focused ? brightWhite(msg) : dim(msg);
    }
    return focused ? bold(msg) : msg;
  }
}
const OcConfirm = stripPrefix(Confirm);
const OcInput = stripPrefix(Input);
const OcPassword = stripPrefix(Password);

/**
 * Single-select menu. `choices`: `{ label, value, disabled?, separator? }`.
 * `label` is the fully-formatted row (the command owns column layout). Returns
 * the chosen `value`, or `opts.cancelValue ?? null` on Esc/Ctrl-C. Disabled
 * rows are dimmed + skipped; `separator: true` renders a non-selectable divider.
 */
async function select(message, choices, opts = {}) {
  assertTTY('select');
  const valueById = new Map();
  const dimIds = new Set();
  const echoices = choices.map((c, i) => {
    const id = `c${i}`;
    valueById.set(id, c.value);
    if (c.dim) dimIds.add(id);
    return c.separator
      ? { role: 'separator', message: c.label || dim('────') }
      // hint:'' on disabled rows suppresses enquirer's auto-injected
      // "(disabled)" tag (array.js: hint == null → '(disabled)').
      : { name: id, message: c.disabled ? dim(c.label) : c.label, disabled: Boolean(c.disabled), hint: c.disabled ? '' : undefined };
  });
  const prompt = new OcSelect({ name: 'value', message, prefix: '', choices: echoices, _dimIds: dimIds });
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
    return Boolean(await new OcConfirm({ name: 'v', message, initial: def }).run());
  } catch {
    return def;
  }
}

/** Free-text input. Empty / cancel → `opts.default` (or ''). */
async function input(message, opts = {}) {
  assertTTY('input');
  try {
    const v = await new OcInput({ name: 'v', message, initial: opts.default }).run();
    return v && String(v).trim() ? String(v).trim() : (opts.default || '');
  } catch {
    return opts.default || '';
  }
}

/** Masked input (for API keys etc.). Cancel → ''. */
async function secret(message) {
  assertTTY('secret');
  try {
    return String((await new OcPassword({ name: 'v', message }).run()) || '');
  } catch {
    return '';
  }
}

module.exports = { isInteractive, select, confirm, input, secret };
