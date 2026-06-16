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

  it('honours blankProximity: prompt requires keyword adjacent to _', async () => {
    // "prompt for image _" — keyword "prompt" is 2 words away (> 0). No match.
    const { bf } = await setup('prompt for image _');
    expect(bf.scan('prompt for image _')).toHaveLength(0);
    // Same setup but adjacent — "prompt _" → matches.
    expect(bf.scan('prompt _')).toHaveLength(1);
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
  it('replaces single-word keyword with expansion when given', () => {
    const r = buildClearKeywordText('rddt _', { index: 1, keywordStart: 0, keywordEnd: 0 }, '$180.50', 'Reddit');
    expect(r.newText).toBe('Reddit $180.50');
    expect(r.newCursor).toBe(14);
  });
  it('collapses multi-word keyword span into single expansion entry', () => {
    const r = buildClearKeywordText('big tech _', { index: 2, keywordStart: 0, keywordEnd: 1 }, '$100', 'BigTech');
    expect(r.newText).toBe('BigTech $100');
  });
  it('expansion preserves context words after keyword', () => {
    const r = buildClearKeywordText('hn for today _', { index: 3, keywordStart: 0, keywordEnd: 0 }, 'Story', 'HackerNews');
    expect(r.newText).toBe('HackerNews for today Story');
  });
  it('clearEnd widens to slot.index-1 (consumes context)', () => {
    const r = buildClearKeywordText(
      'what is the word for happy _',
      { index: 6, keywordStart: 0, keywordEnd: 4 },
      'glad',
      undefined,
      5, // slot.index - 1
    );
    expect(r.newText).toBe('glad');
  });
  it('trailing words after blank are kept', () => {
    const r = buildClearKeywordText(
      'how to say hi _ to her',
      { index: 4, keywordStart: 0, keywordEnd: 2 },
      'hello',
      undefined,
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
  it('blankConsumeContext sets clearEnd = slot.index - 1', () => {
    const r = computeFillRange({ blankConsumeContext: true }, slot);
    expect(r).toEqual({ clearEnd: 5, expansion: undefined });
  });
  it('blankClearKeywords alone sets clearEnd = slot.keywordEnd', () => {
    const r = computeFillRange({ blankClearKeywords: true }, slot);
    expect(r).toEqual({ clearEnd: 4, expansion: undefined });
  });
  it('expansion only sets expansion, no clearEnd widening', () => {
    const r = computeFillRange(
      { blankKeywordExpansions: { 'what is the word for': 'WORD' } },
      slot,
    );
    expect(r).toEqual({ clearEnd: undefined, expansion: 'WORD' });
  });
  it('blankConsumeContext suppresses expansion', () => {
    const r = computeFillRange(
      {
        blankConsumeContext: true,
        blankKeywordExpansions: { 'what is the word for': 'WORD' },
      },
      slot,
    );
    expect(r).toEqual({ clearEnd: 5, expansion: undefined });
  });
  it('clearKeywords + consumeContext together: consumeContext wins', () => {
    const r = computeFillRange(
      { blankClearKeywords: true, blankConsumeContext: true },
      slot,
    );
    expect(r.clearEnd).toBe(5); // = slot.index - 1, not 4
  });
  it('no flags returns no-op range', () => {
    const r = computeFillRange({}, slot);
    expect(r).toEqual({ clearEnd: undefined, expansion: undefined });
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

  it('async path: builds CUES_* env vars from blank config', async () => {
    // opencues-core's parseSingleCueMd reads `## Extract` / `## Transform`
    // markdown sections into blanks.X.prompts (NOT a YAML `prompts:` key).
    const SCRIPT_CTRL = `---
type: blank
name: prompt
blankKeywords: prompt
blankProximity: 10
blankScript: ./prompt.sh
model: openai/gpt-4
apiUrl: https://example.com
apiKeyEnv: TEST_KEY
altCount: 3
includeOriginal: true
---

## Classifier

classify this

## Alt-Gen

generate alts
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/prompt/BLANK.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('prompt _');
    const env = spawnSpy.mock.calls[0][0].env;
    expect(env).toBeDefined();
    expect(env!.CUES_MODEL).toBe('openai/gpt-4');
    expect(env!.CUES_API_URL).toBe('https://example.com');
    expect(env!.CUES_API_KEY_ENV).toBe('TEST_KEY');
    expect(env!.CUES_ALT_COUNT).toBe('3');
    expect(env!.CUES_INCLUDE_ORIGINAL).toBe('true');
    expect(env!.CUES_PROMPT_CLASSIFIER).toBe('classify this');
    expect(env!.CUES_PROMPT_ALT_GEN).toBe('generate alts');
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

  it('async path: blankClearKeywords applies after script result splices in', async () => {
    const CLR_CTRL = `---
type: blank
name: weather
blankKeywords: weather
blankProximity: 10
blankScript: ./weather.sh
blankClearKeywords: true
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
    adapter.pushText('weather in Paris _');
    await new Promise(r => setTimeout(r, 0));
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    // Latest pushText call should reflect the cleared keyword.
    expect(adapter.getText()).toBe('in Paris 15°C cloudy');
  });

  it('async path: no clear when blankClearKeywords is unset (existing behaviour preserved)', async () => {
    const PLAIN = `---
type: blank
name: weather2
blankKeywords: weather
blankProximity: 10
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
    adapter.pushText('weather in Paris _');
    await new Promise(r => setTimeout(r, 0));
    // Keyword preserved; only `_` is replaced. Splice path keeps original spacing.
    expect(adapter.getText()).toBe('weather in Paris 15°C cloudy');
  });

  it('sync path: blankKeywordExpansions replaces short-form keyword with long form', async () => {
    const EXP_CTRL = `---
type: blank
name: greeting
blankKeywords: hi
blankProximity: 10
stepValues: ["world"]
blankKeywordExpansions.hi: Hello
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/greeting/BLANK.md': EXP_CTRL },
    });
    adapter.pushText('hi ');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('hi ', 3))).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('Hello world');
  });

  it('sync path: blankClearKeywords wins when both clear + expansion are set', async () => {
    const BOTH = `---
type: blank
name: bye
blankKeywords: bye
blankProximity: 10
stepValues: ["see ya"]
blankClearKeywords: true
blankKeywordExpansions.bye: Goodbye
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
    // Goodbye is suppressed because clear wins.
    expect(adapter.setTextCalls.at(-1)).toBe('see ya');
  });

  it('async path: blankKeywordExpansions applies after script result', async () => {
    const EXP_CTRL = `---
type: blank
name: stocks
blankKeywords: rddt
blankProximity: 10
blankScript: ./stocks.sh
blankKeywordExpansions.rddt: Reddit
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/stocks/BLANK.md': EXP_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: '$180.50', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('rddt _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.getText()).toBe('Reddit $180.50');
  });

  it('async path: blankConsumeContext drops keyword and context words around the blank', async () => {
    const ANSWER_CTRL = `---
type: blank
name: answer
blankKeywords: how to say
blankProximity: 10
blankScript: ./answer.sh
blankConsumeContext: true
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/answer/BLANK.md': ANSWER_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'glad', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('how to say happy _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.getText()).toBe('glad');
  });

  it('sync path: blankConsumeContext drops keyword and context words around the blank', async () => {
    const CTX_CTRL = `---
type: blank
name: ctxsync
blankKeywords: how to say
blankProximity: 10
stepValues: ["hi"]
blankConsumeContext: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/ctxsync/BLANK.md': CTX_CTRL },
    });
    adapter.pushText('how to say hello ');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('how to say hello ', 17))).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('hi');
  });

  it('async path: blankConsumeAll replaces entire input with first stdout line', async () => {
    const PROMPT_CTRL = `---
type: blank
name: prompt
blankKeywords: improve prompt
blankProximity: 10
blankScript: ./prompt.sh
blankConsumeAll: true
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/prompt/BLANK.md': PROMPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const consumeAll = new SpanFillState();
    const bf = new BlankFill(adapter, loader, consumeAll);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({
        exitCode: 0,
        stdout: 'Improved version one\nImproved version two\nImproved version three\n',
        stderr: '',
        timedOut: false,
      }),
      kill: () => {},
    }));
    adapter.pushText('improve prompt write code _');
    await new Promise(r => setTimeout(r, 0));
    // First line replaces ALL — keyword/context all gone.
    expect(adapter.getText()).toBe('Improved version one');
    // Stash carries 3 alternatives starting at currentAltIndex 0.
    expect(consumeAll.current).toMatchObject({
      index: 0,
      alternatives: ['Improved version one', 'Improved version two', 'Improved version three'],
      currentAltIndex: 0,
      spanLength: 3,
    });
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

  it('async path: blankConsumeAll via blankInvoke replaces input and stashes alts (chrome path)', async () => {
    // Pins the chrome prompt-improver path: a sandboxed host
    // (blankInvoke, no spawnProcess) MUST get the same consume-all
    // behaviour as the shell-spawn path. Regression guard for
    // "improve prompt resolves to original word" + "spans break on
    // multi-word fills" — both happened when the runtime didn't reach
    // the consume-all branch under blankInvoke routing.
    const PROMPT_CTRL = `---
type: blank
name: prompt
blankKeywords: improve prompt
blankProximity: 10
blankScript: ./prompt.sh
blankConsumeAll: true
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/prompt/BLANK.md': PROMPT_CTRL },
    });
    adapter.stubBlankInvoke(
      'prompt:get',
      'Improved version one\nImproved version two\nImproved version three\n',
    );
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const consumeAll = new SpanFillState();
    const bf = new BlankFill(adapter, loader, consumeAll);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('improve prompt write code _');
    await new Promise(r => setTimeout(r, 0));
    // Sandboxed host: blankInvoke wins, spawnProcess never called.
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(adapter.blankInvokeCalls.length).toBe(1);
    // Buffer replaced with first alt.
    expect(adapter.getText()).toBe('Improved version one');
    // Span fill stashed with all three alts so cycling Up/Down rotates them.
    expect(consumeAll.current).toMatchObject({
      index: 0,
      alternatives: ['Improved version one', 'Improved version two', 'Improved version three'],
      currentAltIndex: 0,
      spanLength: 3,
    });
  });

  it('async path: blankConsumeAll with single-line stdout fills but does not stash', async () => {
    const PROMPT_CTRL = `---
type: blank
name: prompt
blankKeywords: improve prompt
blankProximity: 10
blankScript: ./prompt.sh
blankConsumeAll: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/prompt/BLANK.md': PROMPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const consumeAll = new SpanFillState();
    const bf = new BlankFill(adapter, loader, consumeAll);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'lone improvement', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('improve prompt foo _');
    await new Promise(r => setTimeout(r, 0));
    expect(adapter.getText()).toBe('lone improvement');
    expect(consumeAll.current).toBeNull();
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
blankTip: Daily affirmations
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
    expect(span.current?.blankTip).toBe('Daily affirmations');
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
blankTip: Hacker News
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
    expect(span.current?.blankTip).toBe('Hacker News');
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
    // Surround the keyword with text on both sides.
    adapter.pushText('before cfg _ after');
    await new Promise(r => setTimeout(r, 0));
    // Keyword stays (no blankClearKeywords), pair filled.
    expect(adapter.getText()).toBe('before cfg voice-mode active after');
    // User edits inside pair (capital E).
    adapter.pushText('before cfg voicE-mode active after');
    // Pair removed; "before cfg " and " after" preserved.
    expect(adapter.getText()).toBe('before cfg  after');
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

  it('span-fill invalidation: user editing the consume-all text clears the stash', async () => {
    const PROMPT_CTRL = `---
type: blank
name: prompt
blankKeywords: improve prompt
blankProximity: 10
blankScript: ./prompt.sh
blankConsumeAll: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/prompt/BLANK.md': PROMPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const consumeAll = new SpanFillState();
    const bf = new BlankFill(adapter, loader, consumeAll);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({
        exitCode: 0,
        stdout: 'first alt\nsecond alt\nthird alt',
        stderr: '',
        timedOut: false,
      }),
      kill: () => {},
    }));
    adapter.pushText('improve prompt foo _');
    await new Promise(r => setTimeout(r, 0));
    expect(consumeAll.current).not.toBeNull();
    // User types something — text differs from lastFilledText.
    adapter.pushText('first alt edited');
    expect(consumeAll.current).toBeNull();
  });

  it('span-fill invalidation: matching text (e.g. after a cycle) keeps the stash', async () => {
    const PROMPT_CTRL = `---
type: blank
name: prompt
blankKeywords: improve prompt
blankProximity: 10
blankScript: ./prompt.sh
blankConsumeAll: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/prompt/BLANK.md': PROMPT_CTRL },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const consumeAll = new SpanFillState();
    const bf = new BlankFill(adapter, loader, consumeAll);
    bf.subscribe();
    vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'first\nsecond', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    adapter.pushText('improve prompt foo _');
    await new Promise(r => setTimeout(r, 0));
    // Simulate Cycling updating lastFilledText then pushing matching text.
    consumeAll.set(consumeAll.current, 'second');
    adapter.pushText('second');
    expect(consumeAll.current).not.toBeNull();
  });

  it('honours blankAutoPopulate: false on the blank', async () => {
    const NO_AUTO = `---
type: blank
name: noauto
blankKeywords: noauto
blankProximity: 10
stepValues: ["X"]
blankAutoPopulate: false
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/noauto/BLANK.md': NO_AUTO },
    });
    adapter.pushText('noauto ');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('noauto ', 7))).toBe(false);
    expect(adapter.setTextCalls).toHaveLength(0);
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

  // ─── blankReplace: keep | wipe | wipe-all | auto ─────────────────────
  //
  // The unified replacement-mode field. When set, overrides the legacy
  // flag path (blankConsumeAll / blankConsumeContext / blankClearKeywords).
  // `auto` applies the fluid heuristic: copula/equation/question
  // marker before `_` → keep, else → wipe.
  describe('blankReplace mode (unified replacement field)', () => {
    // Use a synthetic `demo` keyword so the test fixture doesn't
    // collide conceptually with the real claude-status blank (whose
    // keywords are "is claude down", "claude status", etc.).
    function makeBlank(replaceMode: 'keep' | 'wipe' | 'wipe-all' | 'auto'): string {
      return `---
type: blank
name: demo
blankKeywords: demo
blankProximity: 10
blankScript: ./demo.sh
blankReplace: ${replaceMode}
---
`;
    }
    const TIPS_MIN = `---
ignore: []
---

## Tips
`;
    function setup(replaceMode: 'keep' | 'wipe' | 'wipe-all' | 'auto') {
      const adapter = new MockAdapter({
        cwd: '/proj',
        files: { '/mock/CUES.md': TIPS_MIN, '/proj/blanks/demo/BLANK.md': makeBlank(replaceMode) },
      });
      const loader = new ConfigLoader(adapter);
      const bf = new BlankFill(adapter, loader);
      const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
        result: Promise.resolve({ exitCode: 0, stdout: 'OK', stderr: '', timedOut: false }),
        kill: () => {},
      }));
      return { adapter, loader, bf, spawnSpy };
    }

    it('keep: only `_` is replaced; keyword + context stays', async () => {
      const { adapter, loader, bf } = setup('keep');
      await loader.load();
      bf.subscribe();
      adapter.pushText('demo of x _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('demo of x OK');
    });

    it('wipe: keyword + context + `_` all become the answer', async () => {
      const { adapter, loader, bf } = setup('wipe');
      await loader.load();
      bf.subscribe();
      adapter.pushText('demo of x _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('OK');
    });

    it('wipe-all: entire buffer becomes the answer', async () => {
      const { adapter, loader, bf } = setup('wipe-all');
      await loader.load();
      bf.subscribe();
      adapter.pushText('hello world demo _ more text after');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('OK');
    });

    it('auto: bare keyword phrase ("demo _") → wipe', async () => {
      const { adapter, loader, bf } = setup('auto');
      await loader.load();
      bf.subscribe();
      adapter.pushText('demo _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('OK');
    });

    it('auto: copula before `_` ("demo is _") → keep', async () => {
      const { adapter, loader, bf } = setup('auto');
      await loader.load();
      bf.subscribe();
      adapter.pushText('demo is _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('demo is OK');
    });

    it('auto: every copula variant immediately before `_` → keep', async () => {
      // Exercise all copulas the heuristic recognises (is/are/was/were/
      // am/be/equals). One blank per case for isolation.
      for (const cop of ['are', 'was', 'were', 'am', 'be', 'equals']) {
        const { adapter, loader, bf } = setup('auto');
        await loader.load();
        bf.subscribe();
        adapter.pushText(`demo ${cop} _`);
        await new Promise(r => setTimeout(r, 0));
        expect(adapter.getText()).toBe(`demo ${cop} OK`);
      }
    });

    it('auto: text BEFORE the keyword stays put when bare → wipe drops keyword + context only', async () => {
      // "hello world demo _" — preceding "hello world" is NOT part
      // of the keyword/context window; only "demo _" is wiped.
      const { adapter, loader, bf } = setup('auto');
      await loader.load();
      bf.subscribe();
      adapter.pushText('hello world demo _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('hello world OK');
    });

    it('auto: text BEFORE the keyword stays put when copula → keep', async () => {
      // "hello world demo is _" — heuristic detects "is _", FILL
      // mode, only `_` is replaced.
      const { adapter, loader, bf } = setup('auto');
      await loader.load();
      bf.subscribe();
      adapter.pushText('hello world demo is _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('hello world demo is OK');
    });

    it('auto: mid-phrase "are" (not adjacent to `_`) → wipe', async () => {
      const { adapter, loader, bf } = setup('auto');
      await loader.load();
      bf.subscribe();
      // "are" appears but not adjacent to `_` → heuristic returns WIPE.
      adapter.pushText('demo reports are urgent _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('OK');
    });

    it('auto: equation marker before `_` ("demo = _") → keep', async () => {
      const { adapter, loader, bf } = setup('auto');
      await loader.load();
      bf.subscribe();
      adapter.pushText('demo = _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('demo = OK');
    });

    it('auto: question marker before `_` ("demo was what ? _") → keep', async () => {
      const { adapter, loader, bf } = setup('auto');
      await loader.load();
      bf.subscribe();
      // Use a whitespace-separated `?` so splitWords keeps the keyword
      // intact (a glued "demo?" wouldn't match the blank's keyword).
      adapter.pushText('demo was what ? _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('demo was what ? OK');
    });

    it('auto: multi-word context ("demo of x _") → wipe', async () => {
      const { adapter, loader, bf } = setup('auto');
      await loader.load();
      bf.subscribe();
      adapter.pushText('demo of x _');
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.getText()).toBe('OK');
    });

    it('explicit `blankReplace` overrides legacy `blankClearKeywords`', async () => {
      // Set both — blankReplace: keep should win even though
      // legacy clearKeywords:true would normally drop the keyword.
      const blankMd = `---
type: blank
name: demo
blankKeywords: demo
blankProximity: 10
blankScript: ./demo.sh
blankReplace: keep
blankClearKeywords: true
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
      await loader.load();
      bf.subscribe();
      adapter.pushText('demo _');
      await new Promise(r => setTimeout(r, 0));
      // keep wins → keyword stays.
      expect(adapter.getText()).toBe('demo OK');
    });
  });
});

describe('BlankFill result cache (skip spawn on repeat invocation within TTL)', () => {
  // Mirror the proven `blankReplace` block's setup pattern exactly —
  // same TIPS_MIN, same makeBlank shape, spy installed BEFORE
  // loader.load + bf.subscribe inside setup, test then awaits load +
  // subscribe.
  const TIPS_MIN = `---
ignore: []
---
`;

  function makeBlank(opts: { ttl?: number } = {}): string {
    const ttlLine = opts.ttl !== undefined ? `\nblankCacheTtlMs: ${opts.ttl}` : '';
    return `---
type: blank
name: demo
blankKeywords: demo
blankProximity: 10
blankScript: ./demo.sh
blankReplace: keep${ttlLine}
---
`;
  }

  function makeScenario(opts: { ttl?: number } = {}) {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS_MIN, '/proj/blanks/demo/BLANK.md': makeBlank(opts) },
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

  it('past TTL → spawn fires again', async () => {
    const { adapter, loader, bf, spawnSpy } = makeScenario({ ttl: 50 });
    await loader.load();
    bf.subscribe();
    adapter.pushText('demo _');
    await new Promise(r => setTimeout(r, 0));
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    await new Promise(r => setTimeout(r, 80));   // past TTL
    reArmAndPush(adapter, 'demo _');
    await new Promise(r => setTimeout(r, 0));
    expect(spawnSpy).toHaveBeenCalledTimes(2);
    expect(adapter.getText()).toBe('demo RESULT_1');
  });

  it('blankCacheTtlMs: 0 disables the cache (every call spawns)', async () => {
    const { adapter, loader, bf, spawnSpy } = makeScenario({ ttl: 0 });
    await loader.load();
    bf.subscribe();
    adapter.pushText('demo _');
    await new Promise(r => setTimeout(r, 0));
    reArmAndPush(adapter, 'demo _');
    await new Promise(r => setTimeout(r, 0));
    expect(spawnSpy).toHaveBeenCalledTimes(2);
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
