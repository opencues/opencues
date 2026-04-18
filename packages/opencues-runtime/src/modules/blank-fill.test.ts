import { describe, expect, it, vi } from 'vitest';
import { BlankFill, buildClearKeywordText, computeFillRange } from './blank-fill';
import { ConfigLoader } from './config-loader';
import { MockAdapter } from '../../testing/mock-adapter';
import { ConsumeAllState } from '../state/consume-all';

const TIPS = JSON.stringify({ concepts: [] });

const VOLUME_CUE = `---
type: control
name: volume
control: volume
script: ./volume.sh
upArgs: ["up", "6"]
downArgs: ["down", "6"]
blankKeywords: volume, vol, sound, audio
---
`;

const AFFIRM_CUE = `---
type: control
name: affirmations
blankKeywords: affirmation, affirm
stepValues: ["I am strong", "I am brave"]
---
`;

const PROMPT_CUE = `---
type: control
name: prompt
blankKeywords: improve prompt, write prompt, prompt
blankProximity: 0
---
`;

async function setup(text: string) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: {
      '/tips.json': TIPS,
      '/proj/controls/volume/cue.md': VOLUME_CUE,
      '/proj/controls/affirmations/cue.md': AFFIRM_CUE,
      '/proj/controls/prompt/cue.md': PROMPT_CUE,
    },
  });
  adapter.pushText(text);
  const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
  await loader.load();
  const bf = new BlankFill(adapter, loader);
  bf.subscribe();
  return { adapter, loader, bf };
}

describe('BlankFill detection (Step 23)', () => {
  it('matches single-word keyword: "affirm _" → affirmations', async () => {
    const { bf } = await setup('affirm _');
    const slots = bf.scan('affirm _');
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      index: 1,
      keyword: 'affirm',
      controlName: 'affirmations',
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
      controlName: 'prompt',
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
    expect(slots.map(s => s.controlName)).toEqual(['affirmations', 'prompt']);
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
    expect(bf.scan('vol _')[0]?.controlName).toBe('volume');
    expect(bf.scan('sound _')[0]?.controlName).toBe('volume');
    expect(bf.scan('audio _')[0]?.controlName).toBe('volume');
  });

  it('case-insensitive keyword matching', async () => {
    const { bf } = await setup('Volume _');
    expect(bf.scan('Volume _')[0]?.controlName).toBe('volume');
  });

  it('subscribe re-scans on text change', async () => {
    const { adapter, bf } = await setup('hello');
    expect(bf.slots).toHaveLength(0);
    adapter.pushText('affirm _');
    expect(bf.slots).toHaveLength(1);
    expect(bf.slots[0].controlName).toBe('affirmations');
  });
});

