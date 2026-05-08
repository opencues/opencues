import { describe, expect, it } from 'vitest';
import { Navigation, splitWords } from './navigation';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';

function setup(text: string) {
  const adapter = new MockAdapter();
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const nav = new Navigation(adapter, hlState, dynDefs);
  nav.subscribe();
  return { adapter, hlState, dynDefs, nav };
}

describe('splitWords', () => {
  it('finds word spans in whitespace-separated text', () => {
    const words = splitWords('hello  world foo');
    expect(words).toEqual([
      { start: 0, end: 5, word: 'hello', index: 0 },
      { start: 7, end: 12, word: 'world', index: 1 },
      { start: 13, end: 16, word: 'foo', index: 2 },
    ]);
  });
  it('empty string returns empty', () => {
    expect(splitWords('')).toEqual([]);
  });
});

describe('Navigation.onTextChange DynDef pruning', () => {
  // Pins the fix for "user deletes words but the span/dim stays".
  // Stale DynDefs at positions where the word has changed must be
  // dropped on text change; fresh ones (unchanged word OR mid-cycle
  // alt at that position) must survive to avoid the dim-flash.

  it('keeps DynDefs whose originalWord matches the current word', () => {
    const { adapter, dynDefs } = setup('alpha beta');
    dynDefs.set(0, { originalWord: 'alpha', alternatives: ['alpha', 'a1'], currentIndex: 0, spanStart: 0, spanEnd: 5 });
    dynDefs.set(1, { originalWord: 'beta',  alternatives: ['beta', 'b1'],  currentIndex: 0, spanStart: 6, spanEnd: 10 });
    adapter.pushText('alpha beta foo'); // append a word; originals unchanged
    expect(dynDefs.get(0)).toBeDefined();
    expect(dynDefs.get(1)).toBeDefined();
  });

  it('keeps DynDefs whose current alt is the word at that position (mid-cycle)', () => {
    const { adapter, dynDefs } = setup('quick');
    dynDefs.set(0, { originalWord: 'fast', alternatives: ['fast', 'quick'], currentIndex: 1, spanStart: 0, spanEnd: 5 });
    adapter.pushText('quick more'); // user typed after cycled word
    expect(dynDefs.get(0)).toBeDefined();
  });

  it('keeps DynDefs for multi-word alts (matches first word)', () => {
    const { adapter, dynDefs } = setup('legal eagle filed');
    // cycled attorney → legal eagle at index 0
    dynDefs.set(0, {
      originalWord: 'attorney',
      alternatives: ['attorney', 'lawyer', 'legal eagle'],
      currentIndex: 2,
      spanStart: 0, spanEnd: 11,
    });
    adapter.pushText('legal eagle filed today'); // appends, span intact
    expect(dynDefs.get(0)).toBeDefined();
  });

  it('drops DynDefs whose word has been deleted from that position', () => {
    const { adapter, dynDefs } = setup('alpha beta');
    dynDefs.set(0, { originalWord: 'alpha', alternatives: ['alpha', 'a1'], currentIndex: 0, spanStart: 0, spanEnd: 5 });
    dynDefs.set(1, { originalWord: 'beta',  alternatives: ['beta', 'b1'],  currentIndex: 0, spanStart: 6, spanEnd: 10 });
    adapter.pushText('alpha'); // deleted 'beta'
    expect(dynDefs.get(0)).toBeDefined();
    expect(dynDefs.get(1)).toBeUndefined();
  });

  it('drops DynDefs at positions whose word has been replaced', () => {
    const { adapter, dynDefs } = setup('alpha beta');
    dynDefs.set(0, { originalWord: 'alpha', alternatives: ['alpha', 'a1'], currentIndex: 0, spanStart: 0, spanEnd: 5 });
    adapter.pushText('zebra beta'); // replaced alpha with zebra
    expect(dynDefs.get(0)).toBeUndefined();
  });

  it('drops all DynDefs when buffer is emptied', () => {
    const { adapter, dynDefs } = setup('alpha');
    dynDefs.set(0, { originalWord: 'alpha', alternatives: ['alpha', 'a1'], currentIndex: 0, spanStart: 0, spanEnd: 5 });
    adapter.pushText('');
    expect(dynDefs.get(0)).toBeUndefined();
  });

  it('leaves DynDefs alone on runtime-origin text changes (cycling setText)', () => {
    const { adapter, dynDefs } = setup('alpha');
    dynDefs.set(0, { originalWord: 'alpha', alternatives: ['alpha', 'a1'], currentIndex: 0, spanStart: 0, spanEnd: 5 });
    // setText fires with source='runtime' (cycling path); pushText
    // fires with source='user' (mimicking a keystroke). Pruning
    // should only run on user-source events.
    adapter.setText('beta');
    expect(dynDefs.get(0)).toBeDefined(); // not pruned — source !== 'user'
  });
});

