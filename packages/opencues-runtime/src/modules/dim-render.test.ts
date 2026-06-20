import { describe, expect, it } from 'vitest';
import { DimRender } from './dim-render';
import { Navigation } from './navigation';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';
import { applyDirectives } from '../render-directives';

function setup(text: string) {
  const adapter = new MockAdapter();
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const dimRender = new DimRender(adapter, hlState, dynDefs);
  dimRender.subscribe();
  return { adapter, hlState, dynDefs, dimRender };
}

describe('DimRender.compute', () => {
  it('returns null when highlight inactive', () => {
    const { dimRender } = setup('hello world');
    expect(dimRender.compute({ text: 'hello world', cursor: 0, externalHighlights: [] })).toBeNull();
  });

  it('returns highlight range covering the active word', () => {
    const { hlState, dimRender } = setup('alpha beta gamma');
    hlState.activate(1, 'alpha beta gamma');
    const out = dimRender.compute({ text: 'alpha beta gamma', cursor: 0, externalHighlights: [] });
    expect(out).toMatchObject({ highlight: { start: 6, end: 10 } });
  });

  it('returns null when wordIndex is out of bounds for the current text', () => {
    const { hlState, dimRender } = setup('alpha');
    hlState.activate(5, 'alpha'); // text only has 1 word
    expect(dimRender.compute({ text: 'alpha', cursor: 0, externalHighlights: [] })).toBeNull();
  });

  it('highlights a span-bound def\'s CHAR span, not the whole whitespace-word (CJK has no spaces)', () => {
    // Regression (observed live on Claude Code): a Japanese sentence-cue.
    // The buffer is two sentences but has NO spaces, so splitWords yields a
    // SINGLE word covering the whole buffer. The sentence-cue def carries
    // the first sentence's char span [0,13); the highlight must use that,
    // not the giant word [0,22], or it selects both sentences.
    const buffer = '今日はとても楽しかったよ。また一緒に遊ぼうね。'; // one whitespace-word
    const { hlState, dynDefs, dimRender } = setup(buffer);
    dynDefs.set(0, {
      originalWord: '今日はとても楽しかったよ。',
      alternatives: ['今日はとても楽しかったよ。', '本日はとても楽しゅうございました。'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 13, // end of the first sentence (after 。)
      blankName: 'sentence-cue:more-formal',
    });
    hlState.activate(0, buffer);
    const out = dimRender.compute({ text: buffer, cursor: 0, externalHighlights: [] });
    expect(out).toMatchObject({ highlight: { start: 0, end: 13 } });
  });

  it('mixed CJK+Latin: highlights the def char span when a whitespace-word straddles a 。 boundary', () => {
    // Multi-WORD sentence (has spaces around "HTTPS"), so it goes through
    // the activeStaticAltSpan branch — but whitespace-word 2
    // ("を徹底します。同一サイトトークンで") straddles the 。 between two
    // sentences (no space after the stop). The word-derived range would run
    // to the end of that straddling word (into sentence 2); the def's char
    // span [0,21) is the true first-sentence range. Observed live on CC.
    const buffer = 'すべての通信で HTTPS を徹底します。同一サイトトークンで CSRF を防止します。';
    const { hlState, dynDefs, dimRender } = setup(buffer);
    dynDefs.set(0, {
      originalWord: 'すべての通信で HTTPS を徹底します。',
      alternatives: ['すべての通信で HTTPS を徹底します。', 'すべての通信で HTTPS を徹底いたします。'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 21, // end of "…します。" (the first 。)
      blankName: 'sentence-cue:more-formal',
    });
    hlState.activate(0, buffer);
    const out = dimRender.compute({ text: buffer, cursor: 0, externalHighlights: [] });
    expect(out).toMatchObject({ highlight: { start: 0, end: 21 } });
    // The straddling word 2 ends at 31; the highlight must NOT reach it.
    expect((out as { highlight: { end: number } }).highlight.end).toBeLessThan(31);
  });

  it('does NOT use a normal multi-word blank\'s stored span (it can be stale) — uses the live word range', () => {
    // Regression guard: the def-char-span override is for sentence-cues ONLY.
    // A fluid-blank's spanStart/spanEnd can go stale after edits; trusting it
    // for the multi-word highlight/dim caught future text. A non-sentence-cue
    // def must fall back to the word-derived range, recomputed live.
    const buffer = 'New York and more text here';
    const { hlState, dynDefs, dimRender } = setup(buffer);
    dynDefs.set(0, {
      originalWord: 'New York', // 2 words → multi-word span (activeStaticAltSpan branch)
      alternatives: ['New York', 'NYC'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 27, // STALE — spans the WHOLE buffer, not just "New York" [0,8)
      blankName: 'fluid-blank', // NOT a sentence-cue
    });
    hlState.activate(0, buffer);
    const out = dimRender.compute({ text: buffer, cursor: 0, externalHighlights: [] });
    // Must highlight only "New York" [0,8) via the live words, NOT [0,27).
    expect(out).toMatchObject({ highlight: { start: 0, end: 8 } });
  });

  it('still highlights the whole word when the def span equals the word (ASCII unchanged)', () => {
    // A normal single-word cue: def char span == the word's range → use the
    // word range (no behaviour change for space-delimited text).
    const { hlState, dynDefs, dimRender } = setup('alpha beta');
    dynDefs.set(0, {
      originalWord: 'alpha',
      alternatives: ['alpha', 'first'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 5, // == "alpha" word range
    });
    hlState.activate(0, 'alpha beta');
    const out = dimRender.compute({ text: 'alpha beta', cursor: 0, externalHighlights: [] });
    expect(out).toMatchObject({ highlight: { start: 0, end: 5 } });
  });

  it('honours capability gating — no highlight without highlight-range capability', () => {
    const adapter = new MockAdapter({ capabilities: ['file-read'] });
    const hlState = new HighlightState();
    const dimRender = new DimRender(adapter, hlState, new DynDefs());
    hlState.activate(0, 'alpha');
    expect(dimRender.compute({ text: 'alpha', cursor: 0, externalHighlights: [] })).toBeNull();
  });
});

describe('DimRender trusts hlState across runtime-driven text changes', () => {
  it('keeps highlighting after Cycling-style text replacement', () => {
    const { hlState, dimRender } = setup('undo');
    hlState.activate(0, 'undo');
    // Cycling replaced "undo" with "/rewind" — same wordIndex, new span.
    const out = dimRender.compute({ text: '/rewind', cursor: 0, externalHighlights: [] });
    expect(out).toMatchObject({ highlight: { start: 0, end: 7 } });
    expect(hlState.active).toBe(true);
  });

  it('returns null when wordIndex points past the new word list', () => {
    const { hlState, dimRender } = setup('alpha beta');
    hlState.activate(1, 'alpha beta');
    // User deleted everything except "alpha"
    const out = dimRender.compute({ text: 'alpha', cursor: 0, externalHighlights: [] });
    expect(out).toBeNull();
  });
});

describe('DimRender + render pipeline (integration)', () => {
  it('fireRender produces directives that paint the right word when applied', () => {
    const { adapter, hlState } = setup('alpha beta gamma');
    hlState.activate(2, 'alpha beta gamma'); // gamma → start=11, end=16
    const directives = adapter.fireRender();
    expect(directives.length).toBe(1);
    const out = applyDirectives('alpha beta gamma', directives[0]);
    expect(out).toBe(`alpha beta \x1b[97mgamma\x1b[39m`);
  });

  it('dims the consume-all span as a single contiguous range', () => {
    const adapter = new MockAdapter();
    adapter.pushText('Improved alpha bravo');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ca = new SpanFillState();
    ca.set({ index: 0, alternatives: ['Improved alpha bravo', 'Other'], currentAltIndex: 0, spanLength: 3 }, 'Improved alpha bravo');
    const dim = new DimRender(adapter, hlState, dynDefs, undefined, ca);
    const out = dim.compute({ text: 'Improved alpha bravo', cursor: 0, externalHighlights: [] });
    expect(out?.dimRanges).toEqual([{ start: 0, end: 20 }]);
  });

  it('active word inside span expands highlight to whole span; no inner dim', () => {
    const adapter = new MockAdapter();
    adapter.pushText('Improved alpha bravo');
    const hlState = new HighlightState();
    hlState.activate(1, 'Improved alpha bravo'); // "alpha" — inside span
    const dynDefs = new DynDefs();
    const ca = new SpanFillState();
    ca.set({ index: 0, alternatives: ['Improved alpha bravo', 'Other'], currentAltIndex: 0, spanLength: 3 }, 'Improved alpha bravo');
    const dim = new DimRender(adapter, hlState, dynDefs, undefined, ca);
    const out = dim.compute({ text: 'Improved alpha bravo', cursor: 0, externalHighlights: [] });
    // Highlight covers the whole span (0..20). No span dim layer (active is inside).
    expect(out?.highlight).toEqual({ start: 0, end: 20 });
    expect(out?.dimRanges).toEqual([]);
  });

  // Blank-keyword arm gating — June 2026 UX change.
  // A blank keyword on its own is an *action trigger* that requires `_`
  // adjacency to fire. Without `_`, dimming the keyword is noise — it
  // implies interactivity when nothing will happen. The gate suppresses
  // the dim until `_` lands within `blankProximity`. Word-cue entries
  // (legal/medical/financial/spelling, any CUES.md ## Tips) bypass the
  // gate because their dim IS the offer of prose alternatives.
  it('blank keyword without `_` adjacent does NOT dim', async () => {
    const { ConfigLoader } = await import('./config-loader');
    const VOLUME_BLANK = `---
name: volume
type: blank
blankKeywords: volume
blankProximity: 3
tip: system volume
blankScript: ./vol.sh
---`;
    const TIPS = JSON.stringify({ domain: 't', version: 1, concepts: [] });
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/blanks/volume/BLANK.md': VOLUME_BLANK },
    });
    adapter.pushText('the volume in this room was low');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const dim = new DimRender(adapter, hlState, dynDefs, loader);
    const out = dim.compute({ text: 'the volume in this room was low', cursor: 0, externalHighlights: [] });
    // "volume" is in blanksByWord (navigable) but no `_` is adjacent → suppress.
    expect(out?.dimRanges ?? []).toEqual([]);
  });

  it('blank keyword WITH `_` within proximity DOES dim', async () => {
    const { ConfigLoader } = await import('./config-loader');
    const VOLUME_BLANK = `---
name: volume
type: blank
blankKeywords: volume
blankProximity: 3
tip: system volume
blankScript: ./vol.sh
---`;
    const TIPS = JSON.stringify({ domain: 't', version: 1, concepts: [] });
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/blanks/volume/BLANK.md': VOLUME_BLANK },
    });
    adapter.pushText('volume is _');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const dim = new DimRender(adapter, hlState, dynDefs, loader);
    const out = dim.compute({ text: 'volume is _', cursor: 0, externalHighlights: [] });
    // _ is at word 2, volume is at word 0; proximity 3 covers it → dim fires.
    expect(out?.dimRanges?.some(r => r.start === 0 && r.end === 6)).toBe(true);
  });

  it('dims words that are only navigable via DynDefs (LLM-resolved)', async () => {
    const { ConfigLoader } = await import('./config-loader');
    const adapter = new MockAdapter({
      files: { '/tips.json': JSON.stringify({ domain: 't', version: 1, concepts: [] }) },
    });
    adapter.pushText('cat sat');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    // Pretend the LLM resolver attached alts to "sat".
    dynDefs.set(1, {
      originalWord: 'sat',
      alternatives: ['sat', 'rested'],
      currentIndex: 0,
      spanStart: 4,
      spanEnd: 7,
    });
    const dim = new DimRender(adapter, hlState, dynDefs, loader);
    const out = dim.compute({ text: 'cat sat', cursor: 0, externalHighlights: [] });
    // "sat" is in DynDefs but not in cueMap → should still dim.
    expect(out?.dimRanges).toEqual([{ start: 4, end: 7 }]);
  });

  it('no consume-all dim when state is empty', () => {
    const adapter = new MockAdapter();
    adapter.pushText('hello world');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ca = new SpanFillState();
    const dim = new DimRender(adapter, hlState, dynDefs, undefined, ca);
    const out = dim.compute({ text: 'hello world', cursor: 0, externalHighlights: [] });
    expect(out).toBeNull();
  });

  it('Navigation + DimRender — Ctrl+Alt+Left activates and produces a highlight', () => {
    const adapter = new MockAdapter();
    adapter.pushText('one two three');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();

    const nav = new Navigation(adapter, hlState, dynDefs);
    nav.subscribe();
    const dim = new DimRender(adapter, hlState, dynDefs);
    dim.subscribe();

    expect(adapter.fireRender()).toEqual([]); // not active yet → null filtered

    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.active).toBe(true);
    expect(hlState.wordIndex).toBe(2); // three

    const directives = adapter.fireRender();
    expect(directives.length).toBe(1);
    expect(directives[0].highlight).toEqual({ start: 8, end: 13 }); // "three"
  });
});
