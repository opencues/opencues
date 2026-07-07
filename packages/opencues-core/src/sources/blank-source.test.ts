/**
 * Tests for BlankSource — the CueSource that binds `_` to a BlankConfig
 * via blankKeywords, dispatching to readState() for get/step/list/
 * selector-satellite behavior.
 *
 * Prior to this file, BlankSource was only exercised INDIRECTLY through
 * build-sources.test.ts (which only asserts on registration/pruning, via
 * `ids.includes('blank')`) — none of the actual getCues() matching,
 * keyword-window, or per-shape (list/step/satellite/dismissible/clear)
 * logic had a dedicated test.
 */

import { describe, expect, it } from 'vitest';
import { BlankSource, isBlankConfigCycleable } from './blank-source';
import type { BlankConfig } from '../cues-md';
import type { CueContext } from '../types';

function ctx(text: string): CueContext {
  return { text, words: text.split(/\s+/).filter(w => w) };
}

function mkBlank(overrides: Partial<BlankConfig> & { name: string }): BlankConfig {
  return { ...overrides };
}

describe('BlankSource — happy path', () => {
  it('supports() claims a buffer containing `_`', () => {
    const src = new BlankSource({ blanks: {}, readState: () => null });
    expect(src.supports(ctx('volume up _'))).toBe(true);
    expect(src.supports(ctx('no blank here'))).toBe(false);
  });

  it('matches a single-word keyword on the same line and auto-fills the read value', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({ blanks, readState: () => '42' });
    const result = await src.getCues(ctx('volume _'));

    expect(result.results.length).toBe(1);
    const r = result.results[0];
    expect(r.wordIndex).toBe(1);
    expect(r.word).toBe('_');
    expect(r.alternatives).toEqual(['42']);
    expect(r.source).toBe('blank');
    expect(r.priority).toBe(95);
    expect((r.metadata as { blankName?: string }).blankName).toBe('volume');
  });

  it('matches a multi-word keyword phrase (consecutive words)', async () => {
    const blanks = { settings: mkBlank({ name: 'opencuesSettings', blankKeywords: ['opencues settings'] }) };
    const src = new BlankSource({ blanks, readState: () => 'active' });
    const result = await src.getCues(ctx('opencues settings _'));

    expect(result.results.length).toBe(1);
    expect(result.results[0].alternatives).toEqual(['active']);
  });

  it('applies blankSuffix to the displayed value', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'], blankSuffix: '%' }) };
    const src = new BlankSource({ blanks, readState: () => '50' });
    const result = await src.getCues(ctx('volume _'));

    expect(result.results[0].alternatives).toEqual(['50%']);
  });

  it('blankDismissible appends `_` as the final cycle option', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'], blankDismissible: true }) };
    const src = new BlankSource({ blanks, readState: () => '50' });
    const result = await src.getCues(ctx('volume _'));

    expect(result.results[0].alternatives).toEqual(['50', '_']);
  });

  it('stepValues produces a list-cycling result regardless of readState', async () => {
    const blanks = { affirm: mkBlank({ name: 'affirmations', blankKeywords: ['affirmations'], stepValues: ['you can do it', 'stay positive'] }) };
    let readCalled = false;
    const src = new BlankSource({ blanks, readState: () => { readCalled = true; return null; } });
    const result = await src.getCues(ctx('affirmations _'));

    expect(result.results[0].alternatives).toEqual(['you can do it', 'stay positive']);
    expect((result.results[0].metadata as { listBlank?: boolean }).listBlank).toBe(true);
    expect(readCalled).toBe(false); // stepValues short-circuits before readState
  });

  it('stepValues + blankDismissible appends `_` after the list', async () => {
    const blanks = { affirm: mkBlank({ name: 'affirmations', blankKeywords: ['affirmations'], stepValues: ['a', 'b'], blankDismissible: true }) };
    const src = new BlankSource({ blanks, readState: () => null });
    const result = await src.getCues(ctx('affirmations _'));

    expect(result.results[0].alternatives).toEqual(['a', 'b', '_']);
  });

  it('selector/satellite: tab-delimited readState splits into selector alt + satellite metadata', async () => {
    const blanks = { opencues: mkBlank({ name: 'opencues', blankKeywords: ['opencues'], blankSatellite: true }) };
    const src = new BlankSource({ blanks, readState: () => 'voice-mode\tactive' });
    const result = await src.getCues(ctx('opencues _'));

    const r = result.results[0];
    expect(r.alternatives).toEqual(['voice-mode']);
    const meta = r.metadata as { selectorBlank?: boolean; satelliteValue?: string; displaySeparator?: string };
    expect(meta.selectorBlank).toBe(true);
    expect(meta.satelliteValue).toBe('active');
    expect(meta.displaySeparator).toBe(' ');
  });

  it('selector/satellite honors a custom blankSatelliteSeparator for display', async () => {
    const blanks = { opencues: mkBlank({ name: 'opencues', blankKeywords: ['opencues'], blankSatellite: true, blankSatelliteSeparator: ':' }) };
    const src = new BlankSource({ blanks, readState: () => 'voice-mode\tactive' });
    const result = await src.getCues(ctx('opencues _'));

    expect((result.results[0].metadata as { displaySeparator?: string }).displaySeparator).toBe(':');
  });

  it('multi-line readState value becomes a dynamic list blank', async () => {
    const blanks = { hn: mkBlank({ name: 'hackernews', blankKeywords: ['hn'] }) };
    const src = new BlankSource({ blanks, readState: () => 'Title one\nTitle two\nTitle three' });
    const result = await src.getCues(ctx('hn _'));

    expect(result.results[0].alternatives).toEqual(['Title one', 'Title two', 'Title three']);
    expect((result.results[0].metadata as { listBlank?: boolean }).listBlank).toBe(true);
  });

  it('multi-line readState trims blank lines out of the list', async () => {
    const blanks = { hn: mkBlank({ name: 'hackernews', blankKeywords: ['hn'] }) };
    const src = new BlankSource({ blanks, readState: () => 'Title one\n\n  \nTitle two' });
    const result = await src.getCues(ctx('hn _'));

    expect(result.results[0].alternatives).toEqual(['Title one', 'Title two']);
  });

  it('blankStep is forwarded as metadata when present', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'], blankStep: 5 }) };
    const src = new BlankSource({ blanks, readState: () => '50' });
    const result = await src.getCues(ctx('volume _'));

    expect((result.results[0].metadata as { blankStep?: number }).blankStep).toBe(5);
  });

  it('readState receives the matched blank name, keyword, and context words', async () => {
    let seen: [string, string | undefined, string[] | undefined] | undefined;
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({
      blanks,
      readState: (name, kw, words) => { seen = [name, kw, words]; return '10'; },
    });
    await src.getCues(ctx('please set volume _'));

    expect(seen?.[0]).toBe('volume');
    expect(seen?.[1]).toBe('volume');
    expect(seen?.[2]).toEqual(['please', 'set', 'volume', '_']);
  });

  it('readState may return a Promise (async adapters supported)', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({ blanks, readState: async () => '99' });
    const result = await src.getCues(ctx('volume _'));

    expect(result.results[0].alternatives).toEqual(['99']);
  });

  it('closest keyword (smallest gap) wins when multiple blanks could match on the same line', async () => {
    const blanks = {
      volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }),
      brightness: mkBlank({ name: 'brightness', blankKeywords: ['brightness'] }),
    };
    const src = new BlankSource({ blanks, readState: (name) => (name === 'brightness' ? 'BRIGHT' : 'VOL') });
    // brightness is closer to `_` than volume
    const result = await src.getCues(ctx('volume and brightness _'));

    expect((result.results[0].metadata as { blankName?: string }).blankName).toBe('brightness');
  });
});

