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

const { dim, green, brightWhite, G } = require('./style.cjs');
const { Select, Input, Password } = require('enquirer');

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
// Each row is composed in choiceMessage from three independent parts so the
// two states never fight each other in ANSI:
//   1. gutter  — the SELECTION cursor: white `❯` on the focused row, two
//      spaces otherwise. (enquirer's native pointer is left empty so we own
//      the gutter width + colour.)
//   2. ring    — the ON/OFF status: green `●` (on) / gray `●` (off), drawn by
//      the lib from a choice's `ring` boolean. ALWAYS keeps its colour, even
//      when the row is selected.
//   3. text    — the row label. Plain when idle; turns bright-white when the
//      row is selected (`dim:true` rows are gray when idle instead of plain).
// enquirer's own `em` style is neutralised to identity so it can't re-add its
// default cyan underline on the focused row.
const POINTER = brightWhite(G.pointer) + ' ';
const NOPOINT = '  ';
class OcSelect extends stripPrefix(Select) {
  constructor(options) {
    super(options);
    this._dimIds = (options && options._dimIds) || new Set();
    this._ringById = (options && options._ringById) || new Map();
    this.styles.em = (s) => s; // identity — kill enquirer's underline-on-focus
  }
  pointer() { return ''; }
  separator() { return ''; }
  // Indices of the actually-selectable rows (skip headings / separators /
  // disabled spacers).
  _selectable() {
    const out = [];
    for (let i = 0; i < this.choices.length; i += 1) {
      const c = this.choices[i];
      if (c && !c.disabled && c.role !== 'heading' && c.role !== 'separator') out.push(i);
    }
    return out;
  }
  // Clamp at the true ends instead of wrapping — Down on the last selectable
  // row stops, it doesn't cycle to the top. (We don't use enquirer's scrolling
  // viewport — it scrolls by rotating the choices array, which both wraps and
  // breaks index math; menus are kept short enough to fit instead.)
  down() {
    const sel = this._selectable();
    if (sel.length && this.index >= sel[sel.length - 1]) return this.alert();
    return super.down();
  }
  up() {
    const sel = this._selectable();
    if (sel.length && this.index <= sel[0]) return this.alert();
    return super.up();
  }
  choiceMessage(choice, i) {
    const msg = this.resolve(choice.message, this.state, choice, i);
    // Section headings render as-is (caller styles them) — no gutter, no
    // focus styling, non-selectable.
    if (choice.role === 'heading') return msg;
    const focused = this.index === i;
    const gutter = focused ? POINTER : NOPOINT;
    const ring = this._ringById.has(choice.name)
      ? (this._ringById.get(choice.name) ? green(G.ringOn) : dim(G.ringOn)) + ' '
      : '';
    // Selected row's text always turns white; the ring keeps its on/off colour.
    const text = focused
      ? brightWhite(msg)
      : (this._dimIds.has(choice.name) ? dim(msg) : msg);
    return gutter + ring + text;
  }
  // Don't echo the picked answer on submit — enquirer's default prints
  // `this.selected.name`, which is our synthetic id (e.g. "c0").
  format() { return ''; }

  // Wrap each frame in a synchronized-output block (DEC private mode 2026) so
  // the terminal paints the erase + redraw atomically — otherwise the brief
  // erased state between enquirer's clear() and write() shows as a flash on
  // arrow-key navigation (esp. over WSL / remote terminals). Terminals that
  // don't understand 2026 ignore the (zero-width) sequences.
  async render() {
    const out = this.stdout || process.stdout;
    const sync = out && out.isTTY;
    if (sync) out.write('\x1b[?2026h');
    try {
      return await super.render();
    } finally {
      if (sync) out.write('\x1b[?2026l');
    }
  }
}

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
  const ringById = new Map();
  const echoices = choices.map((c, i) => {
    const id = `c${i}`;
    valueById.set(id, c.value);
    if (c.dim) dimIds.add(id);
    // `ring: true|false` → the lib draws a green/gray status ● before the label.
    if (typeof c.ring === 'boolean') ringById.set(id, c.ring);
    // A `spacer` is a non-selectable blank line (a disabled empty row —
    // enquirer's own `role:'separator'` forces a ───── rule we don't want).
    // message is a single space, not '' — enquirer falls back to the choice
    // *name* when message is empty, which would print "c3".
    if (c.spacer) return { name: id, message: ' ', disabled: true, hint: '' };
    // A `heading` is a non-selectable bold section title (caller styles it).
    if (c.heading != null) return { role: 'heading', message: c.heading };
    return c.separator
      ? { role: 'separator', message: c.label || dim('────') }
      // hint:'' on disabled rows suppresses enquirer's auto-injected
      // "(disabled)" tag (array.js: hint == null → '(disabled)').
      : { name: id, message: c.disabled ? dim(c.label) : c.label, disabled: Boolean(c.disabled), hint: c.disabled ? '' : undefined };
  });
  // An empty message suppresses enquirer's prompt line entirely (it would
  // otherwise render with a stray leading space from its `[prefix, message,
  // …].join(' ')`). Callers that want a header print it themselves at col 0.
  const prompt = new OcSelect({
    name: 'value', message: message || '', prefix: '', choices: echoices,
    _dimIds: dimIds, _ringById: ringById,
    promptLine: message ? undefined : false,
    // initial focus index (e.g. confirm() lands on the safe default)
    initial: typeof opts.initial === 'number' ? opts.initial : undefined,
  });
  try {
    const name = await prompt.run();
    return valueById.has(name) ? valueById.get(name) : (opts.cancelValue ?? null);
  } catch {
    return opts.cancelValue ?? null; // Esc / Ctrl-C
  }
}

/**
 * Yes / No confirm — rendered as a two-row arrow-select so the UX matches
 * select() (white ❯, bold focus) rather than a typed y/N line. Initial focus
 * lands on the default (No, unless `opts.default` is true). The caller's
 * `message` prints as a header line above the two rows. Cancel → the default.
 */
async function confirm(message, opts = {}) {
  assertTTY('confirm');
  const def = opts.default ?? false;
  if (message) process.stdout.write(message + '\n');
  const picked = await select('', [
    { label: 'Yes', value: true },
    { label: 'No', value: false },
  ], { initial: def ? 0 : 1, cancelValue: def });
  return picked == null ? def : picked;
}

/**
 * Free-text input. `opts.default` pre-fills the field. On empty submit:
 * returns `opts.default` normally, or '' when `opts.allowEmpty` is set (so a
 * caller can distinguish "accepted the pre-fill" from "cleared it to skip").
 */
async function input(message, opts = {}) {
  assertTTY('input');
  const onEmpty = () => (opts.allowEmpty ? '' : (opts.default || ''));
  try {
    const v = await new OcInput({ name: 'v', message, initial: opts.default }).run();
    return v && String(v).trim() ? String(v).trim() : onEmpty();
  } catch {
    return onEmpty();
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
