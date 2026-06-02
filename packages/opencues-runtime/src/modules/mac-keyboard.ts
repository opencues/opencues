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

// ── Mac Terminal.app double-ESC → modifier-CSI stdin rewrite ──────────────
//
// `shouldSynthesizeMacDoubleEscCtrl` above runs at the PARSED-event layer. That
// is enough only when the host's keypress parser preserves the double-ESC on
// the arrow event. On Claude Code 2.1.158 (Ink) it does NOT: Ink SPLITS the raw
// `\x1b\x1b[A` chord into two events — a standalone `escape` (seq `\x1b`) + a
// plain arrow (seq `\x1b[A`) — before any consumer sees it, so the arrow no
// longer carries the prefix and the synth above can never fire (proven on a
// real device: `{key:"escape",seq:"\x1b"}` then `{key:"up",seq:"\x1b[A"}`,
// same millisecond).
//
// We therefore fix it one layer EARLIER: rewrite the raw stdin chunk before the
// parser runs (as a Buffer, or as a utf8 string — Ink pulls input via
// 'readable' + `read()` with `setEncoding('utf8')`, so its chunks are strings).
// `\x1b\x1b[A/B/C/D` → `\x1b[1;7A/B/C/D` — the xterm
// modifier-encoded form (param 7 = 1 + Ctrl(4) + Alt(2)) that Ghostty/iTerm2
// already send for this exact chord and that every parser decodes directly to
// `{ctrl:true, alt:true}`. Terminal.app input becomes byte-identical to the
// known-working Ghostty path.
//
// Why this is safe — the contiguous-byte invariant:
//   The terminal writes the chord's 4 bytes with a single write(2), so they
//   land together in ONE stdin read buffer. A real lone Escape arrives as its
//   own buffer (`\x1b`); a human Esc-then-arrow arrives as two buffers tens of
//   ms apart. Matching `\x1b\x1b[A` only WITHIN a single buffer therefore can
//   never match a real Escape — no state, no timing window, no Escape latency.
//   (Cross-chunk buffering was rejected: it forces a flush-timer that brings
//   back exactly that Escape-latency problem.)
//
// Degradation floor: on split-chunk transports (tmux/ssh) where the 4 bytes
// arrive across two reads, the rewrite no-ops — behaviour is identical to not
// having it, never worse. This targets local Terminal.app, the reported case.

const ESC = 0x1b;
const CSI_BRACKET = 0x5b; // '['
// Arrow CSI finals: A=up B=down C=right D=left.
const ARROW_FINALS: ReadonlySet<number> = new Set([0x41, 0x42, 0x43, 0x44]);

/**
 * Rewrites every Mac Terminal.app `\x1b\x1b[A/B/C/D` (double-ESC arrow) in a raw
 * stdin chunk to its xterm modifier-encoded Ctrl+Alt equivalent `\x1b[1;7A…`.
 * Operates purely at the byte level (no string/encoding round-trip, so UTF-8 or
 * binary bytes pass through untouched). Returns the SAME Buffer instance when
 * there is no full chord to rewrite — no allocation on the hot path (the common
 * case for every ordinary keystroke and pasted character).
 */
export function rewriteMacDoubleEscArrows(chunk: Buffer): Buffer {
  // Fast path: bail (same instance) unless a full `\x1b\x1b[{A|B|C|D}` chord is
  // present. Anchored to exactly 4 bytes — `\x1b\x1b[2A`, `\x1b\x1bOA`, plain
  // `\x1b[A`, paste/mouse CSI, and truncated tails all fall through unchanged.
  let hasChord = false;
  for (let i = 0; i + 3 < chunk.length; i++) {
    if (
      chunk[i] === ESC && chunk[i + 1] === ESC &&
      chunk[i + 2] === CSI_BRACKET && ARROW_FINALS.has(chunk[i + 3])
    ) { hasChord = true; break; }
  }
  if (!hasChord) return chunk;

  const out: number[] = [];
  for (let i = 0; i < chunk.length; ) {
    if (
      i + 3 < chunk.length &&
      chunk[i] === ESC && chunk[i + 1] === ESC &&
      chunk[i + 2] === CSI_BRACKET && ARROW_FINALS.has(chunk[i + 3])
    ) {
      // ESC [ 1 ; 7 {final}  — modifier-encoded Ctrl+Alt arrow.
      out.push(ESC, CSI_BRACKET, 0x31, 0x3b, 0x37, chunk[i + 3]);
      i += 4;
    } else {
      out.push(chunk[i]);
      i += 1;
    }
  }
  return Buffer.from(out);
}