describe('buildClearKeywordText helper (Step 27)', () => {
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
  it('Step 28: replaces single-word keyword with expansion when given', () => {
    const r = buildClearKeywordText('rddt _', { index: 1, keywordStart: 0, keywordEnd: 0 }, '$180.50', 'Reddit');
    expect(r.newText).toBe('Reddit $180.50');
    expect(r.newCursor).toBe(14);
  });
  it('Step 28: collapses multi-word keyword span into single expansion entry', () => {
    const r = buildClearKeywordText('big tech _', { index: 2, keywordStart: 0, keywordEnd: 1 }, '$100', 'BigTech');
    expect(r.newText).toBe('BigTech $100');
  });
  it('Step 28: expansion preserves context words after keyword', () => {
    const r = buildClearKeywordText('hn for today _', { index: 3, keywordStart: 0, keywordEnd: 0 }, 'Story', 'HackerNews');
    expect(r.newText).toBe('HackerNews for today Story');
  });
  it('Step 29: clearEnd widens to slot.index-1 (consumes context)', () => {
    const r = buildClearKeywordText(
      'what is the word for happy _',
      { index: 6, keywordStart: 0, keywordEnd: 4 },
      'glad',
      undefined,
      5, // slot.index - 1
    );
    expect(r.newText).toBe('glad');
  });
  it('Step 29: trailing words after blank are kept', () => {
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

describe('computeFillRange (Step 29)', () => {
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

describe('BlankFill auto-populate (Step 24)', () => {
  function makeKeyEvent(text: string, cursor: number, key = '_') {
    return {
      key,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      text,
      cursorOffset: cursor,
    };
  }

  it('replaces _ with stepValues[0] when control opts in', async () => {
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

  it('returns false when control is script-backed (no stepValues)', async () => {
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

  it('async path: blankScript get is spawned for script-backed control with no stepValues', async () => {
    const SCRIPT_CTRL = `---
type: control
name: stocks
blankKeywords: stock, ticker
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/stocks/cue.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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

  it('async path: passes context words (excluding keyword + blank)', async () => {
    const SCRIPT_CTRL = `---
type: control
name: weather
blankKeywords: weather
blankScript: ./weather.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/weather/cue.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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
type: control
name: stocks
blankKeywords: reddit stock
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/stocks/cue.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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
type: control
name: stocks
blankKeywords: stock
blankScript: ~/.claude/actions/stock.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/stocks/cue.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('stock _');
    const args = spawnSpy.mock.calls[0][0].args;
    expect(args[0]).toBe(`${process.env.HOME ?? '~'}/.claude/actions/stock.sh`);
    expect(args[0].startsWith('~')).toBe(false);
  });

  it('async path: builds CUES_* env vars from control config', async () => {
    // cues-core's parseSingleCueMd reads `## Extract` / `## Transform`
    // markdown sections into controls.X.prompts (NOT a YAML `prompts:` key).
    const SCRIPT_CTRL = `---
type: control
name: prompt
blankKeywords: prompt
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
      files: { '/tips.json': TIPS, '/proj/controls/prompt/cue.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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
type: control
name: stocks
blankKeywords: stock
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/stocks/cue.md': SCRIPT_CTRL },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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
type: control
name: cheer
blankKeywords: cheer
stepValues: ["yay"]
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/cheer/cue.md': CLR_CTRL },
    });
    adapter.pushText('cheer ');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('cheer ', 6))).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('yay');
    expect(adapter.setCursorCalls.at(-1)).toBe(3);
  });

  it('sync path: blankClearKeywords preserves context words between keyword and blank', async () => {
    const CLR_CTRL = `---
type: control
name: temp
blankKeywords: weather
stepValues: ["15°C"]
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/temp/cue.md': CLR_CTRL },
    });
    adapter.pushText('weather in Paris ');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('weather in Paris ', 17))).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('in Paris 15°C');
  });

  it('sync path: blankClearKeywords drops both words of a multi-word keyword', async () => {
    const CLR_CTRL = `---
type: control
name: greet
blankKeywords: say hello
stepValues: ["hi"]
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/greet/cue.md': CLR_CTRL },
    });
    adapter.pushText('say hello ');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('say hello ', 10))).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('hi');
  });

  it('async path: blankClearKeywords applies after script result splices in', async () => {
    const CLR_CTRL = `---
type: control
name: weather
blankKeywords: weather
blankScript: ./weather.sh
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/weather/cue.md': CLR_CTRL },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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
type: control
name: weather2
blankKeywords: weather
blankScript: ./weather.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/weather2/cue.md': PLAIN },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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
type: control
name: greeting
blankKeywords: hi
stepValues: ["world"]
blankKeywordExpansions.hi: Hello
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/greeting/cue.md': EXP_CTRL },
    });
    adapter.pushText('hi ');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('hi ', 3))).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('Hello world');
  });

  it('sync path: blankClearKeywords wins when both clear + expansion are set', async () => {
    const BOTH = `---
type: control
name: bye
blankKeywords: bye
stepValues: ["see ya"]
blankClearKeywords: true
blankKeywordExpansions.bye: Goodbye
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/bye/cue.md': BOTH },
    });
    adapter.pushText('bye ');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('bye ', 4))).toBe(true);
    // Goodbye is suppressed because clear wins.
    expect(adapter.setTextCalls.at(-1)).toBe('see ya');
  });

  it('async path: blankKeywordExpansions applies after script result', async () => {
    const EXP_CTRL = `---
type: control
name: stocks
blankKeywords: rddt
blankScript: ./stocks.sh
blankKeywordExpansions.rddt: Reddit
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/stocks/cue.md': EXP_CTRL },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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
type: control
name: answer
blankKeywords: how to say
blankScript: ./answer.sh
blankConsumeContext: true
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/answer/cue.md': ANSWER_CTRL },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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
type: control
name: ctxsync
blankKeywords: how to say
stepValues: ["hi"]
blankConsumeContext: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/ctxsync/cue.md': CTX_CTRL },
    });
    adapter.pushText('how to say hello ');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('how to say hello ', 17))).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('hi');
  });

  it('async path: blankConsumeAll replaces entire input with first stdout line', async () => {
    const PROMPT_CTRL = `---
type: control
name: prompt
blankKeywords: improve prompt
blankScript: ./prompt.sh
blankConsumeAll: true
blankClearKeywords: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/prompt/cue.md': PROMPT_CTRL },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const consumeAll = new ConsumeAllState();
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

  it('async path: blankConsumeAll with single-line stdout fills but does not stash', async () => {
    const PROMPT_CTRL = `---
type: control
name: prompt
blankKeywords: improve prompt
blankScript: ./prompt.sh
blankConsumeAll: true
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/prompt/cue.md': PROMPT_CTRL },
    });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const consumeAll = new ConsumeAllState();
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

  it('honours blankAutoPopulate: false on the control', async () => {
    const NO_AUTO = `---
type: control
name: noauto
blankKeywords: noauto
stepValues: ["X"]
blankAutoPopulate: false
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/controls/noauto/cue.md': NO_AUTO },
    });
    adapter.pushText('noauto ');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    expect(bf.onUnderscoreKey(makeKeyEvent('noauto ', 7))).toBe(false);
    expect(adapter.setTextCalls).toHaveLength(0);
  });
});
