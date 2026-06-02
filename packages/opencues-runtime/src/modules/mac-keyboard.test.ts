import { describe, expect, it } from 'vitest';
import { shouldSynthesizeMacDoubleEscCtrl, buildOpenTuiModifiers } from './mac-keyboard';

// This helper centralises the Ctrl+Option+arrow synth used by CC's
// `normaliseKeyEvent` and the OpenTUI bootstraps (shell + OC). The tests
// below pin every byte-sequence shape we know about across the four
// real-world (terminal, modifier) combinations + non-arrow + missing-field
// edge cases, so a regression in any consumer site fails here once.

describe('shouldSynthesizeMacDoubleEscCtrl', () => {
  describe('Mac Terminal.app — Ctrl+Option+arrow (double-ESC + CSI, no Ctrl byte)', () => {
    it.each([
      ['up',    '\x1b\x1b[A'],
      ['down',  '\x1b\x1b[B'],
      ['right', '\x1b\x1b[C'],
      ['left',  '\x1b\x1b[D'],
    ])('synthesises ctrl=true for %s (%s)', (key, sequence) => {
      expect(shouldSynthesizeMacDoubleEscCtrl({ key, sequence })).toBe(true);
    });

    it('honours `name` field when host parser uses that instead of `key`', () => {
      // OpenTUI's ParsedKey uses `name`; Ink uses `key`. The helper accepts
      // either so the call sites can pass the raw event through unchanged.
      expect(shouldSynthesizeMacDoubleEscCtrl({ name: 'up', sequence: '\x1b\x1b[A' })).toBe(true);
    });

    it('does NOT fire when ctrl is already set (Ghostty/iTerm2 path — modifier-encoded CSI)', () => {
      // Hypothetical: if a terminal sent double-ESC AND also marked ctrl=true
      // upstream, the synth is unnecessary. The !ctrl guard keeps the synth
      // strictly additive — it never reaches into already-correct events.
      expect(shouldSynthesizeMacDoubleEscCtrl({ key: 'up', ctrl: true, sequence: '\x1b\x1b[A' })).toBe(false);
    });
  });

  describe('NOT Mac Terminal.app — every other terminal and chord', () => {
    it('plain Alt+arrow on Linux/Windows (xterm modifier-encoded CSI) is NOT a match', () => {
      // `\x1b[1;3A` is xterm-modifier-encoded plain Alt+Up. OpenTUI parses
      // this with `option: true` too (modifier byte bit 2). Gating on the
      // BYTE prefix instead of the parsed flag is what prevents this from
      // hijacking word-jump muscle memory on non-Mac terminals.
      expect(shouldSynthesizeMacDoubleEscCtrl({ key: 'up', sequence: '\x1b[1;3A' })).toBe(false);
    });

    it('Ghostty / iTerm2 Ctrl+Option+arrow (modifier-encoded with ctrl=true) is NOT a match', () => {
      // `\x1b[1;7A` — modifier byte 7 = ctrl + alt + shift. ctrl is set
      // directly by the parser; the synth is a structural no-op.
      expect(shouldSynthesizeMacDoubleEscCtrl({ key: 'up', ctrl: true, sequence: '\x1b[1;7A' })).toBe(false);
    });

    it('plain Up arrow (no modifier, no ESC) is NOT a match', () => {
      expect(shouldSynthesizeMacDoubleEscCtrl({ key: 'up', sequence: '\x1b[A' })).toBe(false);
    });

    it('Mac Terminal.app double-ESC on a NON-arrow key is NOT a match', () => {
      // Theoretical `\x1b\x1b a` (Option+a with Option-as-Meta on). The
      // arrow gate keeps Option+letter routing through the host's normal
      // keymap instead of being hijacked into ctrl-alt cycling.
      expect(shouldSynthesizeMacDoubleEscCtrl({ key: 'a', sequence: '\x1b\x1ba' })).toBe(false);
    });

    it('single-ESC CSI (`\\x1b[A` — bare Up) without double-ESC prefix is NOT a match', () => {
      expect(shouldSynthesizeMacDoubleEscCtrl({ key: 'up', sequence: '\x1b[A' })).toBe(false);
    });

    it('double-ESC prefix without CSI bracket (e.g. `\\x1b\\x1bO` SS3) is NOT a match', () => {
      // SS3-style sequences `\x1b\x1bO` start with double-ESC but are not
      // CSI. The exact prefix check `\x1b\x1b[` excludes them.
      expect(shouldSynthesizeMacDoubleEscCtrl({ key: 'up', sequence: '\x1b\x1bOA' })).toBe(false);
    });
  });

  describe('edge cases — missing or malformed fields', () => {
    it('missing sequence is NOT a match (parser dropped it)', () => {
      expect(shouldSynthesizeMacDoubleEscCtrl({ key: 'up' })).toBe(false);
    });

    it('non-string sequence is NOT a match (defensive against any-typed callers)', () => {
      expect(shouldSynthesizeMacDoubleEscCtrl({ key: 'up', sequence: undefined })).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(shouldSynthesizeMacDoubleEscCtrl({ key: 'up', sequence: 42 as any })).toBe(false);
    });

    it('missing key/name is NOT a match (can\'t verify arrow without a name)', () => {
      expect(shouldSynthesizeMacDoubleEscCtrl({ sequence: '\x1b\x1b[A' })).toBe(false);
    });

    it('key field is case-insensitive (some parsers uppercase)', () => {
      expect(shouldSynthesizeMacDoubleEscCtrl({ key: 'UP', sequence: '\x1b\x1b[A' })).toBe(true);
      expect(shouldSynthesizeMacDoubleEscCtrl({ name: 'Up', sequence: '\x1b\x1b[A' })).toBe(true);
    });
  });
});

