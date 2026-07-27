/**
 * Scenario tests for the June 2026 CJK / coordinate-mapping / managed-span
 * ownership arc. These are MULTI-STEP, CROSS-MODULE journeys — the layer the
 * per-module unit tests don't span — wiring the Resolver (mocked LLM) →
 * DynDefs → DimRender together and asserting the PAINTED render directives
 * against a host-reflowed `ctx.text`.
 *
 * Three behaviour clusters this pins:
 *  1. Coordinate mapping — ranges computed on the logical buffer map onto a
 *     host `ctx.text` that soft-wraps (space→\n / bare mid-CJK-word \n) and/or
 *     toggles a ZWS render-kick, so dim/highlight line up with what's painted
 *     (`coord-map.ts` + DimRender's remap).
 *  2. Managed-span ownership — a plain word-cue overlapping an active managed
 *     owner (transform/fluid/config-intent/sentence-cue) is rejected centrally
 *     by `DynDefs.set` ("the blank span breaks when I edit").
 *  3. Stale-span safety — a managed def whose stored span no longer matches the
 *     live buffer is neither dimmed nor cycled (no paint-over, no corruption).
 *
 * Companion: docs/architecture/spans-and-cycling.md, sentence-cues.md.
 */

import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { DimRender } from './dim-render';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SelectorSatelliteState } from '../state/selector-satellite';
import { MockAdapter } from '../../testing/mock-adapter';

interface MockResult {
  wordIndex: number;
  word: string;
  alternatives: string[];
  source: string;
  priority: number;
  spanStart?: number;
  spanEnd?: number;
  cueTip?: string;
  metadata?: Record<string, unknown>;
}

const TIPS = JSON.stringify({ domain: 't', version: 1, concepts: [] });

async function setup(scripted: MockResult[]) {
  const adapter = new MockAdapter({ cwd: '/proj', files: { '/tips.json': TIPS } });
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const selectorSatelliteState = new SelectorSatelliteState();
  const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
  }, undefined, undefined, undefined, undefined, selectorSatelliteState);
  (resolver as unknown as { _resolver: { resolve(c: unknown): Promise<{ results: MockResult[] }> } })._resolver = {
    resolve: async () => ({ results: scripted }),
  };
  const dim = new DimRender(adapter, hlState, dynDefs, loader);
  return { adapter, hlState, dynDefs, loader, resolver, dim };
}

/** A transform-blank substitute result over the whole buffer. */
function transformResult(buffer: string): MockResult {
  return { wordIndex: 0, word: buffer.split(/\s+/)[0] ?? buffer, alternatives: ['_', buffer], source: 'transform-blank', priority: 93, spanStart: 0, spanEnd: buffer.length };
}

/** A plain word-cue result at a word index. */
function wordCueResult(buffer: string, wordIndex: number): MockResult {
  const words = buffer.split(/\s+/).filter(Boolean);
  return { wordIndex, word: words[wordIndex] ?? '', alternatives: [words[wordIndex] ?? '', 'ALT'], source: 'config:grammar', priority: 60 };
}

// ===========================================================================
// Cluster 1 — coordinate mapping: dim/highlight onto a reflowed ctx.text
// ===========================================================================

