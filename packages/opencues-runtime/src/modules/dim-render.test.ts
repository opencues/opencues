import { describe, expect, it } from 'vitest';
import { DimRender } from './dim-render';
import { Navigation, splitWords } from './navigation';
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

  it('multi-paragraph CJK: dims EVERY paragraph that has a sentence-cue def (the "some all-Japanese text isn\'t highlighted" fix)', async () => {
    // The user's live complaint: translate prose to Japanese across
    // several paragraphs, run sentence-cues, and only the FIRST paragraph
    // is highlighted — the rest of the all-Japanese text shows no dim.
    //
    // Root cause was upstream (the resolver's v1 one-sentence-cue-per-
    // resolve cap registered only the first paragraph's DynDef). With that
    // cap lifted, EACH newline-separated paragraph is a distinct
    // whitespace-word carrying its own sentence-cue def — so the dim layer
    // must paint all of them. Each def's char span equals its paragraph
    // word (single CJK sentence per paragraph), so the dim falls to the
    // word-derived range and covers the whole paragraph.
    const { ConfigLoader } = await import('./config-loader');
    const para1 = '私は毎朝走ります。';
    const para2 = '健康のためにとても良いです。';
    const para3 = 'あなたも一緒にどうですか。';
    const buffer = `${para1}\n${para2}\n${para3}`;
    const p2Start = buffer.indexOf(para2);
    const p3Start = buffer.indexOf(para3);

    const adapter = new MockAdapter({
      files: { '/tips.json': JSON.stringify({ domain: 't', version: 1, concepts: [] }) },
    });
    adapter.pushText(buffer);
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    // One sentence-cue def per paragraph word (indices 0, 1, 2) — exactly
    // what the resolver now registers post-cap-lift.
    dynDefs.set(0, {
      originalWord: para1,
      alternatives: [para1, '私は毎朝走っております。'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: para1.length,
      blankName: 'sentence-cue:more-formal',
    });
    dynDefs.set(1, {
      originalWord: para2,
      alternatives: [para2, '健康のために大変良いものです。'],
      currentIndex: 0,
      spanStart: p2Start,
      spanEnd: p2Start + para2.length,
      blankName: 'sentence-cue:more-formal',
    });
    dynDefs.set(2, {
      originalWord: para3,
      alternatives: [para3, 'あなたも是非ご一緒にいかがでしょうか。'],
      currentIndex: 0,
      spanStart: p3Start,
      spanEnd: p3Start + para3.length,
      blankName: 'sentence-cue:more-formal',
    });
    const dim = new DimRender(adapter, hlState, dynDefs, loader);
    const out = dim.compute({ text: buffer, cursor: 0, externalHighlights: [] });
    // All THREE paragraphs get a dim range — none left un-highlighted.
    expect(out?.dimRanges).toEqual([
      { start: 0, end: para1.length },
      { start: p2Start, end: p2Start + para2.length },
      { start: p3Start, end: p3Start + para3.length },
    ]);
  });

  it('soft-wrapped ctx.text: dim ranges are MAPPED to ctx coords (wrap newline shift) for every CJK sentence', async () => {
    // The live Claude Code bug had TWO compounding causes, both pinned here:
    //   1. CC hands onRender a SOFT-WRAPPED text (newlines inserted at
    //      terminal width) that splits long CJK words and shifts later word
    //      indices — so a sentence-cue def's logical word index pointed at
    //      the wrong word and its dim vanished.
    //   2. Adjacent CJK sentence-cue spans OVERLAP under word-count bounding
    //      (no space after 。 fuses a sentence's first token into the prior
    //      word), so the later sentence's origin was swallowed as an inner
    //      word — no dim.
    // The logical buffer has two paragraphs; ctx.text is the wrapped variant
    // with an extra newline spliced into the long second paragraph. Both
    // paragraphs must dim at their LOGICAL char spans.
    const { ConfigLoader } = await import('./config-loader');
    const p1 = '今日は良い天気ですね。';
    const p2 = 'これはとても長い二番目の文章で端末幅を超えて折り返されるはずの段落です。';
    const logical = `${p1}\n${p2}`;
    const p2Start = logical.indexOf(p2);
    // Wrapped render text: a soft-wrap newline inserted mid-p2 (no such char
    // in the logical buffer). Same content once whitespace is stripped.
    const wrapPos = p2Start + 20;
    const wrapped = logical.slice(0, wrapPos) + '\n' + logical.slice(wrapPos);

    const adapter = new MockAdapter({
      files: { '/tips.json': JSON.stringify({ domain: 't', version: 1, concepts: [] }) },
    });
    adapter.pushText(logical); // adapter.getText() === logical
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const words = splitWords(logical);
    const p1Idx = 0;
    const p2Idx = words.findIndex(w => w.start === p2Start);
    dynDefs.set(p1Idx, {
      originalWord: p1,
      alternatives: [p1, '本日は良いお天気でございますね。'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: p1.length,
      blankName: 'sentence-cue:more-formal',
    });
    dynDefs.set(p2Idx, {
      originalWord: p2,
      alternatives: [p2, '…formal…'],
      currentIndex: 0,
      spanStart: p2Start,
      spanEnd: p2Start + p2.length,
      blankName: 'sentence-cue:more-formal',
    });
    const dim = new DimRender(adapter, hlState, dynDefs, loader);
    // compute is handed the WRAPPED text. Ranges are computed in logical coords
    // then MAPPED to ctx (wrapped) coords so the host paints them correctly.
    const out = dim.compute({ text: wrapped, cursor: 0, externalHighlights: [] });
    // p1 is entirely before the wrap → unchanged. The wrap newline sits inside
    // p2 (at wrapPos), so p2's END shifts +1 in ctx coords; its start (before
    // the wrap) is unchanged.
    expect(out?.dimRanges).toEqual([
      { start: 0, end: p1.length },
      { start: p2Start, end: p2Start + p2.length + 1 },
    ]);
  });

  it('dims a sentence-cue def at a SYNTHETIC key (same-word CJK collision) via the dedicated pass', async () => {
    // Two sentences in ONE spaceless-CJK whitespace-word: the first is at the
    // natural word index, the SECOND at a synthetic key no word addresses. The
    // word loop never visits the synthetic key, so without the dedicated
    // sentence-cue pass its span goes undimmed (the long-second-sentence bug).
    const { ConfigLoader } = await import('./config-loader');
    const s1 = '今日は楽しかったよ。';
    const s2 = 'また遊ぼうね。';
    const buffer = s1 + s2; // no space — ONE whitespace-word
    const adapter = new MockAdapter({
      files: { '/tips.json': JSON.stringify({ domain: 't', version: 1, concepts: [] }) },
    });
    adapter.pushText(buffer);
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    // First at natural word index 0.
    dynDefs.set(0, {
      originalWord: s1,
      alternatives: [s1, '本日は大変楽しかったです。'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: s1.length,
      blankName: 'sentence-cue:more-formal',
    });
    // Second at a synthetic key (mirrors the resolver's collision re-keying).
    dynDefs.set(2_000_000 + s1.length, {
      originalWord: s2,
      alternatives: [s2, 'また是非ご一緒しましょう。'],
      currentIndex: 0,
      spanStart: s1.length,
      spanEnd: buffer.length,
      blankName: 'sentence-cue:more-formal',
    });
    const dim = new DimRender(adapter, hlState, dynDefs, loader);
    const out = dim.compute({ text: buffer, cursor: 0, externalHighlights: [] });
    // BOTH sentence spans dim — the synthetic-keyed one via the dedicated pass.
    expect(out?.dimRanges).toEqual([
      { start: 0, end: s1.length },
      { start: s1.length, end: buffer.length },
    ]);
  });

  it('a STALE sentence-cue def does NOT dim the new buffer (the "dim catches the words I\'m typing" regression)', async () => {
    // Regression: a sentence-cue def (incl. a synthetic-keyed one from a
    // spaceless-CJK collision) lingers a render or two after the buffer
    // changes because DynDef clearing is async. The dedicated dim pass used
    // to paint its old span over the NEW text. The race-guard skips a def
    // whose stored span no longer matches the live buffer.
    const { ConfigLoader } = await import('./config-loader');
    const adapter = new MockAdapter({
      files: { '/tips.json': JSON.stringify({ domain: 't', version: 1, concepts: [] }) },
    });
    // Live buffer is short new text; the lingering def points at [0,13]/[13,32]
    // which no longer hold their sentences.
    adapter.pushText('hello world');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    // Stale def at a real key — its span [0,13] exceeds 'hello world' content.
    dynDefs.set(0, {
      originalWord: 'セキュリティは不可欠です。',
      alternatives: ['セキュリティは不可欠です。', 'セキュリティは必須でございます。'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 13,
      blankName: 'sentence-cue:more-formal',
    });
    // Stale def at a SYNTHETIC key (the same-word-CJK-collision path) — span
    // [13,32] is entirely past the 11-char live buffer.
    dynDefs.set(2_000_013, {
      originalWord: 'すべての通信はHTTPSを使用します。',
      alternatives: ['すべての通信はHTTPSを使用します。', 'すべての通信でHTTPSを使用いたします。'],
      currentIndex: 0,
      spanStart: 13,
      spanEnd: 32,
      blankName: 'sentence-cue:more-formal',
    });
    const dim = new DimRender(adapter, hlState, dynDefs, loader);
    const out = dim.compute({ text: 'hello world', cursor: 0, externalHighlights: [] });
    // NEITHER stale span dims the new buffer.
    expect(out?.dimRanges ?? []).toEqual([]);
  });

  it('a translated (transform-blank) CJK span dims its FULL char span, not the word-derived range', async () => {
    // The user's case: sentence-mode OFF, a translation blank produces a
    // mixed CJK+Latin substitute span. The whole substitute is ONE span and
    // must dim fully. Word-count-derived ranges under-cover CJK (fewer
    // whitespace-words than chars; wrap/truncation shifts the count further),
    // so the char span [0,N] is the source of truth when it's live.
    const { ConfigLoader } = await import('./config-loader');
    const buffer = 'すべての通信は HTTPS を使用し、厳格な CSP ヘッダーを設定します。';
    const adapter = new MockAdapter({
      files: { '/tips.json': JSON.stringify({ domain: 't', version: 1, concepts: [] }) },
    });
    adapter.pushText(buffer);
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    // transform-blank substitute: one def at word 0 spanning the whole buffer.
    dynDefs.set(0, {
      originalWord: buffer,
      alternatives: [buffer],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: buffer.length,
      blankName: 'transform-blank',
    });
    const dim = new DimRender(adapter, hlState, dynDefs, loader);
    const out = dim.compute({ text: buffer, cursor: 0, externalHighlights: [] });
    // Full char span dimmed — every translated character.
    expect(out?.dimRanges).toEqual([{ start: 0, end: buffer.length }]);
  });

  it('a STALE transform-blank span does NOT dim the new buffer (no word-derived over-cover)', async () => {
    // Companion to the above: once the user edits, the transform-blank span is
    // stale and must NOT paint the new buffer (the #181 "blanks catch future
    // text" bug). It's skipped — not word-derived (which would cover all).
    const { ConfigLoader } = await import('./config-loader');
    const adapter = new MockAdapter({
      files: { '/tips.json': JSON.stringify({ domain: 't', version: 1, concepts: [] }) },
    });
    adapter.pushText('brand new typed text');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    dynDefs.set(0, {
      originalWord: 'すべての通信は HTTPS を使用します。',
      alternatives: ['すべての通信は HTTPS を使用します。'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 20, // stale — doesn't match 'brand new typed text'
      blankName: 'transform-blank',
    });
    const dim = new DimRender(adapter, hlState, dynDefs, loader);
    const out = dim.compute({ text: 'brand new typed text', cursor: 0, externalHighlights: [] });
    expect(out?.dimRanges ?? []).toEqual([]);
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

describe('DimRender inline cue notes (inline-cues-mode)', () => {
  // A passive cue (sentence-cue / contradiction cue) registers a def with a
  // `cueTip` advisory. In `inline` mode (default) DimRender surfaces that
  // advisory as an InlineNote whenever the caret sits inside the def's span —
  // the Error-Lens reveal. It's display-only and cursor-gated.
  const BUFFER = 'we meet on saturday';
  function seedContradictionDef(dynDefs: DynDefs) {
    // Span covers "saturday" [11,19). cueTip is the passive advisory.
    dynDefs.set(2, {
      originalWord: 'saturday',
      alternatives: ['saturday'], // currentIndex 0 → passive, buffer unchanged
      currentIndex: 0,
      spanStart: 11,
      spanEnd: 19,
      blankName: 'sentence-cue:contradiction-weekday-date',
      cueTip: "⚠ the 19th is a Friday, not Saturday",
    });
  }

  it('emits an inline note AND auto-selects the span (highlight) when the cursor is inside it', () => {
    const { dynDefs, dimRender } = setup(BUFFER);
    seedContradictionDef(dynDefs);
    // caret at offset 14 — inside "saturday" [11,19)
    const out = dimRender.compute({ text: BUFFER, cursor: 14, externalHighlights: [] });
    expect(out?.inlineNote).toEqual({
      spanStart: 11,
      spanEnd: 19,
      text: "⚠ the 19th is a Friday, not Saturday",
    });
    // Auto-select: the span the caret is in renders in the selected/highlight
    // colour, not dim.
    expect(out?.highlight).toEqual({ start: 11, end: 19 });
    expect(out?.dimRanges ?? []).not.toContainEqual({ start: 11, end: 19 });
  });

  it('emits the note at the span boundary (cursor == spanEnd, inclusive)', () => {
    const { dynDefs, dimRender } = setup(BUFFER);
    seedContradictionDef(dynDefs);
    const out = dimRender.compute({ text: BUFFER, cursor: 19, externalHighlights: [] });
    expect(out?.inlineNote?.text).toBe("⚠ the 19th is a Friday, not Saturday");
  });

  it('does NOT emit the note when the cursor is outside the span', () => {
    const { dynDefs, dimRender } = setup(BUFFER);
    seedContradictionDef(dynDefs);
    // caret at offset 2 — well before the span
    const out = dimRender.compute({ text: BUFFER, cursor: 2, externalHighlights: [] });
    expect(out?.inlineNote).toBeUndefined();
  });

  it('does NOT emit a note for a def without a cueTip (plain static-alt)', () => {
    const { dynDefs, dimRender } = setup('the attorney filed');
    dynDefs.set(1, {
      originalWord: 'attorney',
      alternatives: ['attorney', 'lawyer'],
      currentIndex: 0,
      spanStart: 4,
      spanEnd: 12,
    });
    const out = dimRender.compute({ text: 'the attorney filed', cursor: 6, externalHighlights: [] });
    expect(out?.inlineNote).toBeUndefined();
  });

  it('does NOT emit when the stored span is stale (defSpanLive guard)', () => {
    const { dynDefs, dimRender } = setup(BUFFER);
    seedContradictionDef(dynDefs);
    // The buffer no longer has "saturday" at [11,19) — user edited it.
    const edited = 'we meet on sunday!!';
    const out = dimRender.compute({ text: edited, cursor: 14, externalHighlights: [] });
    expect(out?.inlineNote).toBeUndefined();
  });

  it('secondary mode suppresses the inline note', async () => {
    const { ConfigLoader } = await import('./config-loader');
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/proj/.cues/OPENCUES.md': '---\ninline-cues-mode: secondary\n---\n' },
    });
    adapter.pushText(BUFFER);
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/.cues/OPENCUES.md' });
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    seedContradictionDef(dynDefs);
    const dim = new DimRender(adapter, hlState, dynDefs, loader);
    const out = dim.compute({ text: BUFFER, cursor: 14, externalHighlights: [] });
    expect(out?.inlineNote).toBeUndefined();
  });

  it('the terminal painter renders the note as a dim pill on the line under the span, indented to its column', () => {
    const { dynDefs, dimRender } = setup(BUFFER);
    seedContradictionDef(dynDefs);
    const directives = dimRender.compute({ text: BUFFER, cursor: 14, externalHighlights: [] });
    const painted = applyDirectives(BUFFER, directives);
    // Display-only: the buffer text (minus the ANSI inserted into it) reads
    // unchanged at the front; the note is a dim bracketed pill on a new line,
    // indented to the span's column (11 = start of "saturday").
    const visible = painted.replace(/\x1b\[[0-9;]*m/g, '');
    expect(visible.startsWith(BUFFER)).toBe(true);
    expect(visible).toContain('\n' + ' '.repeat(11) + '⚠ - the 19th is a Friday, not Saturday');
    expect(painted).toContain('\x1b[2m⚠ - the 19th is a Friday, not Saturday\x1b[22m');
  });

  it('places the pill under the SPAN\'s line, not below the whole buffer (long buffer)', () => {
    // Span "saturday" is on line 1; the buffer has two more lines. The pill
    // must land between line 1 and line 2 — right under the span — never after
    // "even more".
    const multiline = 'meet saturday\nmore text\neven more';
    const { dynDefs, dimRender } = setup(multiline);
    dynDefs.set(1, {
      originalWord: 'saturday',
      alternatives: ['saturday'],
      currentIndex: 0,
      spanStart: 5,
      spanEnd: 13,
      blankName: 'sentence-cue:contradiction-weekday-date',
      cueTip: '⚠ the 19th is a Friday',
    });
    const directives = dimRender.compute({ text: multiline, cursor: 8, externalHighlights: [] });
    const visible = applyDirectives(multiline, directives).replace(/\x1b\[[0-9;]*m/g, '');
    expect(visible).toContain('saturday\n     ⚠ - the 19th is a Friday\nmore text');
    // Not dangling after the last line.
    expect(visible.endsWith('even more')).toBe(true);
  });
});
