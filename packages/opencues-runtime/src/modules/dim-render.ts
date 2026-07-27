// DimRender — computes RenderDirectives on every onRender event.
//
// Two visual layers:
//   1. Dim ranges for every word that's a known cue or blank
//      match — visual hint that the word is navigable.
//   2. Highlight range over the actively-selected word (overrides the dim).
//
// The host renders dim and highlight via applyDirectives in the bootstrap.

import type { HostAdapter, InlineNote, Range, RenderContext, RenderDirectives, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import type { DynDefs, WordDef } from '../state/dyn-defs';
import type { ConfigLoader } from './config-loader';
import type { SpanFillState } from '../state/span-fill';
import type { SelectorSatelliteState } from '../state/selector-satellite';
import { splitWords } from './navigation';
import { buildIndexMap } from './coord-map';


/**
 * Race-guard for a def's stored char span. A span-bound def (sentence-cue OR a
 * blank substitute — fluid/transform — OR a multi-word static-alt) keeps
 * `alternatives[currentIndex]` in the buffer at [spanStart, spanEnd). When that
 * still holds in the LIVE buffer, the char span is the AUTHORITATIVE range to
 * dim/highlight — it's immune to the word-count fragility that breaks CJK
 * coverage (a spaceless/mixed Japanese substitute has fewer whitespace-words
 * than its char length, and CC soft-wrap / viewport-truncated ctx.text shift
 * the word count further, so the word-derived range under-covers the tail —
 * "not all the translated text is dimmed").
 *
 * When it does NOT hold — the user edited/replaced the buffer and the def
 * hasn't been cleared yet (clearing is async) — the stored span is STALE and
 * must NOT be used, or it paints over whatever new text now sits at those
 * offsets (the "dim catches the words I'm typing" / #181 "normal blanks catch
 * future text" bugs). The caller then falls back to the live word-derived
 * range. Verifying every render makes the visual layer self-correcting without
 * waiting on re-resolve / pruneStale.
 */
function defSpanLive(def: WordDef, text: string): boolean {
  if (def.spanEnd <= def.spanStart || def.spanEnd > text.length) return false;
  const expected = def.alternatives[def.currentIndex];
  return typeof expected === 'string' && text.slice(def.spanStart, def.spanEnd) === expected;
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
    const stripZws = (s: string): string => s.replace(/[\u200B\u200C]/g, '');
    // THREE coordinate spaces are in play:
    //   1. adapter.getText() \u2014 the logical buffer + the spinner's ZWS
    //      render-kick. The resolver computes DynDef char spans here, but
    //      against the ZWS-STRIPPED form (spans are content-coords).
    //   2. ctx.text \u2014 what the host PAINTS: content + host soft-wrap `\n`
    //      (Claude Code), and NO ZWS.
    //   3. content \u2014 neither layout artifact.
    // Compute against CONTENT (ZWS-stripped adapter text) so def spans + word
    // logic line up, then map content\u2192ctx.text (a clean superset: content plus
    // the host's wrap inserts) so the painted ranges match. Using the raw
    // adapter text as the base failed because its ZWS is an insert ctx lacks
    // AND ctx's wrap `\n` is an insert the adapter lacks \u2014 neither is a clean
    // subsequence of the other, so the map diverged and silently dropped the
    // wrap shift (the "N paragraphs \u2192 N-1 misaligned chars" drift).
    const contentText = stripZws(this.adapter.getText());
    const sameContent = contentText.length > 0
      && stripLayout(contentText) === stripLayout(ctx.text);
    const text = sameContent ? contentText : ctx.text;
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
      // No-cycling profile (universal-integration.md): a cueMap dim IS
      // the offer that the word can be cycled — on a field whose adapter
      // reports supportsCycling() === false that offer is false
      // advertising, so cueMap-derived dims are suppressed. This is the
      // same path-2 class the doc records for BlankFill: the source-build
      // prune never covered the cueMap/tips path, which the windows
      // per-field profile made visible (phase-2 wire e2e journey D).
      // Consulted per render pass — supportsCycling is DYNAMIC on hosts
      // with per-field capability (windows). DynDef-derived dims
      // (substitution spans) are unaffected.
      const cyclingOff = this.adapter.supportsCycling?.() === false;
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
          // Prefer the def's CHAR span over the word-derived range whenever
          // it still matches the live buffer (`defSpanLive`). The char span is
          // the true extent of a substitute/cue — the word-count-derived range
          // under-covers CJK (a spaceless/mixed Japanese substitute has fewer
          // whitespace-words than chars, and wrap/truncation shifts the count),
          // so a translated span would dim only partially. The race-guard means
          // a STALE span (user edited, def not yet cleared) falls back to the
          // live word-derived range instead of painting over new text (#181).
          if (span.def.spanEnd > span.def.spanStart) {
            // Def carries a char span. Use it when it still matches the live
            // buffer (the authoritative full extent — fixes partial CJK dim).
            // When it's STALE (user edited, def not yet cleared) SKIP — do not
            // fall back to the word-derived range, which would paint the whole
            // new (often shorter) buffer (#181 "blanks catch future text" +
            // the "dim catches what I'm typing" regression).
            if (defSpanLive(span.def, text)) {
              dimRanges.push({ start: span.def.spanStart, end: span.def.spanEnd });
            }
          } else {
            // No char span (e.g. a plain word-cue) — derive from live words.
            const endWord = words[span.originIdx + span.spanLength - 1];
            if (endWord) dimRanges.push({ start: w.start, end: endWord.end });
          }
          continue;
        }

        const lc = w.word.toLowerCase().replace(/[\u200B\u200C]/g, '');
        if (lc.length === 0) continue;
        const defAtIdx = this.dynDefs.get(w.index);
        // A MANAGED def (blankName) with a char span landing here means
        // `findSpanContaining` didn't recognise it as a multi-word span \u2014 the
        // spaceless-CJK case where the whole substitute is ONE whitespace-word
        // (e.g. a transform-blank's Japanese output). Dim its authoritative
        // char span when it still matches the live buffer; when STALE (a
        // leftover def from a prior buffer) SKIP \u2014 don't dim the new word that
        // now sits at this index ("dim leaks onto the new text" / stale-def
        // paint-over).
        if (defAtIdx && typeof defAtIdx.blankName === 'string'
          && typeof defAtIdx.spanStart === 'number' && typeof defAtIdx.spanEnd === 'number'
          && defAtIdx.spanEnd > defAtIdx.spanStart) {
          if (defSpanLive(defAtIdx, text)) {
            dimRanges.push({ start: defAtIdx.spanStart, end: defAtIdx.spanEnd });
          }
          continue;
        }
        // DynDefs entries (LLM-resolved alts) also count as
        // navigable, so they should dim too.
        if (
          (!cyclingOff && navigable.has(lc)) ||
          defAtIdx
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

      // Dedicated sentence-cue pass. The word loop above dims sentence-cues
      // reachable at a real word index, but a SECOND sentence sharing one
      // spaceless-CJK whitespace-word is registered at a SYNTHETIC key that
      // no word index addresses — so the loop never visits it and its span
      // would silently go undimmed (the long-second-sentence bug). Dim every
      // sentence-cue's authoritative char span directly, skipping spans the
      // word loop already covered and the active one (the highlight paints
      // it).
      const activeSpan = activeStaticAltSpan
        ? { s: activeStaticAltSpan.def.spanStart, e: activeStaticAltSpan.def.spanEnd }
        : null;
      for (const { def } of this.dynDefs.sentenceCueDefs()) {
        const s = def.spanStart, e = def.spanEnd;
        // Race-guard: skip a STALE span. DynDef clearing is async, so after an
        // edit a sentence-cue def lingers a render or two; without this it
        // paints its old span over the new (often shorter) buffer — the
        // "dim catches the words I'm typing" regression. Verify against live text.
        if (!defSpanLive(def, text)) continue;
        if (activeSpan && activeSpan.s === s && activeSpan.e === e) continue;
        if (dimRanges.some(r => r.start === s && r.end === e)) continue;
        dimRanges.push({ start: s, end: e });
      }
      dimRanges.sort((a, b) => a.start - b.start);
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
        if (def.spanEnd > def.spanStart && defSpanLive(def, text)) {
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
        if (def && def.spanEnd > def.spanStart && target
          && defSpanLive(def, text)
          && (def.spanStart > target.start || def.spanEnd < target.end)) {
          highlight = { start: def.spanStart, end: def.spanEnd };
        } else if (target) {
          highlight = { start: target.start, end: target.end };
        }
      }
    }

    // Inline cue note (Error-Lens reveal). When `inline-cues-mode: inline`
    // and the text cursor sits inside a passive cue's span (a def carrying
    // `cueTip` — sentence-cue / contradiction cue), surface the advisory as
    // a display-only inline note instead of the statusline. Cursor-gated on
    // ctx.cursor directly, so it reveals just by moving the caret into the
    // span — no navigation/highlight activation required (that's what makes
    // it feel ambient). Coordinates: def spans live in `text` (logical)
    // space while ctx.cursor is in ctx.text (painted) space, so map the span
    // forward to ctx coords before the containment test and hand the note to
    // the painter already in painted coordinates.
    let inlineNote: InlineNote | undefined;
    const inlineMode = this.configLoader?.opencuesState.inlineCuesMode ?? 'inline';
    if (
      inlineMode === 'inline'
      && this.adapter.capabilities.includes('dim-ranges')
      && typeof ctx.cursor === 'number' && ctx.cursor >= 0
    ) {
      const toCtx = text !== ctx.text ? buildIndexMap(text, ctx.text) : null;
      for (const [, def] of this.dynDefs.entries()) {
        if (!def.cueTip) continue;              // only passive advisory cues
        if (!defSpanLive(def, text)) continue;  // stale span — skip
        const s = toCtx ? toCtx.start(def.spanStart) : def.spanStart;
        const e = toCtx ? toCtx.end(def.spanEnd) : def.spanEnd;
        if (ctx.cursor >= s && ctx.cursor <= e) {
          inlineNote = { spanStart: s, spanEnd: e, text: def.cueTip };
          break;
        }
      }
    }

    if (!highlight && dimRanges.length === 0 && !inlineNote) return null;

    // Coordinate remap: all ranges above were computed in LOGICAL coordinates
    // (`text` === logicalText when we chose it for correct word/def logic), but
    // the host paints them onto `ctx.text`. Some hosts (Claude Code) insert a
    // soft-wrap `\n` — and/or a ZWS render-kick — into ctx.text that the logical
    // buffer lacks, so every position after that insert is shifted. Without this
    // remap the dim/highlight drifts past the wrap point (the "off by a couple
    // of characters with mixed CJK+Latin" misalignment — same root cause as the
    // loading-spinner colour drift). Map each range logical→ctx. When we used
    // ctx.text directly (genuine edit, !sameContent) the map is identity.
    if (text !== ctx.text) {
      const toCtx = buildIndexMap(text, ctx.text);
      const mapRange = (r: Range): Range => ({ start: toCtx.start(r.start), end: toCtx.end(r.end) });
      const mapped: RenderDirectives = { dimRanges: dimRanges.map(mapRange) };
      if (highlight) mapped.highlight = mapRange(highlight);
      // inlineNote is already computed in ctx (painted) coords — attach as-is.
      if (inlineNote) mapped.inlineNote = inlineNote;
      return mapped;
    }
    return { highlight, dimRanges, ...(inlineNote ? { inlineNote } : {}) };
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
    // The word resolved to a blank keyword. Suppress the keyword's dim only
    // when no `_` is nearby. The keyword window is line-scoped now (per-blank
    // blankProximity was retired), but this cosmetic gate has no line info in
    // `words`, so it uses a fixed wide window — matching keyword-window.ts's
    // `LINE_SCOPE_FALLBACK_PROXIMITY` fallback when no `lineOf` is threaded.
    const DIM_GATE_WINDOW = 12;
    const lower = wordIdx - DIM_GATE_WINDOW - 1;
    const upper = wordIdx + DIM_GATE_WINDOW + 1;
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