describe('Navigation', () => {
  it('first Ctrl+Alt+Left activates and lands on rightmost word', () => {
    const { adapter, hlState } = setup('alpha beta gamma');
    const consumed = adapter.fireKey('left', { ctrl: true, alt: true });
    expect(consumed).toBe(true);
    expect(hlState.active).toBe(true);
    expect(hlState.wordIndex).toBe(2); // gamma
    expect(adapter.forceRenderCalls).toBe(1);
  });

  it('successive Ctrl+Alt+Left walks left without wrap', () => {
    const { adapter, hlState } = setup('alpha beta gamma');
    adapter.fireKey('left', { ctrl: true, alt: true });
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.wordIndex).toBe(1); // beta
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.wordIndex).toBe(0); // alpha
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.wordIndex).toBe(0); // clamps — no wrap
  });

  it('Ctrl+Alt+Right from rightmost deactivates', () => {
    const { adapter, hlState } = setup('alpha beta gamma');
    adapter.fireKey('left', { ctrl: true, alt: true }); // activate at gamma
    expect(hlState.active).toBe(true);
    adapter.fireKey('right', { ctrl: true, alt: true }); // step right from gamma → deactivate
    expect(hlState.active).toBe(false);
  });

  it('Ctrl+Alt+Right steps back right', () => {
    const { adapter, hlState } = setup('alpha beta gamma');
    adapter.fireKey('left', { ctrl: true, alt: true });
    adapter.fireKey('left', { ctrl: true, alt: true }); // at beta
    adapter.fireKey('right', { ctrl: true, alt: true }); // back to gamma
    expect(hlState.wordIndex).toBe(2);
    expect(hlState.active).toBe(true);
  });

  it('does nothing on empty text', () => {
    const { adapter, hlState } = setup('   ');
    const consumed = adapter.fireKey('left', { ctrl: true, alt: true });
    expect(consumed).toBe(false);
    expect(hlState.active).toBe(false);
  });

  it('ignores arrows without Ctrl+Alt modifiers', () => {
    const { adapter, hlState } = setup('alpha beta');
    const consumed = adapter.fireKey('left', {});
    expect(consumed).toBe(false);
    expect(hlState.active).toBe(false);
  });

  it('forceRender is called on each navigation step', () => {
    const { adapter } = setup('alpha beta gamma');
    adapter.fireKey('left', { ctrl: true, alt: true });
    adapter.fireKey('left', { ctrl: true, alt: true });
    adapter.fireKey('right', { ctrl: true, alt: true });
    expect(adapter.forceRenderCalls).toBe(3);
  });

  it('unsubscribe detaches handlers', () => {
    const { adapter, nav, hlState } = setup('alpha beta');
    nav.unsubscribe();
    const consumed = adapter.fireKey('left', { ctrl: true, alt: true });
    expect(consumed).toBe(false);
    expect(hlState.active).toBe(false);
  });

  it('user typing clears highlight + dynDefs', () => {
    const { adapter, hlState, nav } = setup('alpha beta');
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.active).toBe(true);

    // Simulate user typing — pushText fires onTextChange with source: 'user'
    adapter.pushText('alpha betas');
    expect(hlState.active).toBe(false);
    void nav;
  });

  it('runtime-source text changes do NOT clear highlight', () => {
    const { adapter, hlState } = setup('alpha beta');
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.active).toBe(true);

    // setText (runtime source) — must not deactivate
    adapter.setText('alpha betax');
    expect(hlState.active).toBe(true);
  });
});

