// Single-character animation that plays at a blank slot while its
// async source (LLM call, script invocation, HTTP fetch) is in flight.
// The animated character occupies the SAME column as the original `_`
// so the buffer layout stays stable — only the glyph changes per tick.
//
// Two ready-made frame sequences:
//
//   bounce    `_` → `-` → `‾` → `-` → `_` …    a vertical pulse
//   dot-walk  `_` → `.` → `·` → `.` → `_` …    a horizontal compress
//
// Both are 4-frame palindromes (frame 0 = frame 4 = `_`), so the
// underscore is always one of the visible states. When the source
// resolves, callers invoke `stop(wordIndex)` which restores the slot
// to `_` so the existing substitution path can splice the answer in
// the way it always has.
//
// Design constraints:
//   - One shared setInterval across all active slots (cheap; users
//     rarely have > 2-3 in flight simultaneously).
//   - Animation writes go through adapter.setText, marked via
//     reclassifier hints where the host needs them.
//   - If a tick finds the slot's word is no longer one of our frame
//     characters (user typed over it, or the substitution path ran
//     between ticks), the animator silently stops that slot.

import type { HostAdapter } from '../adapter';

export type BlankLoadingMode = 'bounce' | 'braille-rotate' | 'flipper' | 'off' | 'custom';

export const BOUNCE_FRAMES: readonly string[] = ['_', '-', '‾', '-'];

/** A line that flips through orientations — underscore, backslash, pipe,
 *  forward-slash — then wraps back to `_`. Reads as a single mark
 *  rotating in place. 4 frames, full-loop (returns to `_` like bounce). */
export const FLIPPER_FRAMES: readonly string[] = ['_', '\\', '|', '/'];

/** Max frames allowed in a user-supplied custom animation. Larger
 *  values get silently truncated. Five is enough for any reasonable
 *  loading-glyph progression at 150ms/frame (750ms full cycle). */
export const CUSTOM_FRAMES_MAX = 5;

/** Normalize a raw `blank-loading-frames` setting (comma-separated
 *  string from OPENCUES.md) into a usable frame list. Trims whitespace
 *  from each item, drops empties, caps at `CUSTOM_FRAMES_MAX`. Returns
 *  null when the result is empty/unusable — callers fall back to
 *  `braille-rotate` in that case so a misconfigured setting never
 *  produces a dead loading slot. */
export function parseCustomFrames(raw: string | undefined): readonly string[] | null {
  if (!raw) return null;
  const items = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (items.length === 0) return null;
  return items.slice(0, CUSTOM_FRAMES_MAX);
}

// ─── Colour overrides ────────────────────────────────────────────────────
//
// Two parallel lists: RGB/HEX (for hosts that render full colour, e.g.
// chrome) and ANSI (for hosts limited to terminal colour escapes).
// Each color[i] is the colour applied to frame[i]; if there are fewer
// colours than frames, frames past the end fall back to no colour.
//
// Platform picks: chrome adapter consumes `rgbColors`; terminal
// adapters (CC / OC / gemini) consume `ansiColors`. If the chosen
// list is empty / invalid, the host renders the loading char in its
// default foreground (current behaviour).

/** Hex `#rrggbb` / `#rgb`. Whitespace tolerated. */
const HEX_LONG  = /^#[0-9a-fA-F]{6}$/;
const HEX_SHORT = /^#[0-9a-fA-F]{3}$/;

/** Parse the `blank-loading-colors-rgb` scalar. Each token must be a
 *  6-digit hex (`#1a2b3c`) or 3-digit hex (`#abc`). `rgb(r,g,b)`
 *  intentionally not supported — its commas collide with the
 *  comma-separated list shape; users can convert to hex (every
 *  picker exports it). Returns null when no valid entries — caller
 *  falls back to no-colour rendering. Caps at `CUSTOM_FRAMES_MAX`. */
