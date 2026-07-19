/**
 * AdvisoryState — the fluid ADVISORY channel, distinct from the exclusive
 * cycle-cue span system (DynDefs). An advisory is a passive, non-cycleable
 * annotation the runtime surfaces on the statusline ALONGSIDE whatever cue
 * owns the cursor's span — it never claims a DynDef, never evicts, never
 * participates in Ctrl+Alt cycling. Contradiction cues are the first tenant.
 *
 * DERIVED, NOT STORED: the resolver rebuilds the whole advisory set on every
 * resolve pass (`setAll`, including the empty set), so an advisory self-clears
 * the moment its condition no longer holds — the user fixes the text, cycles
 * the underlying cue to a clean variant, or accepts the offered correction.
 * There is no per-advisory lifecycle to garbage-collect. (An explicit
 * acknowledge-and-ignore dismiss is a separate, later concern.)
 *
 * PURE STATE — no adapter, no IO. The resolver writes via `setAll`; the
 * statusline reads via `all` / `atCursor`. Surfacing mirrors the kata block:
 * orthogonal to highlight state, merged in `Statusline.maybeWrite`.
 */

export interface Advisory {
  /** Char span [start, end) of the flagged text in the current buffer. */
  readonly spanStart: number;
  readonly spanEnd: number;
  /** One-line message shown on the statusline (already glyph-prefixed by the
   *  source, e.g. "⚠ 250 ÷ 4 = $62.50, not $55"). */
  readonly message: string;
  /** Source id that raised it (e.g. "sentence-cue:contradiction-split-bill") —
   *  for dedupe, dismiss-keying, and event traces. */
  readonly source: string;
  /** Optional corrected text the source offers, distinct from the flagged
   *  span's current content. Absent when the advisory is informational only. */
  readonly correction?: string;
}

export class AdvisoryState {
  private _advisories: readonly Advisory[] = [];

  /** Replace the whole advisory set (the resolver calls this once per resolve
   *  pass — an empty array clears stale advisories, which is the self-clear). */
  setAll(advisories: readonly Advisory[]): void {
    this._advisories = advisories;
  }

  /** Every current advisory, in the order the resolver emitted them. */
  all(): readonly Advisory[] {
    return this._advisories;
  }

  /** The advisory whose span contains `charOffset` (the cursor), or null. When
   *  several overlap, the first (highest-priority — the resolver emits in
   *  priority order) wins. */
  atCursor(charOffset: number): Advisory | null {
    for (const a of this._advisories) {
      if (charOffset >= a.spanStart && charOffset < a.spanEnd) return a;
    }
    return null;
  }

  get size(): number {
    return this._advisories.length;
  }

  clear(): void {
    this._advisories = [];
  }
}
