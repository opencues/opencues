// Deferred contradiction rewrite (decision layer): the cue registers from
// decision data alone and the rewrite is fetched when the caret lands on it
// or on the press, then applied by the same cycling path as before. Journeys,
// not units: register → land → press, register → press → land, and the two
// ways it must do nothing (no rewrite, an edit in between).
import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { Cycling } from './cycling';
import { Navigation } from './navigation';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs, inlineNoteHint, inlineNoteText, rewriteIsDeferred } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({ concepts: [] });
const CUES_MD = `---
name: test-cues
domain: test
version: 1
---
`;
const TEXT = 'The zorb tests pass. Lets add the quark package for caching. Standup moves to ten.';
const SENTENCE = 'Lets add the quark package for caching.';
const START = TEXT.indexOf(SENTENCE), END = START + SENTENCE.length;
const REWRITE = 'Lets use the built-in cache for caching.';

async function setup(reconcile: () => Promise<string | null>) {
  const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD } });
  adapter.pushTextNoKeystroke(TEXT);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const spanFillState = new SpanFillState();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  await loader.load();
  const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
  }, spanFillState);
  let calls = 0;
  const r = resolver as unknown as Record<string, unknown>;
  r._resolver = {
    resolve: async () => ({ results: [{
      wordIndex: 4, word: 'Lets', alternatives: [SENTENCE, SENTENCE], source: 'sentence-cue:session-contradiction', priority: 88,
      spanStart: START, spanEnd: END, cueTip: '⚠ Do not add new packages', confidence: 0.9,
      metadata: { sentenceCue: { cueName: 'session-contradiction' }, deferredRewrite: { commitmentId: 'c1', statement: 'Do not add new packages', quote: SENTENCE } },
    }] }),
  };
  r._sources = [{ id: 'session-cue', reconcileContradiction: async () => { calls++; return reconcile(); } }];
  const cycling = new Cycling(adapter, hlState, dynDefs, loader, spanFillState);
  cycling.subscribe();
  const nav = new Navigation(adapter, hlState, dynDefs, loader, spanFillState);
  nav.subscribe();
  await resolver.resolveAndApply(TEXT);
  const def = dynDefs.get(4)!;
  expect(def).toBeDefined();
  expect(rewriteIsDeferred(def)).toBe(true);
  return { adapter, hlState, dynDefs, calls: () => calls };
}
const tick = (ms = 15) => new Promise((res) => setTimeout(res, ms));

describe('deferred contradiction rewrite', () => {
  it('registers as a two-stop toggle with today\'s note and hint, nothing fetched yet', async () => {
    const { dynDefs, calls } = await setup(async () => REWRITE);
    const def = dynDefs.get(4)!;
    expect(def.alternatives).toEqual([SENTENCE, SENTENCE]);
    expect(inlineNoteText(def)).toBe('⚠ Do not add new packages');
    expect(inlineNoteHint(def, { actuator: false, dismissable: false, forgetOffer: false, suppressed: false })).toBe('(underscore to fix)');
    expect(calls()).toBe(0);
  });

  it('caret lands on the cue → the rewrite is fetched; the press then applies it instantly, one call in total', async () => {
    const { adapter, hlState, dynDefs, calls } = await setup(async () => REWRITE);
    hlState.activate(6, TEXT);            // a word inside the span
    await tick();
    expect(calls()).toBe(1);
    expect(dynDefs.get(4)!.alternatives).toEqual([SENTENCE, REWRITE]);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe(TEXT.replace(SENTENCE, REWRITE));
    expect(calls()).toBe(1);
  });

  it('press before it lands → fetched on the press and applied when it lands', async () => {
    let release: (v: string) => void = () => {};
    const { adapter, hlState, dynDefs, calls } = await setup(() => new Promise((res) => { release = res; }));
    hlState.setWordIndex(6);              // not "active": no prefetch
    hlState.activate(6, TEXT);
    await tick();
    expect(calls()).toBe(1);              // the landing started it
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.length).toBe(0);   // nothing applied yet
    expect(calls()).toBe(1);              // deduplicated, not a second call
    release(REWRITE);
    await tick();
    expect(adapter.setTextCalls.at(-1)).toBe(TEXT.replace(SENTENCE, REWRITE));
    expect(dynDefs.get(4)!.currentIndex).toBe(1);
  });

  it('no clean rewrite → the press does nothing, the note stays, no second call on the next landing', async () => {
    const { adapter, hlState, dynDefs, calls } = await setup(async () => null);
    hlState.activate(6, TEXT);
    await tick();
    adapter.fireKey('up', { ctrl: true, alt: true });
    await tick();
    expect(adapter.setTextCalls.length).toBe(0);
    const def = dynDefs.get(4)!;
    expect(def.currentIndex).toBe(0);
    expect(def.cueTip).toBe('⚠ Do not add new packages');
    hlState.deactivate();
    hlState.activate(5, TEXT);
    await tick();
    expect(calls()).toBe(1);
  });

  it('an edit while the rewrite is in flight → it is not applied to the new buffer', async () => {
    let release: (v: string) => void = () => {};
    const { adapter, hlState, calls } = await setup(() => new Promise((res) => { release = res; }));
    hlState.activate(6, TEXT);
    await tick();
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.pushTextNoKeystroke(TEXT + ' more');
    release(REWRITE);
    await tick();
    expect(adapter.setTextCalls).toEqual([]);
    expect(calls()).toBe(1);
  });
});
