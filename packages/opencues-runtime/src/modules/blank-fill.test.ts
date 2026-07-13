import { describe, expect, it, vi } from 'vitest';
import { BlankFill, buildClearKeywordText, computeCleanupRange, computeFillRange } from './blank-fill';
import { ConfigLoader } from './config-loader';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';
import { SpanFillState } from '../state/span-fill';
import { DismissedBlanks } from '../state/dismissed-blanks';
import { SelectorSatelliteState } from '../state/selector-satellite';
import { DynDefs } from '../state/dyn-defs';

const TIPS = wrapTipsAsCuesMd({ concepts: [] });

const VOLUME_CUE = `---
type: blank
name: volume
blankKeywords: volume, vol, sound, audio
blankProximity: 10
---
`;

const AFFIRM_CUE = `---
type: blank
name: affirmations
blankKeywords: affirmation, affirm
blankProximity: 10
stepValues: ["I am strong", "I am brave"]
---
`;

const PROMPT_CUE = `---
type: blank
name: prompt
blankKeywords: improve prompt, write prompt, prompt
blankProximity: 0
---
`;

async function setup(text: string) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: {
      '/mock/CUES.md': TIPS,
      '/proj/blanks/volume/BLANK.md': VOLUME_CUE,
      '/proj/blanks/affirmations/BLANK.md': AFFIRM_CUE,
      '/proj/blanks/prompt/BLANK.md': PROMPT_CUE,
    },
  });
  adapter.pushText(text);
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const bf = new BlankFill(adapter, loader);
  bf.subscribe();
  return { adapter, loader, bf };
}

describe('BlankFill detection', () => {
  it('matches single-word keyword: "affirm _" → affirmations', async () => {
    const { bf } = await setup('affirm _');
    const slots = bf.scan('affirm _');
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      index: 1,
      keyword: 'affirm',
      blankName: 'affirmations',
      keywordStart: 0,
      keywordEnd: 0,
      proximity: 0,
    });
  });

  it('matches multi-word keyword: "improve prompt _"', async () => {
    const { bf } = await setup('improve prompt _');
    const slots = bf.scan('improve prompt _');
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      index: 2,
      keyword: 'improve prompt',
      blankName: 'prompt',
      keywordStart: 0,
      keywordEnd: 1,
      proximity: 0,
    });
  });

  it('no match when no keyword precedes _', async () => {
    const { bf } = await setup('the cat _ sat');
    expect(bf.scan('the cat _ sat')).toHaveLength(0);
  });

  it('detects multiple slots in one input', async () => {
    const { bf } = await setup('affirm _ improve prompt _');
    const slots = bf.scan('affirm _ improve prompt _');
    expect(slots).toHaveLength(2);
    expect(slots.map(s => s.blankName)).toEqual(['affirmations', 'prompt']);
  });

  it('line-scoped window: keyword anywhere on the `_`s line claims it', async () => {
    // "prompt for image _" — keyword "prompt" is on the same line as `_`,
    // so it claims regardless of distance (the per-blank blankProximity
    // knob was retired; routing precision is shapes' job).
    const { bf } = await setup('prompt for image _');
    expect(bf.scan('prompt for image _')).toHaveLength(1);
    // Adjacent still matches.
    expect(bf.scan('prompt _')).toHaveLength(1);
    // Keyword on a PREVIOUS line → no claim (line-scoped).
    expect(bf.scan('prompt for image\nrender it _')).toHaveLength(0);
  });

  it('matches synonyms: vol / sound / audio all map to volume', async () => {
    const { bf } = await setup('vol _');
    expect(bf.scan('vol _')[0]?.blankName).toBe('volume');
    expect(bf.scan('sound _')[0]?.blankName).toBe('volume');
    expect(bf.scan('audio _')[0]?.blankName).toBe('volume');
  });

  it('case-insensitive keyword matching', async () => {
    const { bf } = await setup('Volume _');
    expect(bf.scan('Volume _')[0]?.blankName).toBe('volume');
  });

  it('subscribe re-scans on text change', async () => {
    const { adapter, bf } = await setup('hello');
    expect(bf.slots).toHaveLength(0);
    adapter.pushText('affirm _');
    expect(bf.slots).toHaveLength(1);
    expect(bf.slots[0].blankName).toBe('affirmations');
  });

  // Regression: stocks-chain loop (June 2026 — `nvda _ + apple _ = _`)
  //
  // BlankFill was looping on substituted output whose text contained a
  // registered keyword. Concrete shape: `nvda _` → `Nvidia NVDA: $200.42`.
  // The substituted span contained `nvidia` (one of the stocks blank's
  // keywords); on the NEXT text-change BlankFill scanned the new buffer,
  // matched `nvidia` against the still-present `_` further along, and
  // re-fired the substitute. Buffer kept looping; sibling blanks
  // (`apple _`, `= _`) never got a stable scan to fire against.
  //
  // Fix: matchKeyword skips candidates whose keyword indices fall
  // inside an already-substituted multi-word DynDef span.
  it('skips keyword match inside an already-substituted multi-word span', async () => {
    const STOCKS = `---
type: blank
name: stocks
blankKeywords: nvidia, nvda, apple, aapl
blankProximity: 0
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/mock/CUES.md': TIPS,
        '/proj/blanks/stocks/BLANK.md': STOCKS,
      },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const dynDefs = new DynDefs();
    // Mimic the post-substitute state: stocks substituted "nvda _" to
    // "Nvidia NVDA: $200.42" (3 words, indices 0-2). DynDefs registers
    // that span. The user then appends " + apple _", giving the full
    // buffer "Nvidia NVDA: $200.42 + apple _" (7 words, _ at index 6).
    dynDefs.set(0, {
      originalWord: 'nvda',
      alternatives: ['Nvidia NVDA: $200.42'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 20,
      blankName: 'stocks',
    });
    const bf = new BlankFill(adapter, loader, undefined, undefined, undefined, dynDefs);
    const slots = bf.scan('Nvidia NVDA: $200.42 + apple _');
    // Only the apple slot at _ (index 6) should match. The substituted
    // span's "Nvidia" / "NVDA:" must NOT be picked up as an
    // nvidia/nvda keyword candidate.
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      keyword: 'apple',
      blankName: 'stocks',
    });
  });

  it('still matches keyword OUTSIDE substituted spans', async () => {
    const STOCKS = `---
type: blank
name: stocks
blankKeywords: nvidia, nvda, apple
blankProximity: 0
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/mock/CUES.md': TIPS,
        '/proj/blanks/stocks/BLANK.md': STOCKS,
      },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    // Belt-and-braces: a DynDefs with a SINGLE-word substituted entry
    // shouldn't suppress matches anywhere (findSpanContaining only
    // returns multi-word spans). The "apple" keyword at index 0 should
    // still match.
    const dynDefs = new DynDefs();
    dynDefs.set(2, {
      originalWord: 'foo',
      alternatives: ['BAR'],
      currentIndex: 0,
      spanStart: 6,
      spanEnd: 9,
      blankName: 'other',
    });
    const bf = new BlankFill(adapter, loader, undefined, undefined, undefined, dynDefs);
    const slots = bf.scan('apple _ BAR');
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ keyword: 'apple', blankName: 'stocks' });
  });
});

