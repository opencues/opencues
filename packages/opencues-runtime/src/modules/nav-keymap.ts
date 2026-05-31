// nav-keymap resolver — resolves the `nav-keymap` OPENCUES.md scalar
// (auto / ctrl-alt / ctrl-shift) into the concrete modifier combo a
// host's navigation + cycling handlers should match against.
//
// `auto` resolution:
//   - chrome (hostName === 'chrome'): always 'ctrl-alt'.
//     ctrl-shift+arrow is the canonical "extend text selection by word"
//     shortcut in every browser textarea / contenteditable. Stealing
//     it would clobber user muscle memory for a primary action — not
//     worth the gain on a single misbehaving terminal.
//   - macOS Terminal.app (TERM_PROGRAM === 'Apple_Terminal'):
//     'ctrl-shift'. Apple's Terminal.app strips Ctrl+Alt+arrow before
//     the running app ever sees it, so ctrl-alt is a dead default
//     there. Ghostty / iTerm2 both forward Ctrl+Alt+arrow cleanly,
//     so they stay on the ctrl-alt default.
//   - Everything else: 'ctrl-alt'.
//
// Explicit `ctrl-alt` / `ctrl-shift` always wins over `auto`. The
// menu still lets users override the auto pick from the cycling UI.

export type NavKeymapScalar = 'auto' | 'ctrl-alt' | 'ctrl-shift';
export type ResolvedNavKeymap = 'ctrl-alt' | 'ctrl-shift';

export function resolveNavKeymap(
  configured: NavKeymapScalar,
  hostName: string,
): ResolvedNavKeymap {
  // Chrome ALWAYS gets ctrl-alt — ctrl-shift+arrow is the canonical
  // "extend selection by word" shortcut in every browser textarea /
  // contenteditable. The chrome adapter band also skips the ctrl-shift
  // subscription entirely (see navigation.ts / cycling.ts); this is the
  // belt-and-braces second check in the resolver itself.
  if (hostName === 'chrome') return 'ctrl-alt';
  if (configured === 'ctrl-alt' || configured === 'ctrl-shift') return configured;
  const termProgram = typeof process !== 'undefined' && process.env
    ? process.env.TERM_PROGRAM
    : undefined;
  return termProgram === 'Apple_Terminal' ? 'ctrl-shift' : 'ctrl-alt';
}
