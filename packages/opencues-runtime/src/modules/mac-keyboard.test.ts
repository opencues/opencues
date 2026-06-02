import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  shouldSynthesizeMacDoubleEscCtrl,
  rewriteMacDoubleEscArrows,
  rewriteMacDoubleEscArrowsString,
  installMacDoubleEscStdinRewrite,
} from './mac-keyboard';

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
      // `\x1b[1;7A` — modifier param 7 = 1 + Ctrl(4) + Alt(2) = ctrl+alt
      // (NOT ctrl+alt+shift, which is `1;8`). ctrl is set directly by the
      // parser, so the synth is a structural no-op here.
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

// Byte-level rewrite that fires UPSTREAM of the parser (for Ink, which splits
// the double-ESC chord into escape + plain-arrow before the event-level synth
// above can see it). `\x1b\x1b[A/B/C/D` → `\x1b[1;7A/B/C/D`.
describe('rewriteMacDoubleEscArrows', () => {
  it.each([
    ['up',    '\x1b\x1b[A', '\x1b[1;7A'],
    ['down',  '\x1b\x1b[B', '\x1b[1;7B'],
    ['right', '\x1b\x1b[C', '\x1b[1;7C'],
    ['left',  '\x1b\x1b[D', '\x1b[1;7D'],
  ])('rewrites Ctrl+Option+%s to modifier-encoded Ctrl+Alt', (_key, raw, want) => {
    const got = rewriteMacDoubleEscArrows(Buffer.from(raw, 'latin1'));
    expect(got.equals(Buffer.from(want, 'latin1'))).toBe(true);
  });

  it('returns the SAME buffer instance when there is no chord (hot path, no alloc)', () => {
    const buf = Buffer.from('the contract shall indemnify', 'latin1');
    expect(rewriteMacDoubleEscArrows(buf)).toBe(buf);
  });

  it('rewrites every occurrence when a buffer holds multiple chords', () => {
    const got = rewriteMacDoubleEscArrows(Buffer.from('\x1b\x1b[A\x1b\x1b[B', 'latin1'));
    expect(got.equals(Buffer.from('\x1b[1;7A\x1b[1;7B', 'latin1'))).toBe(true);
  });

  it('rewrites a chord embedded mid-buffer; surrounding bytes stay byte-identical', () => {
    const got = rewriteMacDoubleEscArrows(Buffer.from('foo\x1b\x1b[Abar', 'latin1'));
    expect(got.equals(Buffer.from('foo\x1b[1;7Abar', 'latin1'))).toBe(true);
  });

  it.each([
    ['single-ESC arrow (plain Up)',           '\x1b[A'],
    ['bracketed-paste start',                 '\x1b[200~'],
    ['SGR mouse report',                      '\x1b[<0;1;1M'],
    ['double-ESC SS3 (no `[` bracket)',       '\x1b\x1bOA'],
    ['double-ESC + digit (not arrow letter)', '\x1b\x1b[2A'],
  ])('leaves %s untouched (same instance)', (_label, seq) => {
    const buf = Buffer.from(seq, 'latin1');
    expect(rewriteMacDoubleEscArrows(buf)).toBe(buf);
  });

  it('preserves high/UTF-8 bytes around a chord (byte-level, no encoding round-trip)', () => {
    // 0xC3 0xA9 = "é"; 0x80 / 0xBF are UTF-8 continuation bytes.
    const input = Buffer.from([0xc3, 0xa9, 0x1b, 0x1b, 0x5b, 0x41, 0x80, 0xbf]);
    const want = Buffer.from([0xc3, 0xa9, 0x1b, 0x5b, 0x31, 0x3b, 0x37, 0x41, 0x80, 0xbf]);
    expect(rewriteMacDoubleEscArrows(input).equals(want)).toBe(true);
  });

  it.each([
    ['empty',                            ''],
    ['lone ESC',                         '\x1b'],
    ['double-ESC tail',                  '\x1b\x1b'],
    ['double-ESC + bracket, no final',   '\x1b\x1b['],
  ])('does not throw and leaves %s unchanged', (_label, seq) => {
    const buf = Buffer.from(seq, 'latin1');
    expect(rewriteMacDoubleEscArrows(buf)).toBe(buf);
  });
});