describe('buildClearKeywordText helper', () => {
  it('drops single-word keyword and replaces blank', () => {
    const r = buildClearKeywordText('weather _', { index: 1, keywordStart: 0, keywordEnd: 0 }, '15°C');
    expect(r.newText).toBe('15°C');
    expect(r.newCursor).toBe(4);
  });
  it('preserves context words between keyword and blank', () => {
    const r = buildClearKeywordText('weather in Paris _', { index: 3, keywordStart: 0, keywordEnd: 0 }, '15°C');
    expect(r.newText).toBe('in Paris 15°C');
    expect(r.newCursor).toBe(13);
  });
  it('drops multi-word keyword span', () => {
    const r = buildClearKeywordText('improve prompt _', { index: 2, keywordStart: 0, keywordEnd: 1 }, 'better');
    expect(r.newText).toBe('better');
    expect(r.newCursor).toBe(6);
  });
  it('keeps trailing words after the blank', () => {
    const r = buildClearKeywordText('cheer _ today', { index: 1, keywordStart: 0, keywordEnd: 0 }, 'yay');
    expect(r.newText).toBe('yay today');
    expect(r.newCursor).toBe(3);
  });
  it('strips ZWS from input before splitting', () => {
    const r = buildClearKeywordText('weather\u200B _', { index: 1, keywordStart: 0, keywordEnd: 0 }, 'x');
    expect(r.newText).toBe('x');
  });
  it('clears a single-word keyword adjacent to the blank', () => {
    const r = buildClearKeywordText('rddt _', { index: 1, keywordStart: 0, keywordEnd: 0 }, '$180.50');
    expect(r.newText).toBe('$180.50');
    expect(r.newCursor).toBe(7);
  });
  it('collapses a multi-word keyword span', () => {
    const r = buildClearKeywordText('big tech _', { index: 2, keywordStart: 0, keywordEnd: 1 }, '$100');
    expect(r.newText).toBe('$100');
  });
  it('keyword-clear preserves context words after the keyword', () => {
    // keywordEnd=0 clears just "hn"; "for today" survives, `_` → "Story".
    const r = buildClearKeywordText('hn for today _', { index: 3, keywordStart: 0, keywordEnd: 0 }, 'Story');
    expect(r.newText).toBe('for today Story');
  });
  it('clearEnd widens to slot.index-1 (consumes the whole command span)', () => {
    const r = buildClearKeywordText(
      'what is the word for happy _',
      { index: 6, keywordStart: 0, keywordEnd: 4 },
      'glad',
      5, // slot.index - 1
    );
    expect(r.newText).toBe('glad');
  });
  it('trailing words after blank are kept', () => {
    const r = buildClearKeywordText(
      'how to say hi _ to her',
      { index: 4, keywordStart: 0, keywordEnd: 2 },
      'hello',
      3,
    );
    expect(r.newText).toBe('hello to her');
  });
});

describe('computeCleanupRange helper', () => {
  it('user edits inside the pair → wipe range covers the whole pair', () => {
    const oldText = 'foo voice-mode active bar';
    const newText = 'foo voicE-mode active bar'; // capital E at offset 8
    const r = computeCleanupRange(oldText, newText, 4, 21);
    // Min(prefix, pairStart) = min(8, 4) = 4. Min(suffix, oldTail) = min(16, 4) = 4.
    expect(r).toEqual({ start: 4, end: newText.length - 4 });
    // Splicing yields "foo  bar" — the pair's gone.
    expect(newText.slice(0, r.start) + newText.slice(r.end)).toBe('foo  bar');
  });
  it('user inserts a space mid-selector (word boundary shift case)', () => {
    const oldText = 'foo voice-mode active bar';
    const newText = 'foo voice -mode active bar'; // space at offset 9
    const r = computeCleanupRange(oldText, newText, 4, 21);
    // Pair removed in spite of new word boundary.
    expect(newText.slice(0, r.start) + newText.slice(r.end)).toBe('foo  bar');
  });
  it('user deletes some chars from the satellite', () => {
    const oldText = 'foo voice-mode active bar';
    const newText = 'foo voice-mode acti bar'; // dropped "ve"
    const r = computeCleanupRange(oldText, newText, 4, 21);
    expect(newText.slice(0, r.start) + newText.slice(r.end)).toBe('foo  bar');
  });
  // The helper isn't designed for the texts-match case — BlankFill's
  // caller-side `cleaned !== lastFilledText` gate makes that path
  // unreachable in production. The suffix loop's early exit when
  // prefix consumes the whole text means a degenerate `{start:
  // pairStart, end: newText.length}` would result; not asserting on it.
});

describe('computeFillRange', () => {
  const slot = { index: 6, keyword: 'what is the word for', keywordEnd: 4 };
  it('blankClearKeywords sets clearEnd = slot.keywordEnd', () => {
    const r = computeFillRange({ blankClearKeywords: true }, slot);
    expect(r).toEqual({ clearEnd: 4 });
  });
  it('no flags returns no-op range', () => {
    const r = computeFillRange({}, slot);
    expect(r).toEqual({ clearEnd: undefined });
  });
});

