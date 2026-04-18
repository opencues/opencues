import { describe, expect, it, beforeEach } from 'vitest';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { Navigation } from './navigation';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { DismissedBlanks } from '../state/dismissed-blanks';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({
  domain: 'test',
  version: 1,
  concepts: [
    {
      id: 'words',
      words: {
        fast: { tip: '', alts: ['quick', 'rapid', 'swift'] },
        big: { tip: '', alts: ['large', 'huge'] },
      },
    },
  ],
});

async function setup(text: string) {
  const adapter = new MockAdapter({ files: { '/tips.json': TIPS } });
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
  await loader.load();
  const cycling = new Cycling(adapter, hlState, dynDefs, loader);
  cycling.subscribe();
  const nav = new Navigation(adapter, hlState, dynDefs);
  nav.subscribe();
  return { adapter, hlState, dynDefs, loader, cycling, nav };
}

describe('Cycling', () => {
  it('does nothing when highlight inactive', async () => {
    const { adapter } = await setup('fast slow');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('Ctrl+Alt+Up replaces highlighted word with first alternative', async () => {
    const { adapter, hlState, dynDefs } = await setup('fast slow');
    hlState.activate(0, 'fast slow'); // fast
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('quick slow');
    const def = dynDefs.get(0);
    expect(def?.currentIndex).toBe(1); // alt 0 is original "fast", alt 1 is first cycle
    expect(def?.spanEnd).toBe(5); // "quick" is 5 chars
  });

  it('successive Up cycles through all alternatives and wraps', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → quick
    adapter.fireKey('up', { ctrl: true, alt: true }); // → rapid
    adapter.fireKey('up', { ctrl: true, alt: true }); // → swift
    adapter.fireKey('up', { ctrl: true, alt: true }); // → fast (wrap)
    expect(adapter.setTextCalls).toEqual(['quick', 'rapid', 'swift', 'fast']);
  });

  it('Ctrl+Alt+Down goes the other direction', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    adapter.fireKey('down', { ctrl: true, alt: true }); // → swift (last)
    expect(adapter.setTextCalls.at(-1)).toBe('swift');
  });

  it('returns false when word has no alternatives in cue map', async () => {
    const { adapter, hlState } = await setup('xyz unknown');
    hlState.activate(0, 'xyz unknown');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
  });

  it('cursor adjustment: cursor before word stays put', async () => {
    const { adapter, hlState } = await setup('fast slow');
    adapter.setCursorOffset(0);
    hlState.activate(0, 'fast slow');
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast → quick (+1 char)
    expect(adapter.setCursorCalls.at(-1)).toBe(0); // cursor at 0 unchanged
  });

  it('cursor adjustment: cursor after word shifts by lenDiff', async () => {
    const { adapter, hlState } = await setup('fast slow');
    adapter.setCursorOffset(8); // after "fast slow"[start of slow + 'slo'] - past 'fast'
    hlState.activate(0, 'fast slow');
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast (4) → quick (5), +1
    expect(adapter.setCursorCalls.at(-1)).toBe(9);
  });

  it('forceRender called after cycle', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    expect(adapter.forceRenderCalls).toBe(0);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.forceRenderCalls).toBe(1);
  });

  it('Navigation + Cycling: Ctrl+Alt+Left then Up cycles the active word', async () => {
    const { adapter, hlState } = await setup('big fast');
    adapter.fireKey('left', { ctrl: true, alt: true }); // activate rightmost: fast (idx 1)
    expect(hlState.wordIndex).toBe(1);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('big quick');
  });
});

describe('Cycling consume-all (Step 31)', () => {
  async function setupCa(initialText: string) {
    const adapter = new MockAdapter({ files: { '/tips.json': TIPS } });
    adapter.pushText(initialText);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const consumeAll = new SpanFillState();
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, consumeAll);
    cycling.subscribe();
    return { adapter, hlState, consumeAll, cycling };
  }

  it('cycles forward through stashed alternatives', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Improved two version', 'Final three'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('Improved two version');
    expect(consumeAll.current?.currentAltIndex).toBe(1);
    expect(consumeAll.current?.spanLength).toBe(3);
  });

  it('cycles backward (Ctrl+Alt+Down)', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Improved two version', 'Final three'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    expect(adapter.fireKey('down', { ctrl: true, alt: true })).toBe(true);
    // Wraps from 0 down to 2 (last alt)
    expect(adapter.setTextCalls.at(-1)).toBe('Final three');
    expect(consumeAll.current?.currentAltIndex).toBe(2);
  });

  it('only cycles when highlight is within the consumed span', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one outside word');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Other version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one outside word');
    // Word index 3 ("word") is outside the span [0, 2)
    hlState.activate(3, 'Improved one outside word');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('updates lastFilledText so post-cycle text changes do not invalidate', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Other version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(consumeAll.lastFilledText).toBe('Other version');
    expect(consumeAll.current).not.toBeNull();
  });

  it('Phase F.b: cycling to `_` adds slot to DismissedBlanks; cycling away removes it', async () => {
    const adapter = new MockAdapter({ files: { '/tips.json': TIPS } });
    adapter.pushText('foo');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const span = new SpanFillState();
    const dismissed = new DismissedBlanks();
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, span, dismissed);
    cycling.subscribe();
    span.set({
      index: 0,
      alternatives: ['foo', 'bar', '_'],
      currentAltIndex: 0,
      spanLength: 1,
    }, 'foo');
    hlState.activate(0, 'foo');
    // Cycle 0→1: foo → bar (not `_`)
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(false);
    // Cycle 1→2: bar → `_`
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(true);
    // Cycle 2→0: `_` → foo
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(false);
  });

  it('does nothing when there is only one alternative', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Lone version');
    consumeAll.set({
      index: 0,
      alternatives: ['Lone version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Lone version');
    hlState.activate(0, 'Lone version');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
  });
});
