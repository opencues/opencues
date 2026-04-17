import { describe, expect, it, beforeEach } from 'vitest';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { Navigation } from './navigation';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
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