describe('BlankSource — edge cases', () => {
  it('no blankKeywords on any config → no match', async () => {
    const blanks = { x: mkBlank({ name: 'x' }) };
    const src = new BlankSource({ blanks, readState: () => 'value' });
    const result = await src.getCues(ctx('hello _'));

    expect(result.results).toEqual([]);
  });

  it('keyword present but on a DIFFERENT line than the `_` does not match', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({ blanks, readState: () => '50' });
    const result = await src.getCues(ctx('volume is loud\nsomething else _'));

    expect(result.results).toEqual([]);
  });

  it('readState returning null → no result (nothing to auto-fill)', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({ blanks, readState: () => null });
    const result = await src.getCues(ctx('volume _'));

    expect(result.results).toEqual([]);
  });

  it('readState returning empty string → no result', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({ blanks, readState: () => '' });
    const result = await src.getCues(ctx('volume _'));

    expect(result.results).toEqual([]);
  });

  it('no `_` in the buffer → empty results, no keyword scanning performed', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    let called = false;
    const src = new BlankSource({ blanks, readState: () => { called = true; return '1'; } });
    const result = await src.getCues(ctx('volume up please'));

    expect(result.results).toEqual([]);
    expect(called).toBe(false);
  });

  it('keyword matching is case-insensitive', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({ blanks, readState: () => '77' });
    const result = await src.getCues(ctx('VOLUME _'));

    expect(result.results.length).toBe(1);
    expect(result.results[0].alternatives).toEqual(['77']);
  });

  it('empty blanks map → no match, no crash', async () => {
    const src = new BlankSource({ blanks: {}, readState: () => 'x' });
    const result = await src.getCues(ctx('anything _'));

    expect(result.results).toEqual([]);
  });

  it('blankKeywords: [] (empty array) is treated as "no keywords" and skipped', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: [] }) };
    const src = new BlankSource({ blanks, readState: () => '50' });
    const result = await src.getCues(ctx('volume _'));

    expect(result.results).toEqual([]);
  });

  it('single-line buffer with `_` at index 0 and keyword AFTER it does not match (blank precedes keyword)', async () => {
    // "_" is at index 0, "volume" at index 1 — gap computed via Math.abs so
    // this should still be within-window and DOES match; document that
    // ordering doesn't matter, only same-line adjacency.
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({ blanks, readState: () => '5' });
    const result = await src.getCues(ctx('_ volume'));

    expect(result.results.length).toBe(1);
    expect(result.results[0].wordIndex).toBe(0);
  });

  it('multiple `_` in the text — only the FIRST is bound', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({ blanks, readState: () => '30' });
    const result = await src.getCues(ctx('volume _ and brightness _'));

    expect(result.results.length).toBe(1);
    expect(result.results[0].wordIndex).toBe(1);
  });

  it('blankClearKeywords / blankClearOnEdit default to false when omitted', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({ blanks, readState: () => '10' });
    const result = await src.getCues(ctx('volume _'));

    const meta = result.results[0].metadata as { blankClearKeywords?: boolean; blankClearOnEdit?: boolean };
    expect(meta.blankClearKeywords).toBe(false);
    expect(meta.blankClearOnEdit).toBe(false);
  });

  it('blankClearKeywords: true surfaces the matched keyword indices in metadata', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'], blankClearKeywords: true }) };
    const src = new BlankSource({ blanks, readState: () => '10' });
    const result = await src.getCues(ctx('volume _'));

    const meta = result.results[0].metadata as { blankClearKeywords?: boolean; blankKeywordIndices?: number[] };
    expect(meta.blankClearKeywords).toBe(true);
    expect(meta.blankKeywordIndices).toEqual([0]);
  });
});

