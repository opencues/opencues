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

export type BlankLoadingMode = 'bounce' | 'dot-walk' | 'off';

export const BOUNCE_FRAMES: readonly string[] = ['_', '-', '‾', '-'];
export const DOT_WALK_FRAMES: readonly string[] = ['_', '.', '·', '.'];

export function framesFor(mode: BlankLoadingMode): readonly string[] {
  if (mode === 'bounce') return BOUNCE_FRAMES;
  if (mode === 'dot-walk') return DOT_WALK_FRAMES;
  return [];
}

/** Every character that may legitimately occupy a loading slot. The
 *  animator uses this set to detect "should I keep animating" — if a
 *  tick reads the slot and finds a character outside this set, it
 *  means the user typed over it OR the substitution path already
 *  replaced it. In either case the animator drops the slot. */
export const ALL_FRAME_CHARS: ReadonlySet<string> = new Set([
  ...BOUNCE_FRAMES, ...DOT_WALK_FRAMES,
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
  /** Index into `frames`. Starts at 0 (= `_`), ticks bump it. */
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
    this._active.set(wordIndex, { wordIndex, frames, frameIdx: 0 });
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
      // Advance frame and write.
      slot.frameIdx = (slot.frameIdx + 1) % slot.frames.length;
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