// String form — used for Ink/CC, which sets utf8 encoding so read() yields
// strings, not Buffers.
describe('rewriteMacDoubleEscArrowsString', () => {
  it.each([
    ['up',    '\x1b\x1b[A', '\x1b[1;7A'],
    ['down',  '\x1b\x1b[B', '\x1b[1;7B'],
    ['right', '\x1b\x1b[C', '\x1b[1;7C'],
    ['left',  '\x1b\x1b[D', '\x1b[1;7D'],
  ])('rewrites Ctrl+Option+%s', (_key, raw, want) => {
    expect(rewriteMacDoubleEscArrowsString(raw)).toBe(want);
  });

  it('returns the same string when there is no chord', () => {
    const s = 'the contract shall indemnify';
    expect(rewriteMacDoubleEscArrowsString(s)).toBe(s);
  });

  it('rewrites every occurrence and preserves surrounding text', () => {
    expect(rewriteMacDoubleEscArrowsString('foo\x1b\x1b[A\x1b\x1b[Bbar')).toBe('foo\x1b[1;7A\x1b[1;7Bbar');
  });

  it.each([
    ['single-ESC arrow',                '\x1b[A'],
    ['bracketed-paste start',           '\x1b[200~'],
    ['SGR mouse',                       '\x1b[<0;1;1M'],
    ['double-ESC SS3 (no bracket)',     '\x1b\x1bOA'],
    ['double-ESC + digit (not arrow)',  '\x1b\x1b[2A'],
    ['empty',                           ''],
    ['lone ESC',                        '\x1b'],
    ['double-ESC + bracket, no final',  '\x1b\x1b['],
  ])('leaves %s unchanged', (_label, seq) => {
    expect(rewriteMacDoubleEscArrowsString(seq)).toBe(seq);
  });
});