// Matches an exact 4-char chord `ESC ESC [ {A|B|C|D}`. `[A-D]` excludes the
// digit in `\x1b\x1b[2A` and the missing-bracket `\x1b\x1bOA`.
const STRING_CHORD_RE = /\x1b\x1b\[([A-D])/g;

/**
 * String form of {@link rewriteMacDoubleEscArrows}. Needed because the host's
 * input parser (Ink / Claude Code) calls `stdin.setEncoding('utf8')`, so the
 * chunks it pulls via `read()` arrive as STRINGS, not Buffers. ESC (`\x1b`) and
 * the arrow finals are single-byte/ASCII, so the chord survives utf8 decoding
 * as the 4-char string `"\x1b\x1b[A"` and a plain replace is byte-exact.
 * Returns the input unchanged (same reference) when there is no chord.
 */
export function rewriteMacDoubleEscArrowsString(input: string): string {
  if (input.indexOf('\x1b\x1b[') === -1) return input;
  return input.replace(STRING_CHORD_RE, '\x1b[1;7$1');
}

const STDIN_REWRITE_GUARD = Symbol.for('opencues.macDoubleEscStdinRewrite');

interface RewritableStdin {
  emit?: (event: string | symbol, ...args: unknown[]) => boolean;
  read?: (size?: number) => unknown;
}

/**
 * Installs the double-ESC rewrite on a stdin stream so each incoming chunk is
 * normalised BEFORE the host's keypress parser sees it. macOS-only and
 * idempotent per stream. Returns true if it wrapped anything, false if it
 * skipped (non-darwin, already installed, or no usable stream).
 *
 * Wraps TWO consumption paths, because hosts differ:
 *   - `read()` — PRIMARY. Ink / Claude Code consume stdin via 'readable' +
 *     `read()` with `setEncoding('utf8')`, so `read()` returns STRINGS. This is
 *     the path that actually matters on CC.
 *   - `emit('data', …)` — flowing-mode hosts; payload may be Buffer or string.
 * Both dispatch on payload type so Buffer and string transports are covered.
 *
 * Timing note: callers install this from `boot()`, which on CC runs lazily on
 * the FIRST key dispatch — so the very first keystroke of a session is not
 * rewritten (it was already pulled upstream). Every subsequent keystroke is
 * covered, which suffices: the first key is in practice a normal character, and
 * the wrap is armed long before any Ctrl+Option+arrow.
 */
export function installMacDoubleEscStdinRewrite(
  stdin: RewritableStdin | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false;
  if (!stdin) return false;
  const guarded = stdin as RewritableStdin & Record<symbol, unknown>;
  if (guarded[STDIN_REWRITE_GUARD]) return false;

  let wrapped = false;
  const originals: { read?: unknown; emit?: unknown } = {};

  // PRIMARY: the read()-pull path Ink/CC actually use (utf8 strings).
  if (typeof stdin.read === 'function') {
    const originalRead = stdin.read.bind(stdin);
    originals.read = stdin.read;
    stdin.read = function (size?: number): unknown {
      const chunk = size === undefined ? originalRead() : originalRead(size);
      if (typeof chunk === 'string') return rewriteMacDoubleEscArrowsString(chunk);
      if (Buffer.isBuffer(chunk)) return rewriteMacDoubleEscArrows(chunk);
      return chunk;
    };
    wrapped = true;
  }

  // SECONDARY: flowing-mode 'data' events (Buffer, or string once encoded).
  if (typeof stdin.emit === 'function') {
    const originalEmit = stdin.emit;
    originals.emit = stdin.emit;
    stdin.emit = function (this: unknown, event: string | symbol, ...args: unknown[]): boolean {
      if (event === 'data') {
        if (Buffer.isBuffer(args[0])) args[0] = rewriteMacDoubleEscArrows(args[0]);
        else if (typeof args[0] === 'string') args[0] = rewriteMacDoubleEscArrowsString(args[0]);
      }
      return originalEmit.apply(this, [event, ...args]);
    };
    wrapped = true;
  }

  if (!wrapped) return false;
  // Non-enumerable + namespaced symbol so the guard never leaks into code that
  // enumerates the stream and a second installer can't collide. Stashes the
  // originals so the wrap is teardownable if ever needed.
  Object.defineProperty(stdin, STDIN_REWRITE_GUARD, {
    value: originals,
    enumerable: false,
    configurable: true,
  });
  return true;
}