export function parseRgbColors(raw: string | undefined): readonly string[] | null {
  if (!raw) return null;
  const items = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  const valid: string[] = [];
  for (const it of items) {
    if (HEX_LONG.test(it)) valid.push(it.toLowerCase());
    else if (HEX_SHORT.test(it)) {
      // Expand #abc → #aabbcc so the host doesn't have to.
      const [, r, g, b] = it.match(/^#(.)(.)(.)$/) ?? [];
      valid.push(`#${r}${r}${g}${g}${b}${b}`.toLowerCase());
    }
    if (valid.length >= CUSTOM_FRAMES_MAX) break;
  }
  return valid.length > 0 ? valid : null;
}

/** Accepted ANSI tokens — named 8-colour set, 256-colour index, or
 *  `bright_*` for the high-intensity range. Validation is permissive —
 *  the renderer decides how to translate each token to an escape; this
 *  parser just normalises the spelling. */
const ANSI_NAMES = new Set([
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright_black', 'bright_red', 'bright_green', 'bright_yellow',
  'bright_blue', 'bright_magenta', 'bright_cyan', 'bright_white',
  // Common aliases.
  'gray', 'grey',
]);

/** Failover RGB palette when `blank-loading-colors-rgb` is unset, empty,
 *  or fails to parse. Mirrors the shipped defaults in `defaults/OPENCUES.md`
 *  so a misconfigured user sees the same colours as a fresh install
 *  instead of a flat host-default fg. */
export const DEFAULT_RGB_PALETTE: readonly string[] = [
  '#ef4444', // red-500
  '#f59e0b', // amber-500
  '#10b981', // emerald-500
  '#06b6d4', // cyan-500
  '#3b82f6', // blue-500
];

/** Failover ANSI palette — parallel to `DEFAULT_RGB_PALETTE` for terminal
 *  hosts that lack `render-rgb-color` capability (CC, gemini). */
export const DEFAULT_ANSI_PALETTE: readonly string[] = [
  'red', 'yellow', 'green', 'cyan', 'blue',
];

/** Default per-frame duration. 150ms is gentle on chrome's
 *  contenteditable reconcilers and readable in terminals. */
export const FRAME_INTERVAL_DEFAULT_MS = 150;
/** Lower bound — anything faster flickers in most terminals + chokes
 *  managed-editor mutation observers. */
export const FRAME_INTERVAL_MIN_MS = 30;
/** Upper bound — anything slower stops reading as "loading" and starts
 *  looking like a stalled UI. */
export const FRAME_INTERVAL_MAX_MS = 2000;

/** Parse the `blank-loading-interval-ms` scalar to a number of ms.
 *  Clamps to `[FRAME_INTERVAL_MIN_MS, FRAME_INTERVAL_MAX_MS]`; falls
 *  back to `FRAME_INTERVAL_DEFAULT_MS` on unset / invalid input. */
export function parseFrameIntervalMs(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= FRAME_INTERVAL_MIN_MS && n <= FRAME_INTERVAL_MAX_MS
    ? n
    : FRAME_INTERVAL_DEFAULT_MS;
}

/** Parse the `blank-loading-colors-ansi` scalar. Accepts named colours
 *  (`red`, `bright_cyan`, etc.) or 256-colour indices (`0`-`255`).
 *  Returns null when no valid entries. Caps at `CUSTOM_FRAMES_MAX`. */
export function parseAnsiColors(raw: string | undefined): readonly string[] | null {
  if (!raw) return null;
  const items = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  const valid: string[] = [];
  for (const it of items) {
    const lower = it.toLowerCase();
    if (ANSI_NAMES.has(lower)) {
      valid.push(lower === 'gray' || lower === 'grey' ? 'bright_black' : lower);
    } else if (/^\d{1,3}$/.test(it)) {
      const n = Number(it);
      if (n >= 0 && n <= 255) valid.push(String(n));
    }
    if (valid.length >= CUSTOM_FRAMES_MAX) break;
  }
  return valid.length > 0 ? valid : null;
}

/** A single braille dot circles clockwise through the 6 cell positions,
 *  returning to `_` between cycles. The visual is a 6-frame rotation
 *  preceded by the rest frame `_` — 7 frames total, then loops.
 *
 *    _   ⠁   ⠈   ⠐   ⠠   ⠄   ⠂   _   …
 *
 *  Position map (Unicode 1-dot braille):
 *    top-left  ⠁ (U+2801)        top-right  ⠈ (U+2808)
 *    mid-left  ⠂ (U+2802)        mid-right  ⠐ (U+2810)
 *    bot-left  ⠄ (U+2804)        bot-right  ⠠ (U+2820)
 *
 *  Walk order is clockwise from the top-left: top-left → top-right →
 *  mid-right → bot-right → bot-left → mid-left → loop back to `_`. */
export const BRAILLE_ROTATE_FRAMES: readonly string[] = [
  '_',
  '⠁',  // top-left
  '⠈',  // top-right
  '⠐',  // mid-right
  '⠠',  // bot-right
  '⠄',  // bot-left
  '⠂',  // mid-left
];

export function framesFor(
  mode: BlankLoadingMode,
  customFrames?: readonly string[] | null,
): readonly string[] {
  if (mode === 'bounce') return BOUNCE_FRAMES;
  if (mode === 'braille-rotate') return BRAILLE_ROTATE_FRAMES;
  if (mode === 'flipper') return FLIPPER_FRAMES;
  if (mode === 'custom') {
    // Empty / invalid custom config → fall back to braille-rotate.
    // The validation rules are in parseCustomFrames; callers pass its
    // output here. Internal fallback keeps misconfigured users in a
    // working state rather than producing dead slots.
    return customFrames && customFrames.length > 0
      ? customFrames
      : BRAILLE_ROTATE_FRAMES;
  }
  return [];
}

/**
 * Some modes have an "intro" prefix played once at the start, with the
 * loop body following. `loopStartIdxFor(mode)` returns the first frame
 * index that participates in the repeating loop — everything before it
 * is intro-only and is skipped on wrap-around.
 *
 *   bounce        → 0  ('_' is part of the bounce; cycle returns to it)
 *   braille-rotate → 1  (leading '_' is intro; loop spins only the 6
 *                       dot positions, never returning to '_')
 */
export function loopStartIdxFor(
  mode: BlankLoadingMode,
  customFramesPresent?: boolean,
): number {
  if (mode === 'braille-rotate') return 1;
  // `custom` with a valid list loops the entire user-supplied
  // sequence (no intro skip); when it falls back to braille-rotate
  // (no valid list), inherit braille-rotate's loop semantics.
  if (mode === 'custom' && !customFramesPresent) return 1;
  return 0;
}

/** Every character that may legitimately occupy a loading slot. The
 *  animator uses this set to detect "should I keep animating" — if a
 *  tick reads the slot and finds a character outside this set, it
 *  means the user typed over it OR the substitution path already
 *  replaced it. In either case the animator drops the slot. */
export const ALL_FRAME_CHARS: ReadonlySet<string> = new Set([
  ...BOUNCE_FRAMES, ...BRAILLE_ROTATE_FRAMES, ...FLIPPER_FRAMES,
]);

export interface BlankLoadingOptions {
  /** ms between frame swaps. Default 150 — readable in terminals, gentle
   *  on chrome's contenteditable reconcilers. Thunk-shaped so a hot
   *  OPENCUES.md edit takes effect on the NEXT slot activation (in-flight
   *  animations keep their captured speed; restart is cheap once they end). */
  readonly frameIntervalMs?: () => number;
  /** Currently active mode. The animator reads this lazily on every
   *  start() so callers can hot-flip via OPENCUES.md without recreating
   *  the instance. */
  readonly mode: () => BlankLoadingMode;
  /** Frames for the `custom` mode, lazily read so OPENCUES.md edits
   *  flow through without a restart. Return value of `parseCustomFrames`
   *  is the expected shape (validated, capped at CUSTOM_FRAMES_MAX).
   *  Optional — when omitted, `custom` falls back to braille-rotate. */
  readonly customFrames?: () => readonly string[] | null;
  /** Per-frame RGB/HEX colours (`#1a2b3c`), lazily read; parallel to
   *  the active frames array. color[i] is applied to frame[i]; frames
   *  past the colours-array length render with no colour override.
   *  Consumed by hosts that render true colour (chrome). Return shape
   *  is `parseRgbColors`'s output. */
  readonly rgbColors?: () => readonly string[] | null;
  /** Per-frame ANSI colours (`red`, `bright_cyan`, `196`, …). Consumed
   *  by terminal-based hosts (CC / OC / gemini). Same parallel-to-frames
   *  semantics as `rgbColors`. Return shape is `parseAnsiColors`'s. */
  readonly ansiColors?: () => readonly string[] | null;
  /** Host adapter for getText / setText. */
  readonly adapter: HostAdapter;
  /** Optional debug log. */
  readonly log?: (msg: string) => void;
}

interface ActiveSlot {
  readonly wordIndex: number;
  readonly frames: readonly string[];
  /** First frame index that participates in the repeating loop. Frames
   *  in [0, loopStartIdx) are intro-only and are skipped on wrap.
   *  Bounce uses 0 (full-loop palindrome includes `_`); braille-rotate
   *  uses 1 (leading `_` is shown once then the dot rotation loops). */
  readonly loopStartIdx: number;
  /** Index into `frames`. Starts at 0, ticks bump it; wraps to
   *  `loopStartIdx` (not 0) at end-of-array. */
  frameIdx: number;
}

/**
 * Per-buffer loading-animation manager. One instance per BlankFill;
 * created by the runtime once at boot.
 *
 *   start(wordIndex, owner)  — claim a slot and begin animating.
 *   stop(wordIndex, owner)   — release this owner's claim; the slot
 *                              stops only when the LAST owner releases.
 *   stopAll(owner?)          — release every active slot (used on
 *                              adapter teardown). With an owner, only
 *                              that owner's claims are released.
 *
 * Owner-based refcounting matters because two modules independently
 * animate the same slot:
 *   - BlankFill animates keyword-bound `_` (stocks, weather, volume)
 *     while its blankInvoke / spawnProcess call is in flight.
 *   - Resolver animates every `_` for the duration of its source pass
 *     (covers FluidBlank / TransformBlank LLM round-trips).
 * Without refcounting, the Resolver — which returns within ~1ms for a
 * `_` that no resolver-side source claims (the keyword-bound case) —
 * would kill BlankFill's still-pending animation. The first frame
 * never paints (tick interval is 150ms; resolver's stop fires before
 * the timer ever ticks).
 *
 * Tests in `blank-loading.test.ts` exercise the frame state machine
 * against a mock adapter.
 */
export class BlankLoadingAnimator {
  private readonly _active = new Map<number, ActiveSlot>();
  /** Per-slot set of owner IDs. The slot stops animating only when
   *  this set becomes empty. */
  private readonly _owners = new Map<number, Set<string>>();
  private _timer: ReturnType<typeof setInterval> | null = null;
  private readonly _frameIntervalMsFn: () => number;
  private readonly _modeFn: () => BlankLoadingMode;
  private readonly _customFramesFn: () => readonly string[] | null;
  private readonly _rgbColorsFn: () => readonly string[] | null;
  private readonly _ansiColorsFn: () => readonly string[] | null;
  private readonly _adapter: HostAdapter;
  private readonly _log: (msg: string) => void;

  constructor(opts: BlankLoadingOptions) {
    this._frameIntervalMsFn = opts.frameIntervalMs ?? (() => 150);
    this._modeFn = opts.mode;
    this._customFramesFn = opts.customFrames ?? (() => null);
    this._rgbColorsFn = opts.rgbColors ?? (() => null);
    this._ansiColorsFn = opts.ansiColors ?? (() => null);
    this._adapter = opts.adapter;
    this._log = opts.log ?? (() => { /* noop */ });
  }

  /** Colour for the active slot's CURRENT frame in the requested
   *  representation. Returns null when the slot isn't animating, or when
   *  the configured colour list is empty/invalid (caller should render
   *  with no colour override — the existing default). Per-frame: looks
   *  up colour[frameIdx] modulo loopStartIdx mapping; falls back to null
   *  for frames past the array end. */
  getActiveColor(wordIndex: number, prefer: 'rgb' | 'ansi'): string | null {
    const slot = this._active.get(wordIndex);
    if (!slot) return null;
    const list = prefer === 'rgb' ? this._rgbColorsFn() : this._ansiColorsFn();
    if (!list || list.length === 0) return null;
    // frameIdx walks 0..frames.length-1. Map to colours[frameIdx % colours.length].
    return list[slot.frameIdx % list.length] ?? null;
  }

  /** All currently-animating slots with their CHAR ranges in `text` +
   *  the active colour. Hosts call this from their render path to wrap
   *  the loading char in colour (ANSI for terminals, CSS for chrome).
   *  Returns [] when nothing is animating or no colour is configured. */
  getActiveColoredRanges(text: string, prefer: 'rgb' | 'ansi'): Array<{ start: number; end: number; color: string; wordIndex: number }> {
    if (this._active.size === 0) return [];
    const list = prefer === 'rgb' ? this._rgbColorsFn() : this._ansiColorsFn();
    if (!list || list.length === 0) return [];
    const cleaned = text.replace(/[\u200B\u200C]/g, '');
    const out: Array<{ start: number; end: number; color: string; wordIndex: number }> = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(cleaned)) !== null) {
      const slot = this._active.get(idx);
      if (slot) {
        const color = list[slot.frameIdx % list.length];
        if (color) out.push({ start: m.index, end: m.index + m[0].length, color, wordIndex: idx });
      }
      idx++;
    }
    return out;
  }

  /** True when at least one slot is animating. Exposed for tests + diagnostics. */
  get active(): boolean { return this._active.size > 0; }

  /** Slots currently animating, keyed by word index. Read-only view. */
  get activeSlots(): ReadonlyMap<number, { wordIndex: number; frameIdx: number; frames: readonly string[] }> {
    return this._active;
  }

  /**
   * Begin animating the `_` at the given word index. Honours the
   * current mode — if `off`, this is a no-op. The `owner` identifies
   * which module is claiming the slot; the slot keeps animating until
   * EVERY owner that called `start` has called `stop`. A second start
   * from the SAME owner on an already-active slot is a no-op (avoids
   * double-claim on dedup retries).
   */
  start(wordIndex: number, owner: string = 'default'): void {
    const mode = this._modeFn();
    const customFrames = mode === 'custom' ? this._customFramesFn() : null;
    const frames = framesFor(mode, customFrames);
    if (frames.length === 0) return;          // mode === 'off'
    let owners = this._owners.get(wordIndex);
    if (owners === undefined) {
      owners = new Set();
      this._owners.set(wordIndex, owners);
    }
    if (owners.has(owner)) return;
    owners.add(owner);
    if (this._active.has(wordIndex)) return;  // already animating for another owner
    const customFramesPresent = mode === 'custom' && customFrames !== null && customFrames.length > 0;
    this._active.set(wordIndex, {
      wordIndex,
      frames,
      loopStartIdx: loopStartIdxFor(mode, customFramesPresent),
      frameIdx: 0,
    });
    const modeTag = mode === 'custom'
      ? (customFramesPresent ? 'custom' : 'custom→braille-rotate (fallback)')
      : mode;
    const framesPreview = frames.map(f => JSON.stringify(f)).join(',');
    this._log(`BlankLoading: start wordIndex=${wordIndex} owner=${owner} mode=${modeTag} frames=[${framesPreview}]`);
    if (this._timer === null) {
      this._timer = setInterval(() => this._tick(), this._frameIntervalMsFn());
    }
  }

  /**
   * Release this owner's claim on the slot. The slot actually stops
   * (timer drops, `_` restored) only when the LAST owner releases.
   * Idempotent: stopping with an unknown owner / unknown slot is a
   * no-op. Restore is best-effort — if the slot's current char isn't
   * one of our frame characters (user typed over it, substitution
   * already ran), restore is skipped.
   */
  stop(wordIndex: number, owner: string = 'default'): void {
    const owners = this._owners.get(wordIndex);
    if (owners === undefined) return;
    if (!owners.delete(owner)) return;
    if (owners.size > 0) return;              // other owners still animating
    this._owners.delete(wordIndex);
    const slot = this._active.get(wordIndex);
    if (!slot) return;
    this._active.delete(wordIndex);
    this._restoreUnderscore(wordIndex, slot.frames);
    this._log(`BlankLoading: stop wordIndex=${wordIndex} owner=${owner}`);
    if (this._active.size === 0 && this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Drop every active slot. With an `owner`, releases only that
   * owner's claims (other owners may keep slots alive). Without one,
   * forcibly drops every slot regardless of owner — used on adapter
   * teardown / explicit reset.
   */
  stopAll(owner?: string): void {
    if (owner === undefined) {
      this._owners.clear();
      for (const idx of [...this._active.keys()]) {
        const slot = this._active.get(idx);
        if (!slot) continue;
        this._active.delete(idx);
        this._restoreUnderscore(idx, slot.frames);
      }
      if (this._timer !== null) {
        clearInterval(this._timer);
        this._timer = null;
      }
      return;
    }
    for (const idx of [...this._owners.keys()]) this.stop(idx, owner);
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private _tick(): void {
    if (this._active.size === 0) return;      // raced with stopAll; the
                                              // outer setInterval will tidy up.
    for (const slot of [...this._active.values()]) {
      const word = this._wordAt(slot.wordIndex);
      if (word === null) { this._dropQuiet(slot.wordIndex); continue; }
      // If the slot's char isn't one of THIS slot's frames or `_`,
      // somebody wrote over it (user typing, substitution path).
      // Drop silently — substitution will splice the answer when
      // ready. Per-slot frames so user-supplied custom characters
      // are also recognised (not just the built-in BOUNCE/BRAILLE
      // sets covered by ALL_FRAME_CHARS).
      if (!slot.frames.includes(word) && word !== '_') {
        this._dropQuiet(slot.wordIndex); continue;
      }
      // Advance frame and write. Wrap to loopStartIdx (not 0) so the
      // intro prefix plays only once. For modes without an intro
      // (loopStartIdx === 0) this behaves identically to the simple
      // modulo loop.
      const nextIdx = slot.frameIdx + 1;
      slot.frameIdx = nextIdx >= slot.frames.length ? slot.loopStartIdx : nextIdx;
      const nextChar = slot.frames[slot.frameIdx];
      if (nextChar === word) continue;        // unlikely (same-frame edge); no-op
      this._writeChar(slot.wordIndex, nextChar);
    }
  }

  /** Replace the word at wordIndex with `_`. Used on stop().
   *  Takes the slot's frames so custom-character animations restore
   *  correctly — without the per-slot set we'd refuse to restore any
   *  custom char and the loading glyph would stick. */
  private _restoreUnderscore(wordIndex: number, slotFrames: readonly string[]): void {
    const word = this._wordAt(wordIndex);
    if (word === null) return;
    if (!slotFrames.includes(word) && word !== '_') return;   // user / substitution took over
    if (word === '_') return;                 // already `_`
    this._writeChar(wordIndex, '_');
  }

  /** Word-aware splice: replace the word at wordIndex with `next`.
   *  Reads current text fresh on every call. */
  private _writeChar(wordIndex: number, next: string): void {
    const text = this._adapter.getText();
    const cleaned = text.replace(/[\u200B\u200C]/g, '');
    // Whitespace tokenisation matches blank-fill's splitWords logic
    // (sites/positions in the buffer derived from splitting on \s+).
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(cleaned)) !== null) {
      if (idx === wordIndex) {
        const before = cleaned.slice(0, m.index);
        const after = cleaned.slice(m.index + m[0].length);
        this._adapter.setText(before + next + after);
        // Without this, async timer-driven setText only buffers pendingText
        // on hosts that consume it via keystroke dispatch (CC 2.1.x). The
        // adapter's forceRender pushes the buffered text actively when not
        // inside a dispatch, letting the spinner actually animate. Optional-
        // chained for test mocks that don't implement forceRender.
        this._adapter.forceRender?.();
        return;
      }
      idx++;
    }
  }

  private _wordAt(wordIndex: number): string | null {
    const text = this._adapter.getText();
    const cleaned = text.replace(/[\u200B\u200C]/g, '');
    const words = cleaned.match(/\S+/g);
    if (!words || wordIndex >= words.length) return null;
    return words[wordIndex];
  }

  private _dropQuiet(wordIndex: number): void {
    this._active.delete(wordIndex);
    this._owners.delete(wordIndex);
    if (this._active.size === 0 && this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

/** Map an ANSI colour token (named, bright_*, or 0-255 index) to an
 *  open foreground escape. Returns null for unknown tokens — callers
 *  fall back to no-colour rendering. Close code is always `\x1b[39m`
 *  (default fg). */
export function ansiColorToOpenEscape(token: string): string | null {
  const named: Record<string, string> = {
    black: '\x1b[30m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
    bright_black: '\x1b[90m', bright_red: '\x1b[91m', bright_green: '\x1b[92m',
    bright_yellow: '\x1b[93m', bright_blue: '\x1b[94m', bright_magenta: '\x1b[95m',
    bright_cyan: '\x1b[96m', bright_white: '\x1b[97m',
  };
  if (named[token]) return named[token];
  // 256-colour index
  if (/^\d{1,3}$/.test(token)) {
    const n = Number(token);
    if (n >= 0 && n <= 255) return `\x1b[38;5;${n}m`;
  }
  return null;
}

/** Close-foreground escape — companion to `ansiColorToOpenEscape`. */
export const ANSI_FG_RESET = '\x1b[39m';
