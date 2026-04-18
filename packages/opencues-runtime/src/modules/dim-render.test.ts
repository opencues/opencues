import { describe, expect, it } from 'vitest';
import { DimRender } from './dim-render';
import { Navigation } from './navigation';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { MockAdapter } from '../../testing/mock-adapter';
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
    expect(out).toBe(`alpha beta \x1b[7mgamma\x1b[27m`);
  });

  it('Step 32: dims the consume-all span as a single contiguous range', () => {
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

  it('Phase F.a: active word inside span expands highlight to whole span; no inner dim', () => {
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

  it('Step 32: no consume-all dim when state is empty', () => {
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
