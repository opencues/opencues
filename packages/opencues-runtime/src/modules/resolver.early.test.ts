/**
 * Early paint: on a `_`-free pass the session rail's result is applied the
 * moment the rail settles, while slower siblings are still in flight; the
 * full pass then re-applies it as a refresh, never a second def. Measured
 * live before this: tip back at 0.7s, painted at 1.2s.
 */
import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

type Result = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tipFor(text: string): Result {
  return { wordIndex: 0, word: text.split(' ')[0], alternatives: [text, '/zap'], source: 'sentence-cue:tip', priority: 86, spanStart: 0, spanEnd: text.length, cueTip: '💡 ALT-SAY zap' };
}
/** a core resolver whose rail settles at +railMs and whose pass completes at +passMs */
function setup(text: string, opts: { railMs: number; passMs: number; rail?: Result[]; full?: Result[] }) {
  const adapter = new MockAdapter();
  adapter.pushText(text);
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  const resolver = new Resolver(adapter, new HighlightState(), dynDefs, loader, { endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter: {} });
  const rail = opts.rail ?? [tipFor(text)];
  const full = opts.full ?? rail;
  const events: string[] = [];
  adapter.emitEvent = (type: string) => { events.push(type); };
  (resolver as unknown as { _resolver: unknown })._resolver = {
    resolve: async (_ctx: unknown, o?: { onSourceResult?: (id: string, r: { results: Result[] }) => void }) => {
      setTimeout(() => o?.onSourceResult?.('session-cue', { results: rail }), opts.railMs);
      await sleep(opts.passMs);
      return { results: full };
    },
  };
  return { resolver, dynDefs, events, adapter };
}
const tipDefs = (d: DynDefs) => Array.from({ length: 200 }, (_, i) => d.get(i)).filter((x) => x?.blankName === 'sentence-cue:tip');

describe('Resolver — the session rail paints as soon as it settles on a `_`-free pass', () => {
  it('the tip def exists before the pass completes, and the full pass leaves exactly one def', async () => {
    const text = 'ok this is a zorb lets begin again';
    const { resolver, dynDefs, events } = setup(text, { railMs: 20, passMs: 120 });
    const pass = resolver.resolveAndApply(text);
    await sleep(60);
    expect(tipDefs(dynDefs)).toHaveLength(1);                       // painted at +20ms, pass still running
    expect(events).toContain('resolver.early');
    expect(events.filter((e) => e === 'resolver.completed')).toHaveLength(0);
    await pass;
    expect(tipDefs(dynDefs)).toHaveLength(1);                       // refreshed, not doubled
    expect(events.filter((e) => e === 'resolver.completed')).toHaveLength(1);
    expect(events.filter((e) => e === 'resolver.started')).toHaveLength(1);
  });
  it('a `_` in the draft disables early paint: the tip waits for the whole pass', async () => {
    const text = 'ok this is a zorb lets begin again _';
    const { resolver, dynDefs, events } = setup(text, { railMs: 20, passMs: 120 });
    const pass = resolver.resolveAndApply(text);
    await sleep(60);
    expect(tipDefs(dynDefs)).toHaveLength(0);
    expect(events).not.toContain('resolver.early');
    await pass;
  });
  it('a rail that settles after a newer pass started paints nothing (generation guard)', async () => {
    const text = 'ok this is a zorb lets begin again';
    const { resolver, dynDefs } = setup(text, { railMs: 40, passMs: 120 });
    const first = resolver.resolveAndApply(text);
    await sleep(10);
    const second = resolver.resolveAndApply(text + ' now');           // supersedes; its own fake rail also fires at +40
    await sleep(70);
    const defs = tipDefs(dynDefs);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.alternatives[0]).toBe(text);                      // both fakes return the ORIGINAL text's tip; only the newer generation may paint
    await Promise.all([first, second]);
    expect(tipDefs(dynDefs)).toHaveLength(1);
  });
  it('an empty rail result paints nothing early', async () => {
    const text = 'the zorb is fine';
    const { resolver, dynDefs, events } = setup(text, { railMs: 10, passMs: 60, rail: [], full: [] });
    await resolver.resolveAndApply(text);
    expect(tipDefs(dynDefs)).toHaveLength(0);
    expect(events).not.toContain('resolver.early');
  });
});
