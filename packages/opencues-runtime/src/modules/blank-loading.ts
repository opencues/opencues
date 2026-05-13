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

export type BlankLoadingMode = 'bounce' | 'braille-rotate' | 'off';

export const BOUNCE_FRAMES: readonly string[] = ['_', '-', '‾', '-'];

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

export function framesFor(mode: BlankLoadingMode): readonly string[] {
  if (mode === 'bounce') return BOUNCE_FRAMES;
  if (mode === 'braille-rotate') return BRAILLE_ROTATE_FRAMES;
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
export function loopStartIdxFor(mode: BlankLoadingMode): number {
  if (mode === 'braille-rotate') return 1;
  return 0;
}

/** Every character that may legitimately occupy a loading slot. The
 *  animator uses this set to detect "should I keep animating" — if a
 *  tick reads the slot and finds a character outside this set, it
 *  means the user typed over it OR the substitution path already
 *  replaced it. In either case the animator drops the slot. */
export const ALL_FRAME_CHARS: ReadonlySet<string> = new Set([
  ...BOUNCE_FRAMES, ...BRAILLE_ROTATE_FRAMES,
]);

export interface BlankLoadingOptions {
  /** ms between frame swaps. Default 150 — readable in terminals, gentle
   *  on chrome's contenteditable reconcilers. */
  readonly frameIntervalMs?: number;
  /** Currently active mode. The animator reads this lazily on every
   *  start() so callers can hot-flip via OPENCUES.md without recreating
   *  the instance. */
  readonly mode: () => BlankLoadingMode;
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
 *   start(wordIndex)  — claim a slot and begin animating.
 *   stop(wordIndex)   — release a slot and snap back to `_`.
 *   stopAll()         — release every active slot (used on adapter teardown).
 *
 * Tests in `blank-loading.test.ts` exercise the frame state machine
 * against a mock adapter.
 */
export class BlankLoadingAnimator {
  private readonly _active = new Map<number, ActiveSlot>();
  private _timer: ReturnType<typeof setInterval> | null = null;
  private readonly _frameIntervalMs: number;
  private readonly _modeFn: () => BlankLoadingMode;
  private readonly _adapter: HostAdapter;
  private readonly _log: (msg: string) => void;

  constructor(opts: BlankLoadingOptions) {
    this._frameIntervalMs = opts.frameIntervalMs ?? 150;
    this._modeFn = opts.mode;
    this._adapter = opts.adapter;
    this._log = opts.log ?? (() => { /* noop */ });
  }

  /** True when at least one slot is animating. Exposed for tests + diagnostics. */
  get active(): boolean { return this._active.size > 0; }

  /** Slots currently animating, keyed by word index. Read-only view. */
  get activeSlots(): ReadonlyMap<number, { wordIndex: number; frameIdx: number; frames: readonly string[] }> {
    return this._active;
  }

  /**
   * Begin animating the `_` at the given word index. Honours the
   * current mode — if `off`, this is a no-op. If already animating
   * the same wordIndex, it's a no-op (avoids double-claim race
   * between BlankFill's dedup and a stale call).
   */
  start(wordIndex: number): void {
    const mode = this._modeFn();
    const frames = framesFor(mode);
    if (frames.length === 0) return;          // mode === 'off'
    if (this._active.has(wordIndex)) return;
    this._active.set(wordIndex, {
      wordIndex,
      frames,
      loopStartIdx: loopStartIdxFor(mode),
      frameIdx: 0,
    });
    this._log(`BlankLoading: start wordIndex=${wordIndex} mode=${mode}`);
    if (this._timer === null) {
      this._timer = setInterval(() => this._tick(), this._frameIntervalMs);
    }
  }

  /**
   * Stop animating the slot and restore its character to `_`. Idempotent.
   * The restore is best-effort: if the slot's current char isn't one of
   * our frame characters (user typed over it, substitution already ran),
   * the restore is skipped — we don't want to overwrite real content.
   */
  stop(wordIndex: number): void {
    if (!this._active.has(wordIndex)) return;
    this._active.delete(wordIndex);
    this._restoreUnderscore(wordIndex);
    this._log(`BlankLoading: stop wordIndex=${wordIndex}`);
    if (this._active.size === 0 && this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Drop every active slot. Used on adapter teardown / explicit reset. */
  stopAll(): void {
    for (const idx of [...this._active.keys()]) this.stop(idx);
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private _tick(): void {
    if (this._active.size === 0) return;      // raced with stopAll; the
                                              // outer setInterval will tidy up.
    for (const slot of [...this._active.values()]) {
      const word = this._wordAt(slot.wordIndex);
      if (word === null) { this._dropQuiet(slot.wordIndex); continue; }
      // If the slot's char isn't one of our frame chars, somebody
      // wrote over it (user typing, substitution path). Drop silently
      // — substitution will splice the answer when ready.
      if (!ALL_FRAME_CHARS.has(word)) { this._dropQuiet(slot.wordIndex); continue; }
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

  /** Replace the word at wordIndex with `_`. Used on stop(). */
  private _restoreUnderscore(wordIndex: number): void {
    const word = this._wordAt(wordIndex);
    if (word === null) return;
    if (!ALL_FRAME_CHARS.has(word)) return;   // user / substitution took over
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
    if (this._active.size === 0 && this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