describe('Navigation cue filtering (Bucket B)', () => {
  const TIPS = wrapTipsAsCuesMd({
    domain: 't', version: 1,
    concepts: [{ id: 'a', words: { volume: { tip: 'V', alts: [] }, brightness: { tip: 'B', alts: [] } } }],
  });

  async function setupWithCues(text: string) {
    const { ConfigLoader } = await import('./config-loader');
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    adapter.pushText(text);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const nav = new Navigation(adapter, hlState, dynDefs, loader);
    nav.subscribe();
    return { adapter, hlState, dynDefs, loader, nav };
  }

  it('Ctrl+Alt+Left lands on cue-mapped word, skipping non-mapped neighbours', async () => {
    const { adapter, hlState } = await setupWithCues('raise volume now');
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.active).toBe(true);
    expect(hlState.wordIndex).toBe(1); // "volume"
  });

  it('with two cue-mapped words, walks between them only', async () => {
    const { adapter, hlState } = await setupWithCues('set volume and brightness now');
    // splitWords gives: set(0) volume(1) and(2) brightness(3) now(4)
    // cue-mapped indices: [1, 3]
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.wordIndex).toBe(3); // brightness (rightmost target)
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.wordIndex).toBe(1); // volume (next left target)
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.wordIndex).toBe(1); // clamps at first target
  });

  it('does nothing when no word has cues or DynDefs', async () => {
    // No cue-mapped words, no DynDefs → no targets → navigation is a
    // no-op. (Previously fell back to all words, but that let users
    // hop between plain text even though Up/Down had nothing to cycle.
    // Silence > pointless navigation.)
    const { adapter, hlState } = await setupWithCues('alpha beta gamma');
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.active).toBe(false);
    expect(hlState.wordIndex).toBeNull();
  });

  it('DynDefs entries also count as targets even without cueMap match', async () => {
    const { adapter, hlState, dynDefs } = await setupWithCues('xyz unknown other');
    // None of these are in cueMap. Pre-populate DynDefs entry for index 1.
    dynDefs.set(1, {
      originalWord: 'unknown',
      alternatives: ['unknown', 'sub'],
      currentIndex: 0,
      spanStart: 4,
      spanEnd: 11,
    });
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.wordIndex).toBe(1); // unknown — DynDef makes it navigable
  });
});

describe('Navigation span-fill filter (Phase F.a / Step 33)', () => {
  it('skips inner span positions; treats span as one nav stop', async () => {
    const { SpanFillState } = await import('../state/span-fill');
    const adapter = new MockAdapter();
    adapter.pushText('affirm I am strong');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const span = new SpanFillState();
    span.set({ index: 1, alternatives: ['I am strong', 'I am brave'], currentAltIndex: 0, spanLength: 3 }, 'affirm I am strong');
    const nav = new Navigation(adapter, hlState, dynDefs, undefined, span);
    nav.subscribe();
    adapter.fireKey('left', { ctrl: true, alt: true });
    // Without span: rightmost = "strong" at index 3. With span: spans collapse
    // to the origin = index 1.
    expect(hlState.wordIndex).toBe(1);
    adapter.fireKey('left', { ctrl: true, alt: true });
    // Step left from origin: lands on "affirm" at index 0.
    expect(hlState.wordIndex).toBe(0);
  });

  it('span origin is force-included even when not in cueMap', async () => {
    const { ConfigLoader } = await import('./config-loader');
    const { SpanFillState } = await import('../state/span-fill');
    const adapter = new MockAdapter({
      files: { '/tips.json': JSON.stringify({ domain: 't', version: 1, concepts: [] }) },
    });
    adapter.pushText('foo bar baz qux');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const span = new SpanFillState();
    span.set({ index: 1, alternatives: ['bar baz', 'other text'], currentAltIndex: 0, spanLength: 2 }, 'foo bar baz qux');
    const nav = new Navigation(adapter, hlState, dynDefs, loader, span);
    expect(nav.computeTargets(splitWords('foo bar baz qux'))).toEqual([0, 1, 3]);
  });
});