describe('installMacDoubleEscStdinRewrite', () => {
  const chord = Buffer.from('\x1b\x1b[A', 'latin1');
  const ctrlAlt = Buffer.from('\x1b[1;7A', 'latin1');

  it('does NOT wrap emit on non-darwin platforms (chord passes through verbatim)', () => {
    const stream = new EventEmitter();
    expect(installMacDoubleEscStdinRewrite(stream, 'linux')).toBe(false);
    let seen: Buffer | null = null;
    stream.on('data', (d: Buffer) => { seen = d; });
    stream.emit('data', chord);
    expect(seen!.equals(chord)).toBe(true);
  });

  it('rewrites a chord data buffer before listeners see it (darwin)', () => {
    const stream = new EventEmitter();
    expect(installMacDoubleEscStdinRewrite(stream, 'darwin')).toBe(true);
    let seen: Buffer | null = null;
    stream.on('data', (d: Buffer) => { seen = d; });
    stream.emit('data', chord);
    expect(seen!.equals(ctrlAlt)).toBe(true);
  });

  it('passes a non-chord data buffer through as the SAME instance', () => {
    const stream = new EventEmitter();
    installMacDoubleEscStdinRewrite(stream, 'darwin');
    const plain = Buffer.from('hi', 'latin1');
    let seen: Buffer | null = null;
    stream.on('data', (d: Buffer) => { seen = d; });
    stream.emit('data', plain);
    expect(seen).toBe(plain);
  });

  it('leaves non-data events untouched and preserves emit\'s return value', () => {
    const stream = new EventEmitter();
    installMacDoubleEscStdinRewrite(stream, 'darwin');
    expect(stream.emit('end')).toBe(false); // no listener yet
    let ended = false;
    stream.on('end', () => { ended = true; });
    expect(stream.emit('end')).toBe(true); // listener present
    expect(ended).toBe(true);
  });

  it('rewrites a chord delivered as a STRING data payload (encoding-mode stdin)', () => {
    const stream = new EventEmitter();
    installMacDoubleEscStdinRewrite(stream, 'darwin');
    let seen: unknown = null;
    stream.on('data', (d: unknown) => { seen = d; });
    stream.emit('data', '\x1b\x1b[A');
    expect(seen).toBe('\x1b[1;7A');
  });

  it('passes a non-chord string data payload through unchanged', () => {
    const stream = new EventEmitter();
    installMacDoubleEscStdinRewrite(stream, 'darwin');
    let seen: unknown = null;
    stream.on('data', (d: unknown) => { seen = d; });
    stream.emit('data', 'hello');
    expect(seen).toBe('hello');
  });

  it('rewrites a chord pulled via read() as a utf8 STRING — the real Ink path', () => {
    // Ink consumes stdin via 'readable' + read() with setEncoding('utf8'), so
    // read() returns strings. This is the path that actually matters on CC.
    const stdin = { read: () => '\x1b\x1b[A' };
    expect(installMacDoubleEscStdinRewrite(stdin, 'darwin')).toBe(true);
    expect(stdin.read()).toBe('\x1b[1;7A');
  });

  it('passes a non-chord read() string through unchanged', () => {
    const stdin = { read: () => 'hello world' };
    installMacDoubleEscStdinRewrite(stdin, 'darwin');
    expect(stdin.read()).toBe('hello world');
  });

  it('rewrites a Buffer returned by read() (no-encoding stdin)', () => {
    const stdin = { read: () => Buffer.from('\x1b\x1b[A', 'latin1') };
    installMacDoubleEscStdinRewrite(stdin, 'darwin');
    expect((stdin.read() as Buffer).equals(Buffer.from('\x1b[1;7A', 'latin1'))).toBe(true);
  });

  it('passes read() null through (no data buffered)', () => {
    const stdin = { read: () => null };
    installMacDoubleEscStdinRewrite(stdin, 'darwin');
    expect(stdin.read()).toBe(null);
  });

  it('returns false and wraps nothing for a stream with neither read nor emit', () => {
    expect(installMacDoubleEscStdinRewrite({}, 'darwin')).toBe(false);
    expect(installMacDoubleEscStdinRewrite(null, 'darwin')).toBe(false);
    expect(installMacDoubleEscStdinRewrite(undefined, 'darwin')).toBe(false);
  });

  it('is idempotent — installing twice wraps emit only once (no double rewrite)', () => {
    const stream = new EventEmitter();
    expect(installMacDoubleEscStdinRewrite(stream, 'darwin')).toBe(true);
    expect(installMacDoubleEscStdinRewrite(stream, 'darwin')).toBe(false);
    let seen: Buffer | null = null;
    stream.on('data', (d: Buffer) => { seen = d; });
    stream.emit('data', chord);
    expect(seen!.equals(ctrlAlt)).toBe(true); // rewritten once, not twice
  });

  it('preserves `this` binding for downstream listeners', () => {
    const stream = new EventEmitter();
    installMacDoubleEscStdinRewrite(stream, 'darwin');
    let thisArg: unknown = null;
    stream.on('data', function (this: unknown) { thisArg = this; });
    stream.emit('data', chord);
    expect(thisArg).toBe(stream);
  });

  // Scenario test (not a mock): drive a REAL node Readable exactly the way Ink
  // consumes stdin — setEncoding('utf8') + 'readable' + a `while (read())` loop.
  // This is the wiring the original emit-only attempt failed at; pinning it here
  // structurally prevents a regression of that class.
  it('rewrites through a real Readable consumed the Ink way (readable + read() + utf8)', async () => {
    const stream = new Readable({ read() { /* push-driven */ } });
    stream.setEncoding('utf8');
    expect(installMacDoubleEscStdinRewrite(stream, 'darwin')).toBe(true);

    const out: string[] = [];
    await new Promise<void>((resolve) => {
      stream.on('readable', () => {
        let c: unknown;
        while ((c = stream.read()) !== null) out.push(c as string);
      });
      stream.on('end', () => resolve());
      stream.push(Buffer.from('foo\x1b\x1b[Abar', 'latin1')); // one atomic chord write
      stream.push(null);
    });

    expect(out.join('')).toBe('foo\x1b[1;7Abar');
  });
});
