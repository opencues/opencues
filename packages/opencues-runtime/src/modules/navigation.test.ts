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
