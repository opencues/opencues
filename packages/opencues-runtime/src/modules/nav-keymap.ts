// nav-keymap resolver — resolves the `nav-keymap` OPENCUES.md scalar
// (auto / ctrl-alt / ctrl-shift) into the concrete modifier combo a
// host's navigation + cycling handlers should match against.
//
// `auto` resolution:
//   - browser hosts (`isBrowserHost` — chrome, dsh): always 'ctrl-alt'.
//     ctrl-shift+arrow is the canonical "extend text selection by word"
//     shortcut in every browser textarea / contenteditable. Stealing
//     it would clobber user muscle memory for a primary action — not
//     worth the gain on a single misbehaving terminal.
//   - Everything else: 'ctrl-alt'.
//
// macOS Terminal.app note (verified June 2026 via `cat -v`):
// Ctrl+Option+arrow with Option-as-Meta enabled DOES survive Terminal.app
// — it arrives as Meta-prefixed CSI (`ESC ESC [A` etc.). Both terminal
// adapters (cc/v2.1 + shell/v1) coalesce option/meta into the runtime's
// `alt` modifier, so `ctrl-alt` is the correct default there too. An
// earlier auto-fallback to `ctrl-shift` on Apple_Terminal was based on a
// wrong assumption (we thought Ctrl+Alt was stripped); the actual story
// is that *Ctrl+Shift+arrow* is the one Terminal.app strips, so the
// fallback was making things worse. Users who'd rather use `ctrl-shift`
// in iTerm2 / Ghostty can still set it explicitly.
//
// Explicit `ctrl-alt` / `ctrl-shift` always wins over `auto`. The
// menu still lets users override the auto pick from the cycling UI.

import { isBrowserHost } from '@opencues/core';

export type NavKeymapScalar = 'auto' | 'ctrl-alt' | 'ctrl-shift';
export type ResolvedNavKeymap = 'ctrl-alt' | 'ctrl-shift';

export function resolveNavKeymap(
  configured: NavKeymapScalar,
  hostName: string,
): ResolvedNavKeymap {
  // Browser hosts ALWAYS get ctrl-alt — ctrl-shift+arrow is the canonical
  // "extend selection by word" shortcut in every browser textarea /
  // contenteditable. The chrome adapter band also skips the ctrl-shift
  // subscription entirely (see navigation.ts / cycling.ts); this is the
  // belt-and-braces second check in the resolver itself.
  //
  // Asked as "is this a browser?" rather than `=== 'chrome'`: the reason is
  // the browser's own keybinding, so every browser host needs it, and the
  // second one (DeepSeek Harness) would otherwise have inherited a
  // ctrl-shift keymap that the page steals from it.
  if (isBrowserHost(hostName)) return 'ctrl-alt';
  if (configured === 'ctrl-alt' || configured === 'ctrl-shift') return configured;
  return 'ctrl-alt';
}
