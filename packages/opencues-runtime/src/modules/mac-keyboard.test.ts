import { describe, expect, it } from 'vitest';
import { shouldSynthesizeMacDoubleEscCtrl } from './mac-keyboard';

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
