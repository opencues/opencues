// Mac Terminal.app + Option-as-Meta keyboard quirk.
//
// Mac Terminal.app emits Ctrl+Option+arrow as `\x1b\x1b[A` (double-ESC + CSI)
// with NO Ctrl byte anywhere in the stream. Every other terminal — Ghostty,
// iTerm2, Linux xterm, Windows Terminal — uses xterm-modifier-encoded CSI
// (`\x1b[1;7A`) for Ctrl+Alt+arrow with the Ctrl bit present.
//
// The double-ESC byte prefix is a unique structural signature: it's only
// produced by Mac Terminal.app for this specific chord. Plain Option+L/R on
// Terminal.app emits word-jump bytes (`\x1b b` / `\x1b f`), not arrow CSI;
// plain arrows omit the ESC prefix entirely.
//
// This module owns the decision: given a raw key event from any host's
// keypress parser, should we synthesise `ctrl: true` so the runtime's
// `ctrl-alt` matcher fires? It's host-agnostic because Ink (CC), OpenTUI
// (OC + shell), and any future readline-style parser all preserve the
// raw byte sequence on the event — we gate on that.
//
// Why gate on `evt.sequence` instead of `evt.option`:
//   Both Ink and OpenTUI ALSO set `option: true` for xterm-modifier-encoded
//   CSI with bit 2 (plain Alt+arrow → `\x1b[1;3A`). Gating on the byte
//   signature means the synth can NEVER hijack plain Alt+arrow on Linux /
//   Windows / Ghostty / iTerm2 — word-jump muscle memory is preserved.
//
// Why gate on `!ctrl`:
//   Ghostty / iTerm2 transmit Ctrl+Option+arrow as `\x1b[1;7A`, which Ink /
//   OpenTUI parse with `ctrl: true` directly. The synth is conditional on
//   `!ctrl` so the existing pre-PR code path is structurally unchanged on
//   those terminals.
//
// Why arrow-only:
//   The runtime's cycling + navigation use arrow keys exclusively. Mac
//   Terminal.app could theoretically double-ESC any sequence, but only
//   `\x1b\x1b[A/B/C/D` (arrows) is relevant to the ctrl-alt matcher.
//   Limiting to arrows means Option+letter / Option+symbol still routes
//   through whatever the host's own keymap expects.

const MAC_DOUBLE_ESC_PREFIX = '\x1b\x1b[';
const ARROW_KEYS: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right']);

export interface MacKeyboardRawEvent {
  ctrl?: boolean;
  sequence?: string;
  key?: string;
  name?: string;
}

/**
 * Returns true when the raw key event matches Mac Terminal.app's
 * Ctrl+Option+arrow byte signature (`\x1b\x1b[A` etc.) and ctrl is not
 * already set by the host's parser. Host bootstraps OR the input to a
 * runtime modifier coalesce with the result.
 */
export function shouldSynthesizeMacDoubleEscCtrl(raw: MacKeyboardRawEvent): boolean {
  if (raw.ctrl) return false;
  if (typeof raw.sequence !== 'string') return false;
  if (!raw.sequence.startsWith(MAC_DOUBLE_ESC_PREFIX)) return false;
  const keyName = (raw.key ?? raw.name ?? '').toLowerCase();
  return ARROW_KEYS.has(keyName);
}