// The OpenTUI bootstraps (shell + OpenCode) compose this helper to build
// the runtime Modifiers shape end-to-end. These pins cover every (terminal,
// modifier) interaction we know about — same matrix as the synth tests
// above, but verifying the full ctrl/alt/shift/meta tuple instead of just
// the synth boolean. A regression in the shell or OC bootstrap consumer
// would fail HERE before reaching the host, even though those bootstraps
// have no test scaffolding of their own.

describe('buildOpenTuiModifiers', () => {
  describe('macOS — Mac Terminal.app (double-ESC + CSI)', () => {
    it.each([
      ['up',    '\x1b\x1b[A'],
      ['down',  '\x1b\x1b[B'],
      ['right', '\x1b\x1b[C'],
      ['left',  '\x1b\x1b[D'],
    ])('Ctrl+Option+%s arrives as { option:true, sequence:%s } and lands ctrl+alt', (name, sequence) => {
      // What Ink + OpenTUI parsers actually produce for `\x1b\x1b[A` on Mac
      // Terminal.app: option flag set by double-ESC detection, meta set
      // alongside it on OpenTUI, ctrl absent because Terminal.app strips it.
      const mods = buildOpenTuiModifiers({ name, sequence, option: true, meta: true });
      expect(mods).toEqual({ ctrl: true, alt: true, shift: false, meta: true });
    });

    it('preserves meta in the modifier tuple (forbidModifiers:[meta] still works)', () => {
      // Mac Terminal.app double-ESC sets BOTH option and meta on the
      // parsed event. The runtime's `forbidModifiers: ['meta']` filter
      // (used e.g. for bare Escape) needs to keep seeing meta=true here
      // so it doesn't accidentally swallow a meta-bearing chord.
      const mods = buildOpenTuiModifiers({ name: 'up', sequence: '\x1b\x1b[A', option: true, meta: true });
      expect(mods.meta).toBe(true);
    });
  });

  describe('macOS — Ghostty / iTerm2 (xterm modifier-encoded CSI)', () => {
    it('Ctrl+Option+arrow with modifier byte 7 lands ctrl+alt without synth firing', () => {
      // `\x1b[1;7A` — modifier byte 7 = ctrl(4) + alt(2) + shift(1) → 7.
      // OpenTUI sets ctrl, option, meta directly; synth is gated on !ctrl
      // so it's a no-op here. Result must be the same as Mac Terminal.app.
      const mods = buildOpenTuiModifiers({ name: 'up', sequence: '\x1b[1;7A', ctrl: true, option: true, meta: true });
      expect(mods).toEqual({ ctrl: true, alt: true, shift: false, meta: true });
    });

    it('plain Option+arrow (modifier byte 3, ctrl=false) is NOT promoted to ctrl', () => {
      // `\x1b[1;3A` — modifier byte 3 = shift(1) + alt(2). OpenTUI also sets
      // option=true from the bit-2 (see parse.keypress:5966), so the synth
      // condition `option && arrow && !ctrl` looks tempting. The byte-prefix
      // gate is what prevents the hijack: this sequence doesn't start with
      // `\x1b\x1b[`, so ctrl stays false and plain Alt+arrow word-skip is
      // preserved.
      const mods = buildOpenTuiModifiers({ name: 'up', sequence: '\x1b[1;3A', option: true, meta: true });
      expect(mods).toEqual({ ctrl: false, alt: true, shift: false, meta: true });
    });
  });

  describe('Linux / Windows (xterm modifier-encoded CSI)', () => {
    it('Ctrl+Alt+arrow with modifier byte 7 lands ctrl+alt cleanly', () => {
      // Same byte form Ghostty uses — Linux xterm + Windows Terminal both
      // ship CSI 1;7 for Ctrl+Alt+arrow. No Option key concept; alt is
      // already set explicitly by the parser.
      const mods = buildOpenTuiModifiers({ name: 'up', sequence: '\x1b[1;7A', ctrl: true, alt: true });
      expect(mods).toEqual({ ctrl: true, alt: true, shift: false, meta: false });
    });

    it('plain Alt+arrow on Linux is NOT promoted to ctrl (word-skip preserved)', () => {
      // The regression guard. OpenTUI's parser sets option=true from
      // modifier bit 2 even on non-Mac terminals — the byte-prefix gate
      // is what keeps this safe.
      const mods = buildOpenTuiModifiers({ name: 'up', sequence: '\x1b[1;3A', alt: true, option: true });
      expect(mods).toEqual({ ctrl: false, alt: true, shift: false, meta: false });
    });

    it('plain arrow (no modifier byte, no ESC prefix) carries no modifiers', () => {
      const mods = buildOpenTuiModifiers({ name: 'up', sequence: '\x1b[A' });
      expect(mods).toEqual({ ctrl: false, alt: false, shift: false, meta: false });
    });
  });

  describe('shift + multi-modifier combinations', () => {
    it('Ctrl+Shift+arrow on xterm (modifier byte 6) lands ctrl+shift', () => {
      // `\x1b[1;6A` — modifier byte 6 = ctrl(4) + shift(1) → 5; 5+1=6
      // (the parsed modifier is 6, which encodes ctrl+shift). Used by the
      // optional `nav-keymap: ctrl-shift` mode.
      const mods = buildOpenTuiModifiers({ name: 'up', sequence: '\x1b[1;6A', ctrl: true, shift: true });
      expect(mods).toEqual({ ctrl: true, alt: false, shift: true, meta: false });
    });

    it('Ctrl+Alt+Shift+arrow lands all three (no synth, ctrl already set)', () => {
      const mods = buildOpenTuiModifiers({ name: 'up', sequence: '\x1b[1;8A', ctrl: true, alt: true, shift: true, option: true, meta: true });
      expect(mods).toEqual({ ctrl: true, alt: true, shift: true, meta: true });
    });
  });

  describe('alt coalesce semantics (option || alt || meta → alt)', () => {
    it('option-only lights alt (Mac chord without Ctrl)', () => {
      expect(buildOpenTuiModifiers({ name: 'a', option: true }).alt).toBe(true);
    });
    it('alt-only lights alt (Linux/Windows non-Mac path)', () => {
      expect(buildOpenTuiModifiers({ name: 'a', alt: true }).alt).toBe(true);
    });
    it('meta-only lights alt (defensive — historical hosts that surfaced meta in lieu of alt)', () => {
      expect(buildOpenTuiModifiers({ name: 'a', meta: true }).alt).toBe(true);
    });
    it('all three flags set: alt is still just true (no double-counting weirdness)', () => {
      expect(buildOpenTuiModifiers({ name: 'a', option: true, alt: true, meta: true }).alt).toBe(true);
    });
    it('none set: alt is false', () => {
      expect(buildOpenTuiModifiers({ name: 'a' }).alt).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('missing fields default to false (defensive against any-typed callers)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mods = buildOpenTuiModifiers({} as any);
      expect(mods).toEqual({ ctrl: false, alt: false, shift: false, meta: false });
    });

    it('synth path requires the sequence — double-ESC on the key name alone is not enough', () => {
      // Defensive: don't trust someone passing key:"up" without proving the
      // byte stream actually carried double-ESC.
      const mods = buildOpenTuiModifiers({ name: 'up', option: true, meta: true });
      expect(mods.ctrl).toBe(false);
    });
  });
});
