// Pins the cycling.cycled / config.reloaded / tts.spoken events that
// modules emit via adapter.emitEvent. The agentic harness consumes
// these — if the contract drifts the harness silently loses signal.

import { describe, expect, it } from 'vitest';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { TTS } from './tts';
import { Resolver } from './resolver';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

function wrapTipsAsCuesMd(tipsData: unknown): string {
  return `# tips fixture\n\n## Tips\n\`\`\`json\n${JSON.stringify(tipsData)}\n\`\`\`\n`;
}

const TIPS = wrapTipsAsCuesMd({
  domain: 'test',
  version: 1,
  concepts: [{
    id: 'words',
    words: { fast: { tip: 'pace tip', alts: ['quick', 'rapid'], speak: true } },
  }],
});

async function setupCycling(text: string) {
  const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  await loader.load();
  const cycling = new Cycling(adapter, hlState, dynDefs, loader);
  cycling.subscribe();
  return { adapter, hlState, dynDefs, loader, cycling };
}

describe('agentic events', () => {
  it('cycling.cycled fires on static-alt cycle with from/to alt index', async () => {
    const { adapter, hlState } = await setupCycling('fast slow');
    hlState.activate(0, 'fast slow');
    adapter.events.length = 0;
    adapter.fireKey('up', { ctrl: true, alt: true });
    const cycled = adapter.events.filter(e => e.type === 'cycling.cycled');
    expect(cycled).toHaveLength(1);
    expect(cycled[0].body).toMatchObject({
      wordIndex: 0,
      direction: 1,
      path: 'static-alts',
      fromAltIndex: 0,
      toAltIndex: 1,
      fromText: 'fast',
      toText: 'quick',
    });
  });

  it('config.reloaded fires after every load() with cue + blank counts', async () => {
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    adapter.events.length = 0;
    await loader.load();
    const reloads = adapter.events.filter(e => e.type === 'config.reloaded');
    expect(reloads).toHaveLength(1);
    expect(reloads[0].body).toMatchObject({
      cueEntries: 1,
      blankCount: 0,
    });
    expect(reloads[0].body).toHaveProperty('voiceMode');
    expect(reloads[0].body).toHaveProperty('tipsMode');
  });

  it('resolver.completed includes per-word routing + skipped arrays', async () => {
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    adapter.pushText('lawyer cabbage');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter);
    await loader.load();
    // Stub source list: one RoutedWordSourceGroup that claims 'lawyer'
    // for source id 'legal' and rejects everything else. Mirrors the
    // shape build-sources.ts produces.
    const fakeRoutedGroup = {
      id: 'word-cues',
      classify(word: string) {
        if (word.toLowerCase() === 'lawyer') return { id: 'legal' };
        return null;
      },
    };
    const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10,
      httpAdapter: {},
      resolverFactory: () => [fakeRoutedGroup],
    });
    resolver.subscribe();
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: unknown[] }> } })._resolver = {
      resolve: async () => ({ results: [] }),
    };
    adapter.events.length = 0;
    await resolver.resolveAndApply('lawyer cabbage');
    const ev = adapter.events.filter(e => e.type === 'resolver.completed');
    expect(ev).toHaveLength(1);
    expect(ev[0].body).toMatchObject({
      routing: [{ wordIndex: 0, word: 'lawyer', sourceId: 'legal' }],
      skipped: [{ wordIndex: 1, word: 'cabbage' }],
    });
  });

  it('tts.spoken fires via speakFn with phrase + source: lookup', async () => {
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    adapter.pushText('fast slow');
    const hlState = new HighlightState();
    hlState.activate(0, 'fast slow');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const spoken: Array<{ text: string; rate?: string }> = [];
    const tts = new TTS(adapter, hlState, new DynDefs(), loader, {
      speakFn: (text, rate) => spoken.push({ text, rate }),
    });
    adapter.events.length = 0;
    const result = tts.maybeSpeak({ text: 'fast slow', cursor: 0, externalHighlights: [] });
    expect(result).toBe('pace tip');
    expect(spoken).toHaveLength(1);
    const ev = adapter.events.filter(e => e.type === 'tts.spoken');
    expect(ev).toHaveLength(1);
    expect(ev[0].body).toMatchObject({
      phrase: 'pace tip',
      wordIndex: 0,
      displayed: 'fast',
      original: 'fast',
      source: 'lookup',
      via: 'speakFn',
    });
  });
});