describe('CJK scenarios — coordinate mapping (logical→painted)', () => {
  it('transform-blank whole-buffer dim covers the FULL painted text across a space→\\n wrap', async () => {
    // The user translates; CC wraps by replacing a space with \n. The dim must
    // reach the very last char (the drift bug stopped short by the wrap count).
    const buffer = 'すべての通信は HTTPS を使用し、CSP ヘッダーを設定します。';
    const { adapter, dynDefs, dim } = await setup([]);
    adapter.pushText(buffer);
    // Simulate the resolved transform-blank def (whole buffer).
    dynDefs.set(0, { originalWord: '_', alternatives: ['_', buffer], currentIndex: 1, spanStart: 0, spanEnd: buffer.length, blankName: 'transform-blank' });
    // Host paints with two space→\n wraps.
    const painted = buffer.replace('HTTPS を', 'HTTPS\nを').replace('CSP ヘッダー', 'CSP\nヘッダー');
    const out = dim.compute({ text: painted, cursor: 0, externalHighlights: [] });
    // Caret inside the whole-buffer transform → it auto-selects, so the SPAN is
    // the (coordinate-mapped) highlight covering the full painted text.
    expect(out?.highlight?.start).toBe(0);
    expect(out?.highlight?.end).toBe(painted.length); // full painted coverage
  });

  it('handles a bare mid-CJK-word \\n wrap (no space at the wrap column)', async () => {
    const buffer = '認証メカニズムを使用し、データを保存します。';
    const { adapter, dynDefs, dim } = await setup([]);
    adapter.pushText(buffer);
    dynDefs.set(0, { originalWord: '_', alternatives: ['_', buffer], currentIndex: 1, spanStart: 0, spanEnd: buffer.length, blankName: 'transform-blank' });
    const painted = buffer.replace('認証メカニズ', '認証メカニズ\n'); // +1 insert mid-word
    const out = dim.compute({ text: painted, cursor: 0, externalHighlights: [] });
    expect(out?.highlight).toEqual({ start: 0, end: painted.length });
  });

  it('tolerates a trailing ZWS render-kick in the painted text', async () => {
    const buffer = 'モダンなサイトを構築します。';
    const { adapter, dynDefs, dim } = await setup([]);
    adapter.pushText(buffer);
    dynDefs.set(0, { originalWord: '_', alternatives: ['_', buffer], currentIndex: 1, spanStart: 0, spanEnd: buffer.length, blankName: 'transform-blank' });
    const painted = buffer + '‌'; // CC render-kick appended
    const out = dim.compute({ text: painted, cursor: 0, externalHighlights: [] });
    // Covers the visible content; the trailing ZWS is layout, not content.
    expect(out?.highlight?.start).toBe(0);
    expect(out?.highlight?.end).toBeGreaterThanOrEqual(buffer.length);
    expect(out?.highlight?.end).toBeLessThanOrEqual(painted.length);
  });

  it('an out-of-bounds index never escapes the painted length (lossy transient)', async () => {
    // Mid-resolve the painted text can be SHORTER (viewport clip). The mapper
    // must clamp — never emit a range past ctx.text.length.
    const buffer = 'とても長い日本語の文章がここにあります。';
    const { adapter, dynDefs, dim } = await setup([]);
    adapter.pushText(buffer);
    dynDefs.set(0, { originalWord: '_', alternatives: ['_', buffer], currentIndex: 1, spanStart: 0, spanEnd: buffer.length, blankName: 'transform-blank' });
    const painted = buffer.slice(0, 8); // truncated transient
    const out = dim.compute({ text: painted, cursor: 0, externalHighlights: [] });
    if (out?.dimRanges?.length) {
      for (const r of out.dimRanges) {
        expect(r.start).toBeGreaterThanOrEqual(0);
        expect(r.end).toBeLessThanOrEqual(painted.length);
      }
    }
    // The span (now the auto-select highlight) must also never escape painted len.
    if (out?.highlight) {
      expect(out.highlight.start).toBeGreaterThanOrEqual(0);
      expect(out.highlight.end).toBeLessThanOrEqual(painted.length);
    }
  });

  it('active highlight is also mapped to painted coords across a wrap', async () => {
    const buffer = 'すべての通信は HTTPS を使用します。';
    const { adapter, hlState, dynDefs, dim } = await setup([]);
    adapter.pushText(buffer);
    dynDefs.set(0, { originalWord: '_', alternatives: ['_', buffer], currentIndex: 1, spanStart: 0, spanEnd: buffer.length, blankName: 'transform-blank' });
    hlState.activate(0, buffer);
    const painted = buffer.replace('HTTPS を', 'HTTPS\nを');
    const out = dim.compute({ text: painted, cursor: 0, externalHighlights: [] });
    // Highlight (whole transform span) reaches the painted end.
    expect(out?.highlight?.start).toBe(0);
    expect(out?.highlight?.end).toBe(painted.length);
  });
});

// ===========================================================================
// Cluster 2 — managed-span ownership (word-cue suppression via DynDefs.set)
// ===========================================================================

