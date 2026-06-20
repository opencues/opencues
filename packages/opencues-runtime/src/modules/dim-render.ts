// DimRender — computes RenderDirectives on every onRender event.
//
// Two visual layers:
//   1. Dim ranges for every word that's a known cue or blank
//      match — visual hint that the word is navigable.
//   2. Highlight range over the actively-selected word (overrides the dim).
//
// The host renders dim and highlight via applyDirectives in the bootstrap.

import type { HostAdapter, Range, RenderContext, RenderDirectives, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import type { DynDefs } from '../state/dyn-defs';
import type { ConfigLoader } from './config-loader';
import type { SpanFillState } from '../state/span-fill';
import type { SelectorSatelliteState } from '../state/selector-satellite';
import { splitWords } from './navigation';

/**
 * Sentence-cue defs are the only ones whose stored char span (spanStart/
 * spanEnd) should override the word-derived highlight/dim range. They're
 * passive (no splice) and re-resolved on edit, so their span stays current
 * — and it's the only correct range for spaceless / mixed CJK where
 * whitespace-words don't align with sentence boundaries. Normal blanks
 * (fluid-blank / transform-blank) actively relocate; their stored span can
 * go stale, so those keep the live word-derived range. blankName is set to
 * the source id (`sentence-cue:<name>`) at registration.
 */
function isSentenceCueDef(def: { blankName?: string }): boolean {
  return typeof def.blankName === 'string' && def.blankName.startsWith('sentence-cue:');
}

export class DimRender {
  private _unsub: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    private configLoader?: ConfigLoader,
    private spanFillState?: SpanFillState,
    private selectorSatelliteState?: SelectorSatelliteState,
  ) {}

  subscribe(): void {
    this._unsub = this.adapter.onRender(ctx => this.compute(ctx));
  }

  unsubscribe(): void {
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  /**
   * Pure: takes a render context, returns directives or null.
   * Exposed for unit testing without the subscribe pipeline.
   */
  compute(ctx: RenderContext): RenderDirectives | null {
    const hasHighlightCap = this.adapter.capabilities.includes('highlight-range');
    const hasDimCap = this.adapter.capabilities.includes('dim-ranges');

    // DynDef char spans + word indices live in LOGICAL buffer coordinates —
    // the space the resolver computes them in (from adapter text-change
    // events). Some hosts hand onRender a SOFT-WRAPPED text: Claude Code
    // inserts newlines at terminal width, which splits a long CJK word and
    // shifts every later word index. Splitting on that wrapped text then
    // mis-attributes a sentence-cue def (e.g. logical word 14 = "HTTPS") to
    // the wrong word, so its dim/highlight silently vanishes for any
    // paragraph past the first wrap point (live CJK bug).
    //
    // BUT ctx.text is also the authoritative "what's being rendered NOW"
    // during runtime-driven text changes (a cycle replaces a word; the
    // adapter's buffer can briefly lag). So only prefer the adapter's
    // logical buffer when it's the SAME logical content as ctx.text —
    // i.e. the host merely re-wrapped it (identical once whitespace + ZWS
    // are stripped). A genuine edit differs in content → trust ctx.text.
    const stripLayout = (s: string): string => s.replace(/[\s\u200B\u200C]/g, '');
    const logicalText = this.adapter.getText();
    const sameContent = logicalText.length > 0
      && stripLayout(logicalText) === stripLayout(ctx.text);
    const text = sameContent ? logicalText : ctx.text;
    const words = splitWords(text);

    // Dim ranges: every cue or blank word that is NOT the
    // currently-highlighted one AND not inside an active span/satellite
    // (those get whole-region highlight; individual cue dim there would
    // appear as random word-fading inside an otherwise bright unit).
    const dimRanges: Range[] = [];
    const activeIndex = this.hlState.active ? this.hlState.wordIndex : null;
    const span = this.spanFillState?.current ?? null;
    const spanLen = span ? Math.max(1, span.spanLength) : 0;
    const ss = this.selectorSatelliteState?.current ?? null;
    const ssSelEnd = ss ? ss.selectorIndex + Math.max(1, ss.selectorLength) - 1 : 0;
    const ssSatEnd = ss ? ss.satelliteIndex + Math.max(1, ss.satelliteLength) - 1 : 0;
    const activeInSpanRegion = span !== null && activeIndex !== null
      && activeIndex >= span.index && activeIndex < span.index + spanLen;
    const activeInSelector = ss !== null && activeIndex !== null
      && activeIndex >= ss.selectorIndex && activeIndex <= ssSelEnd;
    const activeInSatellite = ss !== null && activeIndex !== null
      && activeIndex >= ss.satelliteIndex && activeIndex <= ssSatEnd;
    const isInsideActiveBlock = (i: number): boolean => {
      if (activeInSpanRegion && span && i >= span.index && i < span.index + spanLen) return true;
      if (activeInSelector && ss && i >= ss.selectorIndex && i <= ssSelEnd) return true;
      if (activeInSatellite && ss && i >= ss.satelliteIndex && i <= ssSatEnd) return true;
      return false;
    };
    // Used by both the dim loop AND the highlight expansion below —
    // declared at outer scope so the highlight branch can reach it.
    const activeStaticAltSpan = activeIndex !== null && activeIndex >= 0
      ? this.dynDefs.findSpanContaining(activeIndex, words)
      : null;
    if (hasDimCap && this.configLoader) {
      const navigable = this.configLoader.navigableWords;
      const seenStaticAltSpans = new Set<number>();
      for (const w of words) {
        if (w.index === activeIndex) continue;
        if (isInsideActiveBlock(w.index)) continue;

        // Multi-word static-alt span handling. Each origin emits ONE
        // group dim range covering all N words. Inner positions are
        // skipped (the origin's range covers them). The span the
        // active highlight is inside (if any) is also skipped — the
        // highlight layer paints it.
        const span = this.dynDefs.findSpanContaining(w.index, words);
        if (span) {
          if (span.originIdx !== w.index) continue;
          if (seenStaticAltSpans.has(span.originIdx)) continue;
          seenStaticAltSpans.add(span.originIdx);
          if (activeStaticAltSpan && activeStaticAltSpan.originIdx === span.originIdx) continue;
          // Char span over word-derived range — but ONLY for sentence-cues
          // (see the highlight branch below). Sentence-cues are passive and
          // re-resolved on edit, so their stored span stays current; normal
          // blanks (fluid/transform) actively relocate and their stored
          // spanStart/spanEnd can go STALE, so for those we keep the
          // word-derived range that's recomputed from the live words each
          // render (the pre-CJK-fix behaviour).
          if (isSentenceCueDef(span.def) && span.def.spanEnd > span.def.spanStart) {
            dimRanges.push({ start: span.def.spanStart, end: span.def.spanEnd });
          } else {
            const endWord = words[span.originIdx + span.spanLength - 1];
            if (endWord) dimRanges.push({ start: w.start, end: endWord.end });
          }
          continue;
        }

        const lc = w.word.toLowerCase().replace(/[\u200B\u200C]/g, '');
        if (lc.length === 0) continue;
        // DynDefs entries (LLM-resolved alts) also count as
        // navigable, so they should dim too.
        if (
          navigable.has(lc) ||
          this.dynDefs.get(w.index)
        ) {
          // Blank-keyword arm: a word that is ONLY a blank keyword
          // (not a word-cue match, not a registered tip in cueMap)
          // shouldn't dim until a `_` is in proximity. Without the
          // gate, every prose mention of `volume` / `bitcoin` /
          // `apple` / `weather` etc. paints a phantom dim that
          // suggests "I'm interactive" \u2014 but the action only fires
          // when `_` lands adjacent. Words that are ALSO word-cue
          // entries (legal/medical/financial when host-enabled, any
          // CUES.md ## Tips entry) keep the unconditional dim
          // because those genuinely offer prose alternatives the
          // user can cycle \u2014 the dim is the affordance.
          if (this.shouldGateBlankKeywordDim(lc, w.index, words)) continue;
          dimRanges.push({ start: w.start, end: w.end });
        }
      }
    }

    // When a span fill is active, treat the whole
    // span as one block. If the active highlight isn't inside it, dim
    // the whole span. If it IS inside, the highlight (below) covers it
    // and we skip the dim layer (avoid stacking attributes).
    if (hasDimCap && span && !activeInSpanRegion) {
      const startWord = words[span.index];
      const endWord = words[span.index + spanLen - 1];
      if (startWord && endWord) {
        dimRanges.push({ start: startWord.start, end: endWord.end });
      }
    }

    // Selector + satellite dim. Both sides can be multi-word
    // ("display mode" / "plain text"). Each side gets its own dim layer.
    if (hasDimCap && ss) {
      const ss0 = words[ss.selectorIndex];
      const ss1 = words[ssSelEnd];
      const ts = words[ss.satelliteIndex];
      const te = words[ssSatEnd];
      if (ss0 && ss1 && !activeInSelector) dimRanges.push({ start: ss0.start, end: ss1.end });
      if (ts && te && !activeInSatellite) dimRanges.push({ start: ts.start, end: te.end });
    }

    // Highlight: the active word (overlaid). When the active word is
    // inside a span fill OR a multi-word satellite OR a multi-word
    // static-alt span, expand the highlight to cover the whole unit
    // — that's how the user sees a multi-word value as one cycleable
    // thing.
    let highlight: { start: number; end: number } | undefined;
    if (hasHighlightCap && this.hlState.active && this.hlState.wordIndex !== null) {
      if (activeInSpanRegion && span) {
        const startWord = words[span.index];
        const endWord = words[span.index + spanLen - 1];
        if (startWord && endWord) {
          highlight = { start: startWord.start, end: endWord.end };
        }
      } else if (activeStaticAltSpan) {
        // Prefer the def's CHAR span over word-derived boundaries. With
        // mixed CJK+Latin text a whitespace-word can STRADDLE a 。 sentence
        // boundary (no space after the stop), e.g. "…します。同一サイト…" is
        // one word spanning two sentences — so words[origin]…words[end]
        // over/under-covers the actual sentence. The def's spanStart/spanEnd
        // is the true range. For space-delimited text they're equal.
        const def = activeStaticAltSpan.def;
        if (isSentenceCueDef(def) && def.spanEnd > def.spanStart) {
          highlight = { start: def.spanStart, end: def.spanEnd };
        } else {
          const startWord = words[activeStaticAltSpan.originIdx];
          const endWord = words[activeStaticAltSpan.originIdx + activeStaticAltSpan.spanLength - 1];
          if (startWord && endWord) {
            highlight = { start: startWord.start, end: endWord.end };
          }
        }
      } else if (activeInSelector && ss) {
        const s0 = words[ss.selectorIndex];
        const s1 = words[ssSelEnd];
        if (s0 && s1) highlight = { start: s0.start, end: s1.end };
      } else if (activeInSatellite && ss) {
        const ts = words[ss.satelliteIndex];
        const te = words[ssSatEnd];
        if (ts && te) {
          highlight = { start: ts.start, end: te.end };
        }
      } else {
        const target = words[this.hlState.wordIndex];
        // A span-bound def (e.g. a sentence-cue) carries an explicit CHAR
        // span. In spaceless CJK the whole buffer is ONE whitespace-word,
        // so `findSpanContaining` (which keys off word count) doesn't see
        // the def as a span and we land here — but highlighting the whole
        // word would cover the entire buffer instead of the def's actual
        // span (e.g. one sentence inside a two-sentence Japanese buffer).
        // When the def's char span is narrower than the word, honour it.
        const def = this.dynDefs.get(this.hlState.wordIndex);
        if (def && isSentenceCueDef(def) && def.spanEnd > def.spanStart && target
          && (def.spanStart > target.start || def.spanEnd < target.end)) {
          highlight = { start: def.spanStart, end: def.spanEnd };
        } else if (target) {
          highlight = { start: target.start, end: target.end };
        }
      }
    }

    if (!highlight && dimRanges.length === 0) return null;
    return { highlight, dimRanges };
  }

  /**
   * Returns true when the dim for this word should be SUPPRESSED because
   * it's a pure blank keyword (an action trigger that needs `_` to fire)
   * and no `_` is in proximity. Words that are ALSO word-cue entries
   * (live in `configLoader.cueMap`) bypass the gate and dim
   * unconditionally — those offer real prose alternatives.
   *
   * See `docs/architecture/spans-and-cycling.md` § "Dim contract" for
   * the rationale.
   */
  private shouldGateBlankKeywordDim(
    lc: string,
    wordIdx: number,
    words: readonly { word: string }[],
  ): boolean {
    if (!this.configLoader) return false;
    // Word-cue entries (CUES.md ## Tips, folder cues, spelling) keep
    // the unconditional dim — their dim IS the offer that the user
    // can cycle them.
    if (this.configLoader.cueMap.has(lc)) return false;
    const entry = this.configLoader.blanksByWord.get(lc);
    if (!entry) return false;
    // The word resolved to a blank keyword. Check if any `_` is within
    // proximity. blankProximity defaults to 0 (keyword must be
    // directly adjacent to `_`); blanks with looser phrasing set it
    // explicitly (e.g. volume = 3, dictionary = 20).
    const proximity = entry.blank.blankProximity ?? 0;
    const lower = wordIdx - proximity - 1;
    const upper = wordIdx + proximity + 1;
    const start = Math.max(0, lower);
    const end = Math.min(words.length - 1, upper);
    for (let i = start; i <= end; i++) {
      if (i === wordIdx) continue;
      const w = words[i]?.word;
      if (w === '_' || w?.replace(/[​‌]/g, '') === '_') return false;
    }
    return true;
  }
}