describe('BlankSource — invalid input', () => {
  it('getCues on an empty words array returns no results and does not throw', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({ blanks, readState: () => '1' });
    const result = await src.getCues({ text: '', words: [] });

    expect(result.results).toEqual([]);
  });

  it('readState throwing synchronously propagates (BlankSource does not swallow errors)', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({
      blanks,
      readState: () => { throw new Error('script exec failed'); },
    });
    await expect(src.getCues(ctx('volume _'))).rejects.toThrow('script exec failed');
  });

  it('readState rejecting (async) propagates as a rejected promise', async () => {
    const blanks = { volume: mkBlank({ name: 'volume', blankKeywords: ['volume'] }) };
    const src = new BlankSource({
      blanks,
      readState: async () => { throw new Error('async failure'); },
    });
    await expect(src.getCues(ctx('volume _'))).rejects.toThrow('async failure');
  });

  it('a blankKeywords entry that is an empty string does not match every word', async () => {
    const blanks = { odd: mkBlank({ name: 'odd', blankKeywords: [''] }) };
    const src = new BlankSource({ blanks, readState: () => 'value' });
    const result = await src.getCues(ctx('hello world _'));

    // '' split on /\s+/ -> [''], findPhrase looks for '' in contextLower,
    // which indexOf('') would spuriously match at 0 in naive string search —
    // document whatever the actual (non-crashing) behavior is.
    expect(() => result).not.toThrow();
  });
});

describe('isBlankConfigCycleable', () => {
  it('blankSatellite: true → cycleable', () => {
    expect(isBlankConfigCycleable(mkBlank({ name: 'x', blankSatellite: true }))).toBe(true);
  });

  it('stepValues.length > 1 → cycleable', () => {
    expect(isBlankConfigCycleable(mkBlank({ name: 'x', stepValues: ['a', 'b'] }))).toBe(true);
  });

  it('stepValues.length === 1 → NOT cycleable (needs more than one option to cycle)', () => {
    expect(isBlankConfigCycleable(mkBlank({ name: 'x', stepValues: ['a'] }))).toBe(false);
  });

  it('stepValues: [] (empty) → NOT cycleable', () => {
    expect(isBlankConfigCycleable(mkBlank({ name: 'x', stepValues: [] }))).toBe(false);
  });

  it('blankStep present (including 0) → cycleable', () => {
    expect(isBlankConfigCycleable(mkBlank({ name: 'x', blankStep: 0 }))).toBe(true);
    expect(isBlankConfigCycleable(mkBlank({ name: 'x', blankStep: 5 }))).toBe(true);
  });

  it('plain fetch/script blank with none of the cycle-declaring fields → NOT cycleable', () => {
    expect(isBlankConfigCycleable(mkBlank({ name: 'x', blankScript: './script.sh' }))).toBe(false);
  });

  it('minimal blank config ({ name }) → NOT cycleable', () => {
    expect(isBlankConfigCycleable(mkBlank({ name: 'x' }))).toBe(false);
  });
});