describe('CJK scenarios — managed-span ownership', () => {
  it('a word-cue inside a transform-blank span is rejected; the blank span survives', async () => {
    const buffer = 'aaa bbb ccc ddd';
    const { adapter, dynDefs, resolver } = await setup([wordCueResult(buffer, 2)]); // "ccc" inside
    adapter.pushText(buffer);
    dynDefs.set(0, { originalWord: buffer, alternatives: [buffer], currentIndex: 0, spanStart: 0, spanEnd: buffer.length, blankName: 'transform-blank' });
    await resolver.resolveAndApply(buffer);
    expect(dynDefs.get(2)).toBeUndefined();
    expect(dynDefs.get(0)?.blankName).toBe('transform-blank');
    expect(dynDefs.get(0)?.spanEnd).toBe(buffer.length);
  });

  it('a word-cue OUTSIDE the blank span (a word typed after it) still registers', async () => {
    const buffer = 'aaa bbb ccc ddd';
    const { adapter, dynDefs, resolver } = await setup([wordCueResult(buffer, 3)]); // "ddd" outside [0,11)
    adapter.pushText(buffer);
    dynDefs.set(0, { originalWord: 'aaa bbb ccc', alternatives: ['aaa bbb ccc'], currentIndex: 0, spanStart: 0, spanEnd: 11, blankName: 'transform-blank' });
    await resolver.resolveAndApply(buffer);
    expect(dynDefs.get(3)?.alternatives).toContain('ALT');
  });

  it('a word-cue inside a PERSISTED sentence-cue span is rejected on a later resolve', async () => {
    const buffer = 'aaa bbb ccc ddd';
    const { adapter, dynDefs, resolver } = await setup([wordCueResult(buffer, 1)]); // "bbb" inside
    adapter.pushText(buffer);
    dynDefs.set(0, { originalWord: 'aaa bbb ccc', alternatives: ['aaa bbb ccc', 'AAA BBB CCC'], currentIndex: 0, spanStart: 0, spanEnd: 11, blankName: 'sentence-cue:more-formal' });
    await resolver.resolveAndApply(buffer);
    expect(dynDefs.get(1)).toBeUndefined();
    expect(dynDefs.get(0)?.blankName).toBe('sentence-cue:more-formal');
  });

  it('JOURNEY: translate → span full → type a word after → span holds, new word free to cue', async () => {
    // The exact user report. Start with a transform-blank span owning the
    // buffer, then a re-resolve (simulating an edit after the span) brings a
    // word-cue OUTSIDE the span — it registers, the span is untouched.
    const owned = 'すべての通信は暗号化されます';        // 13 chars (no spaces)
    const after = owned + ' hi';                          // user typed " hi" after
    const { adapter, dynDefs, resolver } = await setup([
      // word-cue on the typed "hi" (word index 1, outside the span)
      { wordIndex: 1, word: 'hi', alternatives: ['hi', 'hello'], source: 'config:grammar', priority: 60 },
    ]);
    adapter.pushText(after);
    dynDefs.set(0, { originalWord: '_', alternatives: ['_', owned], currentIndex: 1, spanStart: 0, spanEnd: owned.length, blankName: 'transform-blank' });
    await resolver.resolveAndApply(after);
    // transform-blank span intact at [0,owned.length]
    expect(dynDefs.get(0)?.blankName).toBe('transform-blank');
    expect(dynDefs.get(0)?.spanEnd).toBe(owned.length);
    // "hi" (outside) registered
    expect(dynDefs.get(1)?.alternatives).toContain('hello');
  });
});

// ===========================================================================
// Cluster 3 — stale-span safety (no paint-over on edit)
// ===========================================================================

describe('CJK scenarios — stale-span safety', () => {
  it('a stale managed span does NOT dim the new (shorter) buffer', async () => {
    const { adapter, dynDefs, dim } = await setup([]);
    adapter.pushText('brand new short text');
    // A transform-blank def left over from a previous (now-gone) buffer.
    dynDefs.set(0, { originalWord: 'すべての通信は暗号化されます。', alternatives: ['すべての通信は暗号化されます。'], currentIndex: 0, spanStart: 0, spanEnd: 14, blankName: 'transform-blank' });
    const out = dim.compute({ text: 'brand new short text', cursor: 0, externalHighlights: [] });
    expect(out?.dimRanges ?? []).toEqual([]);
  });

  it('a stale SYNTHETIC-keyed sentence-cue def does not dim either', async () => {
    const { adapter, dynDefs, dim } = await setup([]);
    adapter.pushText('hello world');
    dynDefs.set(2_000_013, { originalWord: 'また遊ぼうね。', alternatives: ['また遊ぼうね。'], currentIndex: 0, spanStart: 13, spanEnd: 26, blankName: 'sentence-cue:more-formal' });
    const out = dim.compute({ text: 'hello world', cursor: 0, externalHighlights: [] });
    expect(out?.dimRanges ?? []).toEqual([]);
  });

  it('a LIVE managed span (matches buffer) DOES dim — guard only suppresses stale', async () => {
    const buffer = 'すべての通信は暗号化されます。';
    const { adapter, dynDefs, dim } = await setup([]);
    adapter.pushText(buffer);
    dynDefs.set(0, { originalWord: buffer, alternatives: [buffer], currentIndex: 0, spanStart: 0, spanEnd: buffer.length, blankName: 'transform-blank' });
    const out = dim.compute({ text: buffer, cursor: 0, externalHighlights: [] });
    expect(out?.dimRanges).toEqual([{ start: 0, end: buffer.length }]);
  });
});
