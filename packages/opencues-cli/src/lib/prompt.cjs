// lib/prompt.cjs — interactive prompt toolkit (the input counterpart to
// lib/style.cjs's output helpers). Thin wrapper over `prompts` (terkelg) — a
// small, widely-used, CJS prompt library that handles the cross-terminal raw-
// input quirks (WSL, tmux, varied emulators) that a hand-rolled readline
// version kept tripping on. We keep this wrapper so:
//   - commands depend on a stable in-house API (select/confirm/input/secret),
//     not on `prompts` directly — swapping the lib later touches only this file;
//   - the TTY-aware contract is enforced here, not per command.
//
// HARD RULES (so interactivity never breaks scripting):
//   1. TTY-aware — `isInteractive()` is false in CI / pipes / when
//      `--no-interactive` or OPENCUES_NO_INTERACTIVE is set. Callers MUST gate
//      on it and fall back to flags. The prompts here throw in a non-TTY.
//   2. Flags still win — a command goes interactive only when the user omitted
//      the positional args, never as the only path.

'use strict';

const prompts = require('prompts');

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

// Ctrl-C / Esc anywhere → resolve the prompt as "cancelled" rather than
// `prompts`' default of killing the process mid-command.
const onCancel = () => true; // true = stop the prompt chain; value stays undefined

/**
 * Arrow-key single-select. `choices` is an array of
 * `{ label, value, hint?, disabled? }`. Returns the chosen `value`, or
 * `opts.cancelValue ?? null` on cancel. Disabled rows are shown but skipped.
 */
async function select(message, choices, opts = {}) {
  assertTTY('select');
  const initial = Math.max(0, choices.findIndex(c => !c.disabled));
  const resp = await prompts({
    type: 'select',
    name: 'value',
    message,
    initial,
    choices: choices.map(c => ({
      title: c.label,
      value: c.value,
      description: c.hint,
      disabled: Boolean(c.disabled),
    })),
  }, { onCancel });
  return Object.prototype.hasOwnProperty.call(resp, 'value') ? resp.value : (opts.cancelValue ?? null);
}

/** y/N confirm. Returns a boolean; cancel → `opts.default` (false). */
async function confirm(message, opts = {}) {
  assertTTY('confirm');
  const def = opts.default ?? false;
  const resp = await prompts({ type: 'confirm', name: 'value', message, initial: def }, { onCancel });
  return resp.value === undefined ? def : Boolean(resp.value);
}

/** Free-text input. Empty / cancel → `opts.default` (or ''). */
async function input(message, opts = {}) {
  assertTTY('input');
  const resp = await prompts({ type: 'text', name: 'value', message, initial: opts.default }, { onCancel });
  return resp.value === undefined || resp.value === '' ? (opts.default || '') : String(resp.value);
}

/** Masked input (for API keys etc.). Cancel → ''. */
async function secret(message) {
  assertTTY('secret');
  const resp = await prompts({ type: 'password', name: 'value', message }, { onCancel });
  return resp.value === undefined ? '' : String(resp.value);
}

module.exports = { isInteractive, select, confirm, input, secret };
