import { describe, expect, it } from 'vitest';
import { Navigation, splitWords } from './navigation';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

function setup(text: string) {
  const adapter = new MockAdapter();
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const nav = new Navigation(adapter, hlState, dynDefs);
  nav.subscribe();
  return { adapter, hlState, nav };
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
  const TIPS = JSON.stringify({
    domain: 't', version: 1,
    concepts: [{ id: 'a', words: { volume: { tip: 'V', alts: [] }, brightness: { tip: 'B', alts: [] } } }],
  });

  async function setupWithCues(text: string) {
    const { ConfigLoader } = await import('./config-loader');
    const adapter = new MockAdapter({ files: { '/tips.json': TIPS } });
    adapter.pushText(text);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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

  it('falls back to all words when no cue-mapped words present', async () => {
    const { adapter, hlState } = await setupWithCues('alpha beta gamma');
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.active).toBe(true);
    expect(hlState.wordIndex).toBe(2); // gamma — fallback to all words, rightmost
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