describe('BlankFill auto-populate', () => {
  function makeKeyEvent(text: string, cursor: number, key = '_') {
    return {
      key,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      text,
      cursorOffset: cursor,
    };
  }

  it('replaces _ with stepValues[0] when blank opts in', async () => {
    const { adapter, bf } = await setup('affirm ');
    const consumed = bf.onUnderscoreKey(makeKeyEvent('affirm ', 7));
    expect(consumed).toBe(true);
    // setText was called with the populated text
    const setText = adapter.setTextCalls.at(-1);
    expect(setText).toBe('affirm I am strong');
    // Cursor lands at end of fill
    expect(adapter.setCursorCalls.at(-1)).toBe(7 + 'I am strong'.length);
  });

  it('returns false (host inserts _ normally) when no matching keyword precedes', async () => {
    const { adapter, bf } = await setup('the cat ');
    const consumed = bf.onUnderscoreKey(makeKeyEvent('the cat ', 8));
    expect(consumed).toBe(false);
    expect(adapter.setTextCalls).toHaveLength(0);
  });

  it('returns false when blank is script-backed (no stepValues)', async () => {
    const { adapter, bf } = await setup('volume ');
    const consumed = bf.onUnderscoreKey(makeKeyEvent('volume ', 7));
    expect(consumed).toBe(false);
    expect(adapter.setTextCalls).toHaveLength(0);
  });

  it('does not interfere when modifiers are pressed (e.g. Ctrl+_)', async () => {
    const { adapter, bf } = await setup('affirm ');
    const ev = makeKeyEvent('affirm ', 7);
    ev.modifiers = { ctrl: true, alt: false, shift: false, meta: false };
    expect(bf.onUnderscoreKey(ev)).toBe(false);
    expect(adapter.setTextCalls).toHaveLength(0);
  });

  it('async path: blankScript get is spawned for script-backed blank with no stepValues', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: stocks
blankKeywords: stock, ticker
blankProximity: 10
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/stocks/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('stock _');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith(expect.objectContaining({
      command: 'bash',
      args: expect.arrayContaining(['get', 'stock']),
    }));
  });

  it('async path: blankInvoke is preferred over spawnProcess when host implements it', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: stocks
blankKeywords: stock, ticker
blankProximity: 10
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/stocks/BLANK.md': SCRIPT_CTRL },
    });
    // Sandboxed host returns the value via blankInvoke; spawn should
    // never be hit.
    adapter.stubBlankInvoke('stocks:get', '$201.66\n');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('stock _');
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(adapter.blankInvokeCalls.length).toBe(1);
    expect(adapter.blankInvokeCalls[0]).toMatchObject({
      blankName: 'stocks',
      action: 'get',
      args: ['stock'],
    });
  });

  it('async path: passes context words (excluding keyword + blank)', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: weather
blankKeywords: weather
blankProximity: 10
blankScript: ./weather.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/weather/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('weather in Paris _');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const args = spawnSpy.mock.calls[0][0].args;
    // ['./weather.sh', 'get', 'weather', 'in', 'Paris']
    expect(args.slice(2)).toEqual(['weather', 'in', 'Paris']);
  });

  it('async path: passes context words for multi-word keyword (index-based filter)', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: stocks
blankKeywords: reddit stock
blankProximity: 10
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/stocks/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('reddit stock today _');
    const args = spawnSpy.mock.calls[0][0].args;
    // Both 'reddit' and 'stock' excluded (multi-word keyword); 'today' kept.
    expect(args.slice(2)).toEqual(['reddit stock', 'today']);
  });

  // Regression: prior-line context flood (June 2026 — #216 manual test).
  //
  // A shaped blank's command leads its OWN line (`capital of france _`) and
  // dispatches via the deterministic shape path — line-scoped, so prose on
  // an EARLIER line is unrelated. The bug was the CONTEXT we sent with the
  // get: the old collector gathered the WHOLE buffer minus the keyword span,
  // so every word from the prior lines leaked in. Live repro: a `countries`
  // blank got the user's entire first-line website-design paragraph as
  // "context" and the script echoed back a 495-char garbage string that
  // overwrote the `_`. Fix: context is ONLY the arg region between the
  // keyword and the `_` (mirrors the anchored shape's valueGroup), so prior
  // lines can never flood the get.
  it('prior-line prose does not flood get context (arg region only)', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: countries
blankKeywords: capital of
blankScript: ./countries.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/countries/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    // Unrelated prose on line 1; the command `capital of france _` leads line 2.
    adapter.pushText('design and develop responsive website with modern ui\ncapital of france _');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const args = spawnSpy.mock.calls[0][0].args;
    // ['./countries.sh', 'get', 'capital of', 'france'] — ONLY 'france'
    // (the word between the keyword and the `_`). None of line 1's prose leaks.
    expect(args.slice(2)).toEqual(['capital of', 'france']);
    expect(args).not.toContain('website');
    expect(args).not.toContain('responsive');
  });

  it('prior-line prose does not flood a bare get (empty context)', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: countries
blankKeywords: countries
blankScript: ./countries.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/countries/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    // A paragraph on line 1; bare `countries _` leads line 2.
    adapter.pushText('here is a long sentence about many unrelated things\ncountries _');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const args = spawnSpy.mock.calls[0][0].args;
    // Bare get — only the keyword, no context words at all.
    expect(args.slice(2)).toEqual(['countries']);
  });

  it('async path: expands ~ in script path', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: stocks
blankKeywords: stock
blankProximity: 10
blankScript: ~/.claude/actions/stock.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/stocks/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('stock _');
    const args = spawnSpy.mock.calls[0][0].args;
    expect(args[0]).toBe(`${process.env.HOME ?? '~'}/.claude/actions/stock.sh`);
    expect(args[0].startsWith('~')).toBe(false);
  });

  it('async path: dedupes concurrent spawns for same (text, slot)', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: stocks
blankKeywords: stock
blankProximity: 10
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/stocks/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('stock _');
    adapter.pushText('stock _'); // same text, no new spawn
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('sync path: blankClearKeywords strips keyword from filled text (single-word keyword)', async () => {
    const CLR_CTRL = `---
type: blank
name: cheer
blankKeywords: cheer
blankProximity: 10
stepValues: ["yay"]
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/cheer/BLANK.md': CLR_CTRL },
    });
    adapter.pushText('cheer ');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('cheer ', 6))).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('yay');
    expect(adapter.setCursorCalls.at(-1)).toBe(3);
  });

  it('sync path: blankClearKeywords preserves context words between keyword and blank', async () => {
    const CLR_CTRL = `---
type: blank
name: temp
blankKeywords: weather
blankProximity: 10
stepValues: ["15°C"]
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/temp/BLANK.md': CLR_CTRL },
    });
    adapter.pushText('weather in Paris ');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('weather in Paris ', 17))).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('in Paris 15°C');
  });

  it('sync path: blankClearKeywords drops both words of a multi-word keyword', async () => {
    const CLR_CTRL = `---
type: blank
name: greet
blankKeywords: say hello
blankProximity: 10
stepValues: ["hi"]
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/greet/BLANK.md': CLR_CTRL },
    });
    adapter.pushText('say hello ');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('say hello ', 10))).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('hi');
  });

  it('async path: a shaped get-with-arg clears the whole command span', async () => {
    // `weather` desugars to shapes. "weather paris _" captures "paris" as the
    // arg, so the whole command span ("weather paris") is consumed and only
    // the script output lands. Unified shape-clearing — supersedes the old
    // blankClearKeywords (which only cleared the bare keyword).
    const CLR_CTRL = `---
type: blank
name: weather
blankKeywords: weather
blankScript: ./weather.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/weather/BLANK.md': CLR_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: '15°C cloudy', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('weather paris _');
    await new Promise(r => setTimeout(r, 0));
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(adapter.getText()).toBe('15°C cloudy');
  });

  it('async path: a BARE shaped get keeps the keyword as a label', async () => {
    const PLAIN = `---
type: blank
name: weather2
blankKeywords: weather
blankScript: ./weather.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/weather2/BLANK.md': PLAIN },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: '15°C cloudy', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('weather _');
    await new Promise(r => setTimeout(r, 0));
    // Bare get (no captured arg) → keyword kept as the label, `_` filled.
    expect(adapter.getText()).toBe('weather 15°C cloudy');
  });

  // ─── Trailing-keyword shapes (location-style grammar) ────────────────
  //
  // An authored shape may put the captured arg BEFORE the keyword
  // ("east finchley iceland location _"). Two things must hold that the
  // positional (keyword→`_`) machinery can't provide: (a) the dispatch
  // receives the shape's captured arg as context, and (b) the clear span
  // covers the whole matched command SEGMENT (commandStart), not just
  // keyword→`_`. Journey tests, per the scenario-test rule.
  const LOCATION_CTRL = `---
type: blank
name: location
blankKeywords: location, address
blankScript: ./location.sh
blankShapes: [{"pattern":"^(?:location|address)\\\\s+(.+?)\\\\s*_$","action":"get","valueGroup":1},{"pattern":"^(.+?)\\\\s+(?:location|address)\\\\s*_$","action":"get","valueGroup":1},{"pattern":"^(?:location|address)\\\\s*_$","action":"get"}]
---
`;
  const ICELAND_OUT = 'Iceland, High Road, Finchley, N2 8AQ, United Kingdom';

  async function locationSetup(stdout: string) {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/location/BLANK.md': LOCATION_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout, stderr: '', timedOut: false }),
      kill: () => {},
    }));
    return { adapter, spawnSpy };
  }

  it('trailing-keyword shape: captured arg reaches the get as context words', async () => {
    const { adapter, spawnSpy } = await locationSetup(ICELAND_OUT);
    adapter.pushText('east finchley iceland location _');
    await new Promise(r => setTimeout(r, 0));
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const args = spawnSpy.mock.calls[0][0].args;
    // [script, 'get', keyword, ...arg] — the arg PRECEDES the keyword in
    // the buffer; the positional walk would have found nothing.
    expect(args.slice(2)).toEqual(['location', 'east', 'finchley', 'iceland']);
  });

  it('trailing-keyword shape: whole command span consumed, output self-contained', async () => {
    const { adapter } = await locationSetup(ICELAND_OUT);
    adapter.pushText('east finchley iceland location _');
    await new Promise(r => setTimeout(r, 0));
    // The output embeds the place; the typed query + trigger are consumed.
    expect(adapter.getText()).toBe(ICELAND_OUT);
  });

  it('trailing-keyword shape after a prior sentence: only its segment is consumed', async () => {
    const { adapter } = await locationSetup(ICELAND_OUT);
    adapter.pushText('hii world. east finchley iceland location _');
    await new Promise(r => setTimeout(r, 0));
    // The shape matched its own SEGMENT — the prior sentence survives.
    expect(adapter.getText()).toBe(`hii world. ${ICELAND_OUT}`);
  });

  it('leading authored shape behaves like the synthesized grammar (regression guard)', async () => {
    const { adapter, spawnSpy } = await locationSetup(ICELAND_OUT);
    adapter.pushText('location east finchley iceland _');
    await new Promise(r => setTimeout(r, 0));
    const args = spawnSpy.mock.calls[0][0].args;
    expect(args.slice(2)).toEqual(['location', 'east', 'finchley', 'iceland']);
    expect(adapter.getText()).toBe(ICELAND_OUT);
  });

  it('trailing-keyword shape: [err] output fills only the `_`, command survives', async () => {
    const { adapter } = await locationSetup('[err] location: no match for "xyzzy"');
    adapter.pushText('xyzzy location _');
    await new Promise(r => setTimeout(r, 0));
    // Feedback result — the typed query is preserved for correction.
    expect(adapter.getText()).toBe('xyzzy location [err] location: no match for "xyzzy"');
  });

  it('sync path: blankClearKeywords drops the keyword on a list blank', async () => {
    const BOTH = `---
type: blank
name: bye
blankKeywords: bye
stepValues: ["see ya"]
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/bye/BLANK.md': BOTH },
    });
    adapter.pushText('bye ');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('bye ', 4))).toBe(true);
    // Keyword cleared → just the value.
    expect(adapter.setTextCalls.at(-1)).toBe('see ya');
  });

  it('async path: dispatches via blankInvoke when blank has no blankScript (runtime-hoisted blank)', async () => {
    // Hoisted runtime blanks (HackerNewsBlank, OpenCuesSettingsBlank
    // etc.) live without blankScript in their BLANK.md — the host's
    // blankInvoke registry IS the implementation. Regression guard
    // for "blanks with no blankScript get silently skipped" — fires
    // when something accidentally re-adds the early `if (!script)
    // continue` gate.
    const SCRIPTLESS_CTRL = `---
type: blank
name: hn
blankKeywords: hn
blankProximity: 10
blankAutoPopulate: true
---
`;
    // Sandboxed-host caps: NO spawn-process. Forces the runtime to
    // pick up the blankInvoke path or skip the slot entirely.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/hn/BLANK.md': SCRIPTLESS_CTRL },
      capabilities: [
        'render-override', 'dim-ranges', 'highlight-range',
        'file-read', 'file-write', 'force-render', 'change-source',
        'blank-invoke',
      ],
    });
    adapter.stubBlankInvoke('hn:get', 'top story title\n');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    adapter.pushText('hn _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.blankInvokeCalls.length).toBe(1);
    // Keyword stays (no blankClearKeywords) — `_` is replaced with stdout.
    expect(adapter.getText()).toBe('hn top story title');
  });

  it('multi-word stepValues fill registers a SpanFillState entry', async () => {
    const AFFIRM_F = `---
type: blank
name: affirmations
blankKeywords: affirm
blankProximity: 10
stepValues: ["I am strong", "I am brave"]
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/affirmations/BLANK.md': AFFIRM_F },
    });
    adapter.pushText('affirm ');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const span = new SpanFillState();
    const bf = new BlankFill(adapter, loader, span);
    bf.subscribe();
    expect(bf.onUnderscoreKey({
      key: '_',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      text: 'affirm ',
      cursorOffset: 7,
    })).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('affirm I am strong');
    expect(span.current).toMatchObject({
      index: 1,
      alternatives: ['I am strong', 'I am brave'],
      currentAltIndex: 0,
      spanLength: 3,
    });
    expect(span.lastFilledText).toBe('affirm I am strong');
  });

  it('single-stepValue fill does NOT register a span (no cycling needed)', async () => {
    // Only one alt → cycling would be a no-op anyway.
    const ONE = `---
type: blank
name: lone
blankKeywords: lone
blankProximity: 10
stepValues: ["only"]
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/lone/BLANK.md': ONE },
    });
    adapter.pushText('lone ');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const span = new SpanFillState();
    const bf = new BlankFill(adapter, loader, span);
    bf.subscribe();
    bf.onUnderscoreKey({
      key: '_',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      text: 'lone ',
      cursorOffset: 5,
    });
    expect(span.current).toBeNull();
  });

  it('blankDismissible appends `_` to span alternatives (sync stepValues)', async () => {
    const DISMISS = `---
type: blank
name: affirmations
blankKeywords: affirm
blankProximity: 10
stepValues: ["I am strong", "I am brave"]
blankDismissible: true
tip: Daily affirmations
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/affirmations/BLANK.md': DISMISS },
    });
    adapter.pushText('affirm ');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const span = new SpanFillState();
    const bf = new BlankFill(adapter, loader, span);
    bf.subscribe();
    bf.onUnderscoreKey({
      key: '_',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      text: 'affirm ',
      cursorOffset: 7,
    });
    expect(span.current?.alternatives).toEqual(['I am strong', 'I am brave', '_']);
    expect(span.current?.tip).toBe('Daily affirmations');
  });

  it('dismissed slot blocks sync auto-populate on subsequent _ key', async () => {
    const DISMISS = `---
type: blank
name: a
blankKeywords: a
blankProximity: 10
stepValues: ["x", "y"]
blankDismissible: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/a/BLANK.md': DISMISS },
    });
    adapter.pushText('a ');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const dismissed = new DismissedBlanks();
    const bf = new BlankFill(adapter, loader, undefined, dismissed);
    bf.subscribe();
    dismissed.add(1); // pretend slot at word index 1 was just dismissed
    const consumed = bf.onUnderscoreKey({
      key: '_',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      text: 'a ',
      cursorOffset: 2,
    });
    // BlankFill returned false → host inserts `_` normally; no fill ran.
    expect(consumed).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('dismissed slot blocks async script spawn', async () => {
    const SCRIPT = `---
type: blank
name: weather
blankKeywords: weather
blankProximity: 10
blankScript: ./weather.sh
blankDismissible: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/weather/BLANK.md': SCRIPT },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const dismissed = new DismissedBlanks();
    const bf = new BlankFill(adapter, loader, undefined, dismissed);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    dismissed.add(1); // slot at index 1 dismissed
    adapter.pushText('weather _');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('async multi-line stdout populates span with all lines as alternatives', async () => {
    const HN = `---
type: blank
name: hackernews
blankKeywords: hn
blankProximity: 10
blankScript: ./hn.sh
blankDismissible: true
tip: Hacker News
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/hackernews/BLANK.md': HN },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const span = new SpanFillState();
    const bf = new BlankFill(adapter, loader, span);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({
        exitCode: 0,
        stdout: 'first story title\nsecond story title\nthird story title\n',
        stderr: '',
        timedOut: false,
      }),
      kill: () => {},
    }));
    adapter.pushText('hn _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.getText()).toBe('hn first story title');
    expect(span.current?.alternatives).toEqual([
      'first story title',
      'second story title',
      'third story title',
      '_', // dismissible appended
    ]);
    expect(span.current?.tip).toBe('Hacker News');
    expect(span.current?.spanLength).toBe(3);
  });

  it('async single-line non-dismissible single-word fill does NOT register span', async () => {
    const STOCK = `---
type: blank
name: stocks
blankKeywords: stock
blankProximity: 10
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/stocks/BLANK.md': STOCK },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const span = new SpanFillState();
    const bf = new BlankFill(adapter, loader, span);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: '$180.50', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('stock _');
    await new Promise(r => setTimeout(r, 0));
    // Single-word, no alts, no dismissible → no span (regular cycling
    // doesn't apply to a fixed read-only price).
    expect(span.current).toBeNull();
  });

  it('tab-separated stdout under blankSatellite splits into selector + satellite', async () => {
    const SAT = `---
type: blank
name: opencues
blankKeywords: opencues settings
blankProximity: 10
blankScript: ./oc.sh
blankSatellite: true
blankSatelliteSeparator: ' '
blankClearKeywords: true
blankClearOnEdit: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/opencues/BLANK.md': SAT },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const ss = new SelectorSatelliteState();
    const bf = new BlankFill(adapter, loader, undefined, undefined, ss);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'voice-mode\tactive\n', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('opencues settings _');
    await new Promise(r => setTimeout(r, 0));
    // Keyword stripped, selector + satellite spliced with default ' '.
    expect(adapter.getText()).toBe('voice-mode active');
    expect(ss.current).toMatchObject({
      blankName: 'opencues',
      selectorIndex: 0,
      satelliteIndex: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: true,
    });
  });

  it('respects custom blankSatelliteSeparator', async () => {
    const SAT = `---
type: blank
name: opencues
blankKeywords: cfg
blankProximity: 10
blankScript: ./oc.sh
blankSatellite: true
blankSatelliteSeparator: '='
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/opencues/BLANK.md': SAT },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const ss = new SelectorSatelliteState();
    const bf = new BlankFill(adapter, loader, undefined, undefined, ss);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'k\tv', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('cfg _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.getText()).toContain('k=v');
  });

  it('editing inside the pair wipes both words when blankClearOnEdit:true', async () => {
    const SAT = `---
type: blank
name: opencues
blankKeywords: cfg
blankProximity: 10
blankScript: ./oc.sh
blankSatellite: true
blankClearOnEdit: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/opencues/BLANK.md': SAT },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const ss = new SelectorSatelliteState();
    const bf = new BlankFill(adapter, loader, undefined, undefined, ss);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'voice-mode\tactive', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('cfg _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.getText()).toBe('cfg voice-mode active');
    expect(ss.current).not.toBeNull();
    // User edits inside the pair (changes 'a' to 'A')
    adapter.pushText('cfg voice-mode Active');
    // Stash invalidated; pair spliced out by char range. Keyword stays
    // because we didn't set blankClearKeywords on this blank.
    expect(ss.current).toBeNull();
    expect(adapter.getText()).toBe('cfg ');
  });

  it('appending a space after the pair preserves the stash + updates lastFilledText', async () => {
    const SAT = `---
type: blank
name: opencues
blankKeywords: cfg
blankProximity: 10
blankScript: ./oc.sh
blankSatellite: true
blankClearOnEdit: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/opencues/BLANK.md': SAT },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const ss = new SelectorSatelliteState();
    const bf = new BlankFill(adapter, loader, undefined, undefined, ss);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'voice-mode\tactive', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('cfg _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.getText()).toBe('cfg voice-mode active');
    const before = ss.current;
    expect(before).not.toBeNull();
    // User adds a space at the end. Pair is intact.
    adapter.pushText('cfg voice-mode active ');
    expect(ss.current).not.toBeNull();
    expect(ss.current?.pairCharStart).toBe(before!.pairCharStart);
    expect(ss.current?.pairCharEnd).toBe(before!.pairCharEnd);
    expect(adapter.getText()).toBe('cfg voice-mode active '); // unchanged by us
  });

  it('prepending text before the pair preserves the stash + shifts positions', async () => {
    const SAT = `---
type: blank
name: opencues
blankKeywords: cfg
blankProximity: 10
blankScript: ./oc.sh
blankSatellite: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/opencues/BLANK.md': SAT },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const ss = new SelectorSatelliteState();
    const bf = new BlankFill(adapter, loader, undefined, undefined, ss);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'voice-mode\tactive', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('cfg _');
    await new Promise(r => setTimeout(r, 0));
    const beforeStart = ss.current!.pairCharStart;
    // Prepend "hi " (3 chars)
    adapter.pushText('hi cfg voice-mode active');
    expect(ss.current).not.toBeNull();
    expect(ss.current?.pairCharStart).toBe(beforeStart + 3);
  });

  it('cleanup preserves text BEFORE and AFTER the pair', async () => {
    const SAT = `---
type: blank
name: opencues
blankKeywords: cfg
blankProximity: 10
blankScript: ./oc.sh
blankSatellite: true
blankClearOnEdit: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/opencues/BLANK.md': SAT },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const ss = new SelectorSatelliteState();
    const bf = new BlankFill(adapter, loader, undefined, undefined, ss);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'voice-mode\tactive', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    // Shaped command leads the line, `_` at the end.
    adapter.pushText('cfg _');
    await new Promise(r => setTimeout(r, 0));
    // Keyword stays (bare get keeps the label), satellite pair filled.
    expect(adapter.getText()).toBe('cfg voice-mode active');
    // User edits inside the pair (capital E) → clearOnEdit wipes the pair.
    adapter.pushText('cfg voicE-mode active');
    expect(ss.current).toBeNull();
  });

  it('blankClearOnEdit:false leaves the broken pair in place', async () => {
    const SAT = `---
type: blank
name: opencues
blankKeywords: cfg
blankProximity: 10
blankScript: ./oc.sh
blankSatellite: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/opencues/BLANK.md': SAT },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const ss = new SelectorSatelliteState();
    const bf = new BlankFill(adapter, loader, undefined, undefined, ss);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'k\tv', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('cfg _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.getText()).toBe('cfg k v');
    adapter.pushText('cfg K v'); // user edited
    // Stash invalidated; pair NOT cleaned up.
    expect(ss.current).toBeNull();
    expect(adapter.getText()).toBe('cfg K v');
  });

  it('missing tab in stdout does NOT trigger satellite path', async () => {
    const SAT = `---
type: blank
name: opencues
blankKeywords: cfg
blankProximity: 10
blankScript: ./oc.sh
blankSatellite: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/opencues/BLANK.md': SAT },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const ss = new SelectorSatelliteState();
    const bf = new BlankFill(adapter, loader, undefined, undefined, ss);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'just-one-token', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('cfg _');
    await new Promise(r => setTimeout(r, 0));
    // Falls through to single-fill splice path; no satellite stash.
    expect(ss.current).toBeNull();
    expect(adapter.getText()).toContain('just-one-token');
  });

  // Keyword-blank clearOnEdit (non-selector/satellite path). Mirrors
  // the four-case matrix selector/satellite already covers, but for a
  // plain keyword blank with blankClearKeywords:false (so the keyword
  // stays visible and is part of the protected pair).
  describe('blankClearOnEdit on a plain keyword blank', () => {
    const KW_BLANK = `---
type: blank
name: status
blankKeywords: is x down
blankProximity: 10
blankScript: ./status.sh
blankClearOnEdit: true
blankClearKeywords: false
---
`;
    const TIPS_MIN = `---
ignore: []
---

## Tips
`;
    function setup() {
      const adapter = new MockAdapter({
        cwd: '/proj',
        files: { '/mock/CUES.md': TIPS_MIN, '/proj/blanks/status/BLANK.md': KW_BLANK },
      });
      adapter.stubBlankInvoke('status:get', 'No — operational');
      const loader = new ConfigLoader(adapter);
      const span = new SpanFillState();
      const bf = new BlankFill(adapter, loader, span);
      return { adapter, loader, span, bf };
    }

    it('mid-keyword edit splices the substituted region out', async () => {
      const { adapter, loader, span, bf } = setup();
      await loader.load();
      bf.subscribe();
      adapter.pushText('is x down _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('is x down No — operational');
      expect(span.current).not.toBeNull();
      // Delete a char from the middle of the keyword.
      adapter.pushText('is  down No — operational');
      expect(span.current).toBeNull();
      expect(adapter.getText()).toBe('');
    });

    it('mid-answer edit splices the region out', async () => {
      const { adapter, loader, bf } = setup();
      await loader.load();
      bf.subscribe();
      adapter.pushText('is x down _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('is x down No — operational');
      adapter.pushText('is x down No — perational');
      expect(adapter.getText()).toBe('');
    });

    it('appending text AFTER the region preserves the fill', async () => {
      const { adapter, loader, span, bf } = setup();
      await loader.load();
      bf.subscribe();
      adapter.pushText('is x down _');
      await new Promise(r => setTimeout(r, 0));
      adapter.pushText('is x down No — operational and ready');
      // Span survives — clearOnEdit didn't fire.
      expect(span.current).not.toBeNull();
      expect(adapter.getText()).toBe('is x down No — operational and ready');
    });

    it('prepending text BEFORE the region preserves the fill + re-anchors positions', async () => {
      const { adapter, loader, span, bf } = setup();
      await loader.load();
      bf.subscribe();
      adapter.pushText('is x down _');
      await new Promise(r => setTimeout(r, 0));
      adapter.pushText('hey is x down No — operational');
      expect(span.current).not.toBeNull();
      expect(adapter.getText()).toBe('hey is x down No — operational');
    });
  });

  // ─── Shape-routed keyword blank (keywords desugar to shapes) ─────────
  //
  // Keywords are the friendly shorthand; they desugar to anchored shapes,
  // the single routing mechanism. A command must LEAD its line with `_` at
  // the end. A captured arg clears the whole command span; a bare get keeps
  // the keyword as a label. Prose that merely mentions the keyword mid-line
  // never fires (de-greedy — there's no loose keyword window anymore).
  describe('shape-routed keyword blank', () => {
    const TIPS_MIN = `---
ignore: []
---

## Tips
`;
    function setup() {
      const blankMd = `---
type: blank
name: demo
blankKeywords: demo
blankScript: ./demo.sh
---
`;
      const adapter = new MockAdapter({
        cwd: '/proj',
        files: { '/mock/CUES.md': TIPS_MIN, '/proj/blanks/demo/BLANK.md': blankMd },
      });
      const loader = new ConfigLoader(adapter);
      const bf = new BlankFill(adapter, loader);
      vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
        result: Promise.resolve({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false }),
        kill: () => {},
      }));
      return { adapter, loader, bf };
    }

    it('captured arg clears the whole command span', async () => {
      const { adapter, loader, bf } = setup();
      await loader.load();
      bf.subscribe();
      adapter.pushText('demo of x _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('OK');
    });

    it('bare get keeps the keyword as a label', async () => {
      const { adapter, loader, bf } = setup();
      await loader.load();
      bf.subscribe();
      adapter.pushText('demo _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('demo OK');
    });

    it('de-greedy: keyword mid-line (not leading) does NOT fire', async () => {
      const { adapter, loader, bf } = setup();
      await loader.load();
      bf.subscribe();
      adapter.pushText('hello world demo _');
      await new Promise(r => setTimeout(r, 0));
      // "demo" doesn't lead the line → no shape match → nothing fires.
      expect(adapter.getText()).toBe('hello world demo _');
    });
  });
});

describe('BlankFill — invalid/edge input hardening', () => {
  it('whitespace-only region between keyword and `_` behaves like a bare get (no empty-string arg token)', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: weather
blankKeywords: weather
blankScript: ./weather.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/weather/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    // Extra spaces between the keyword and `_`, but no actual context word.
    adapter.pushText('weather    _');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const args = spawnSpy.mock.calls[0][0].args;
    // Must be exactly ['./weather.sh', 'get', 'weather'] — no stray empty
    // strings from splitting on the extra whitespace.
    expect(args.slice(2)).toEqual(['weather']);
    expect(args).not.toContain('');
  });

  it('an extremely long script stdout (50k chars) lands intact with no truncation', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: stocks
blankKeywords: stock
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/stocks/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const huge = 'x'.repeat(50000);
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: huge, stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('stock _');
    await new Promise(r => setTimeout(r, 0));
    // Bare get keeps the keyword as a label, so the buffer is "stock " + huge.
    expect(adapter.getText()).toBe(`stock ${huge}`);
    expect(adapter.getText().length).toBe(6 + huge.length);
  });

  it('empty-string / whitespace-only stdout is a silent no-op (no substitution, no crash)', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: stocks
blankKeywords: stock
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/stocks/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: '   \n  ', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('stock _');
    await new Promise(r => setTimeout(r, 0));
    // Nothing landed — the `_` is still there untouched (trim()'d stdout
    // was empty, so applyAsyncFill was never called).
    expect(adapter.getText()).toBe('stock _');
  });

  it('a captured arg that literally repeats the keyword text does not double-match or corrupt the command span', async () => {
    const SCRIPT_CTRL = `---
type: blank
name: weather
blankKeywords: weather
blankScript: ./weather.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/weather/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'sunny', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('weather weather _');
    await new Promise(r => setTimeout(r, 0));
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const args = spawnSpy.mock.calls[0][0].args;
    // The synthesized get-with-arg shape reads `weather weather _` as
    // keyword + captured arg "weather" — and dispatch and clearing BOTH
    // follow the shape verdict (they used to disagree: clearing treated
    // this as captured-arg while dispatch treated it as a bare get; the
    // trailing-keyword shape work unified them on the shape's reading).
    // The guarded property is unchanged: ONE spawn, deterministic args,
    // no double-match, no span corruption.
    expect(args.slice(2)).toEqual(['weather', 'weather']);
    // Captured-arg rule: the whole command span is consumed.
    expect(adapter.getText()).toBe('sunny');
  });

  // BUG FOUND (documented, not fixed — see instructions). Expected:
  // two keyword-bound blanks, each with its own `_` (even on separate
  // lines), each resolve independently using their OWN script + context.
  //
  // Actual: blank-fill.ts:210 computes `const usIdx = words.indexOf('_')`
  // — the FIRST `_` in the WHOLE buffer — and attaches whatever single
  // shape verdict `matchBlankShape` returned (which only ever examines
  // the LINE OF THE LAST `_` — see `lineWithBlank` in
  // packages/opencues-core/src/blank-shapes.ts:40) to that FIRST `_`'s
  // slot, even when the verdict's blankName belongs to a DIFFERENT
  // blank than the one whose keyword actually precedes the first `_`.
  // When no existing slot matches (index, blankName) the code creates a
  // brand-new bogus slot at the first `_`'s position carrying the LAST
  // blank's identity, with keywordStart/keywordEnd defaulted to (0,0)
  // (its keyword-position search only looks BEFORE `usIdx`, so it never
  // finds the real keyword, which sits after the first `_`).
  //
  // Compounding gate (blank-fill.ts:396): `if (sc?.blankShapes?.length &&
  // !slot.shapeAction) continue;` skips ANY slot for a shape-declaring
  // blank that didn't get a shapeAction attached. Since matchBlankShape
  // only ever tags ONE slot total, BOTH of the real, correctly-detected
  // keyword slots get skipped by this gate — only the bogus cross-wired
  // slot survives and dispatches.
  //
  // Net effect verified via a direct repro: 'weather paris _\nstock
  // nvda _' resolves to "NVDA:100\nstock nvda _" — the FIRST `_` (which
  // belongs to "weather") gets overwritten with the STOCKS script's
  // output (using a garbage context word leaked from the weather line),
  // and the SECOND `_` (the real stocks slot) is never touched at all.
  //
  // Proposed fix direction: `matchBlankShape` should report which `_`
  // (word index) the line it examined belongs to, and blank-fill.ts's
  // shape-handling block should use THAT index instead of unconditionally
  // taking `words.indexOf('_')` (the first occurrence in the buffer).
  it.fails('two different keyword-bound blanks, each with their own `_`, should resolve independently (currently only one — the wrong one — fires)', async () => {
    const WEATHER = `---
type: blank
name: weather
blankKeywords: weather
blankScript: ./weather.sh
---
`;
    const STOCKS = `---
type: blank
name: stocks
blankKeywords: stock
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/mock/CUES.md': TIPS,
        '/proj/blanks/weather/BLANK.md': WEATHER,
        '/proj/blanks/stocks/BLANK.md': STOCKS,
      },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation((spec) => {
      const stdout = spec.args.includes('weather') ? '15C' : 'NVDA:100';
      return { result: Promise.resolve({ exitCode: 0, stdout, stderr: '', timedOut: false }), kill: () => {} };
    });
    adapter.pushText('weather paris _\nstock nvda _');
    await new Promise(r => setTimeout(r, 10));
    // What SHOULD happen: each blank's own `_` resolves with its own
    // script's output. What ACTUALLY happens: "NVDA:100\nstock nvda _"
    // (documented above) — this assertion fails against current
    // behavior, which is exactly what pins the bug via it.fails().
    expect(adapter.getText()).toBe('15C\nNVDA:100');
  });
});

describe('BlankFill result cache (skip spawn on repeat invocation within TTL)', () => {
  // Spy installed BEFORE loader.load + bf.subscribe inside setup; test
  // then awaits load + subscribe. FILL is the default mode now (no
  // replace dial needed).
  const TIPS_MIN = `---
ignore: []
---
`;

  function makeBlank(): string {
    return `---
type: blank
name: demo
blankKeywords: demo
blankProximity: 10
blankScript: ./demo.sh
---
`;
  }

  function makeScenario() {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS_MIN, '/proj/blanks/demo/BLANK.md': makeBlank() },
    });
    const loader = new ConfigLoader(adapter);
    const bf = new BlankFill(adapter, loader);
    let callIndex = 0;
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => {
      const idx = callIndex++;
      return {
        result: Promise.resolve({ exitCode: 0, stdout: `RESULT_${idx}`, stderr: '', timedOut: false }),
        kill: () => {},
      };
    });
    return { adapter, loader, bf, spawnSpy };
  }

  // Simulate "user re-typed `_` after the prior fill landed". Need to
  // reset the buffer to the pre-`_` shape AND arm the explicit-`_`
  // flag (BlankFill won't fire scripts without it — same gate the
  // resolver uses). The bareUnderscoreKeyAt-end approach mirrors what
  // a real user keystroke produces: cursor at end of "demo ", then `_`.
  function reArmAndPush(adapter: MockAdapter, withText: string): void {
    const idx = withText.lastIndexOf('_');
    const pre = withText.slice(0, idx);
    // Quietly reset the buffer (no keystroke synthesis on the way down).
    adapter.pushTextNoKeystroke(pre, pre.length);
    // Then re-use pushText which fires the `_` keystroke when the new
    // text has more underscores than the current — same path
    // MockAdapter's pushText takes on a real keystroke.
    adapter.pushText(withText, withText.length);
  }

  it('repeat identical-arg invocation within TTL skips spawn + reuses cached stdout', async () => {
    const { adapter, loader, bf, spawnSpy } = makeScenario();
    await loader.load();
    bf.subscribe();
    adapter.pushText('demo _');
    await new Promise(r => setTimeout(r, 0));
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(adapter.getText()).toBe('demo RESULT_0');

    reArmAndPush(adapter, 'demo _');
    await new Promise(r => setTimeout(r, 0));
    expect(spawnSpy).toHaveBeenCalledTimes(1);   // cache HIT
    expect(adapter.getText()).toBe('demo RESULT_0');
  });


  it('failed result (exitCode !== 0) is NOT cached — next call still spawns', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS_MIN, '/proj/blanks/demo/BLANK.md': makeBlank() },
    });
    const loader = new ConfigLoader(adapter);
    const bf = new BlankFill(adapter, loader);
    let callIndex = 0;
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => {
      const idx = callIndex++;
      return {
        result: Promise.resolve(idx === 0
          ? { exitCode: 1, stdout: '', stderr: 'oops', timedOut: false }
          : { exitCode: 0, stdout: 'GOOD', stderr: '', timedOut: false }),
        kill: () => {},
      };
    });
    await loader.load();
    bf.subscribe();
    adapter.pushText('demo _');
    await new Promise(r => setTimeout(r, 0));
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    // Failure NOT cached → next invocation spawns again.
    reArmAndPush(adapter, 'demo _');
    await new Promise(r => setTimeout(r, 0));
    expect(spawnSpy).toHaveBeenCalledTimes(2);
    expect(adapter.getText()).toBe('demo GOOD');
  });
});

// ─── Model blank routing — shapes drift-pinned to the SHIPPED BLANK.md ────
//
// The `model` blank's trigger grammar lives in defaults/blanks/model/BLANK.md
// (`blankShapes`). These journeys load that REAL file (not an inline copy),
// so editing the shipped shapes and forgetting the routing contract fails
// here — the same drift-pin idea as the registry tests. "model" is a common
// English word, so the negative case (prose mentioning "model" must NOT
// claim `_`) is as load-bearing as the positives.
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

describe('model blank routing (shapes from defaults/blanks/model/BLANK.md)', () => {
  const REPO_ROOT = resolvePath(__dirname, '../../../..');
  const MODEL_MD = readFileSync(resolvePath(REPO_ROOT, 'defaults/blanks/model/BLANK.md'), 'utf8');
  const DICTIONARY_MD = readFileSync(resolvePath(REPO_ROOT, 'defaults/blanks/dictionary/BLANK.md'), 'utf8');

  async function modelSetup(opts: { stdout?: string; withDictionary?: boolean } = {}) {
    const files: Record<string, string> = {
      '/mock/CUES.md': TIPS,
      '/proj/blanks/model/BLANK.md': MODEL_MD,
    };
    if (opts.withDictionary) files['/proj/blanks/dictionary/BLANK.md'] = DICTIONARY_MD;
    // 'blank-invoke' capability: both blanks are runtime-hoisted
    // (no blankScript) — the registry IS the implementation.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files,
      capabilities: [
        'render-override', 'dim-ranges', 'highlight-range',
        'file-read', 'file-write', 'force-render', 'change-source',
        'blank-invoke',
      ],
    });
    adapter.stubBlankInvoke('model:get', opts.stdout ?? 'cerebras · gpt-oss-120b');
    if (opts.withDictionary) adapter.stubBlankInvoke('dictionary:get', 'model: a system or thing used as an example');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    return { adapter };
  }

  it('"whats my model _" routes to the model blank with keyword `model`', async () => {
    const { adapter } = await modelSetup();
    adapter.pushText('whats my model _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.blankInvokeCalls.length).toBe(1);
    expect(adapter.blankInvokeCalls[0]).toMatchObject({ blankName: 'model', action: 'get' });
    expect(adapter.blankInvokeCalls[0].args[0]).toBe('model');
    // Full question captured → span consumed → the answer stands alone.
    expect(adapter.getText()).toBe('cerebras · gpt-oss-120b');
  });

  it('"model _" bare trigger routes', async () => {
    const { adapter } = await modelSetup();
    adapter.pushText('model _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.blankInvokeCalls.length).toBe(1);
    expect(adapter.blankInvokeCalls[0]).toMatchObject({ blankName: 'model', action: 'get' });
  });

  it('"list models _" dispatches keyword `models` (catalog mode)', async () => {
    const { adapter } = await modelSetup({ stdout: 'cerebras (current): gpt-oss-120b*' });
    adapter.pushText('list models _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.blankInvokeCalls.length).toBe(1);
    expect(adapter.blankInvokeCalls[0]).toMatchObject({ blankName: 'model', action: 'get' });
    // Mode discrimination: the MATCHED keyword is `models`, not `model`.
    expect(adapter.blankInvokeCalls[0].args[0]).toBe('models');
  });

  it('"model for cues _" captures the bucket as context', async () => {
    const { adapter } = await modelSetup({ stdout: 'cues: groq · openai/gpt-oss-120b' });
    adapter.pushText('model for cues _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.blankInvokeCalls.length).toBe(1);
    expect(adapter.blankInvokeCalls[0]).toMatchObject({ blankName: 'model', action: 'get', args: ['model', 'cues'] });
  });

  it('prose mentioning "model" does NOT claim the blank (shape-gated)', async () => {
    const { adapter } = await modelSetup();
    adapter.pushText('the model returned garbage _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.blankInvokeCalls.length).toBe(0);
    expect(adapter.getText()).toBe('the model returned garbage _');
  });

  it('prior sentence survives: only the question segment is consumed', async () => {
    const { adapter } = await modelSetup();
    adapter.pushText('hii world. whats my model _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.getText()).toBe('hii world. cerebras · gpt-oss-120b');
  });

  it('"what is my model _" routes to model, not the dictionary "what is" keyword', async () => {
    const { adapter } = await modelSetup({ withDictionary: true });
    adapter.pushText('what is my model _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.blankInvokeCalls.length).toBe(1);
    expect(adapter.blankInvokeCalls[0]).toMatchObject({ blankName: 'model' });
  });

  it('dictionary keeps ordinary "what is" lookups when both are registered', async () => {
    const { adapter } = await modelSetup({ withDictionary: true });
    adapter.pushText('what is serendipity _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.blankInvokeCalls.length).toBe(1);
    expect(adapter.blankInvokeCalls[0]).toMatchObject({ blankName: 'dictionary' });
  });
});
