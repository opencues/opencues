import { describe, expect, it, vi } from 'vitest';
import { BlankFill } from './blank-fill';
import { ConfigLoader } from './config-loader';
import { MockAdapter } from '../../testing/mock-adapter';

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
