// The `_` router seam in the runtime resolver (Jev plan step 5, design A).
// Pins the runtime CONTRACT, not the router's judgement (that is the router
// bench): which sources a routed pass dispatches, the cede fallback, the
// breaker on failure, and that a `_`-free pass never asks the router.
import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({ concepts: [] });
const CUES_MD = `---
name: test-cues
domain: test
version: 1
---
`;

interface MockResult { wordIndex: number; word: string; alternatives: string[]; source?: string }
const CHAT_IDS = new Set(['config-intent', 'transform-blank', 'fluid-blank']);
const ALL_IDS = ['session-cue', 'sentence-cue', ...CHAT_IDS];

/** A fake core resolver: each call records which ids the `only` filter admits and answers per admitted source. */
function fakeResolver(answers: Record<string, MockResult[]>) {
  const passes: string[][] = [];
  return {
    passes,
    resolve: async (_ctx: unknown, opts?: { only?: (id: string) => boolean }) => {
      const admitted = ALL_IDS.filter((id) => !opts?.only || opts.only(id));
      passes.push(admitted);
      return { results: admitted.flatMap((id) => answers[id] ?? []) };
    },
  };
}

function setup(opts: { routing: { sourceId: string | null } | Error; answers: Record<string, MockResult[]>; text: string }) {
  const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD } });
  adapter.pushText(opts.text);
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  const resolver = new Resolver(adapter, new HighlightState(), new DynDefs(), loader, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
  });
  const fake = fakeResolver(opts.answers);
  const routerCalls: string[] = [];
  const breaker = { down: false, healthy() { return !this.down; }, trip() { this.down = true; } };
  const r = resolver as unknown as Record<string, unknown>;
  r._resolver = fake;
  r._decisions = { id: 'fake' };
  r._routeBreaker = breaker;
  r._core = {
    UNDERSCORE_CHAT_SOURCE_IDS: CHAT_IDS,
    async routeUnderscore(_p: unknown, text: string) {
      routerCalls.push(text);
      if (opts.routing instanceof Error) throw opts.routing;
      return { route: opts.routing.sourceId ? 'x' : null, sourceId: opts.routing.sourceId, choice: 'x', confidence: 0.9, agreement: 0.9, ms: 1 };
    },
  };
  return { adapter, resolver, fake, routerCalls, breaker };
}

const fluidAnswer = (): MockResult => ({ wordIndex: 3, word: '_', alternatives: ['ALT-ONE'], source: 'fluid-blank' });

describe('Resolver — the `_` router (design A)', () => {
  it('a routed `_` dispatches only the routed chat source; the non-`_` sources still run; one pass', async () => {
    const { resolver, fake, routerCalls } = setup({ text: 'zephyr of quark _', routing: { sourceId: 'fluid-blank' }, answers: { 'fluid-blank': [fluidAnswer()] } });
    await resolver.resolveAndApply('zephyr of quark _');
    expect(routerCalls).toEqual(['zephyr of quark _']);
    expect(fake.passes).toHaveLength(1);
    expect(fake.passes[0]).toEqual(['session-cue', 'sentence-cue', 'fluid-blank']);
  });

  it('a routed source that cedes is followed by the fan-out over the OTHER chat sources only', async () => {
    const { resolver, fake } = setup({ text: 'zephyr of quark _', routing: { sourceId: 'config-intent' }, answers: { 'fluid-blank': [fluidAnswer()] } });
    await resolver.resolveAndApply('zephyr of quark _');
    expect(fake.passes).toHaveLength(2);
    expect(fake.passes[0]).toEqual(['session-cue', 'sentence-cue', 'config-intent']);
    expect(fake.passes[1]).toEqual(['transform-blank', 'fluid-blank']);
  });

  it('below threshold (no sourceId) → the full fan-out, one pass', async () => {
    const { resolver, fake, routerCalls } = setup({ text: 'zephyr of quark _', routing: { sourceId: null }, answers: {} });
    await resolver.resolveAndApply('zephyr of quark _');
    expect(routerCalls).toHaveLength(1);
    expect(fake.passes).toEqual([ALL_IDS]);
  });

  it('a failed route trips the breaker and the pass fans out; the next `_` skips the router while down', async () => {
    const { resolver, fake, routerCalls, breaker } = setup({ text: 'zephyr of quark _', routing: new Error('busy'), answers: {} });
    await resolver.resolveAndApply('zephyr of quark _');
    expect(fake.passes).toEqual([ALL_IDS]);
    expect(breaker.down).toBe(true);
    await resolver.resolveAndApply('zephyr of quark _ more');
    expect(routerCalls).toHaveLength(1);
    expect(fake.passes).toHaveLength(2);
  });

  it('a pass with no `_` never asks the router', async () => {
    const { resolver, fake, routerCalls } = setup({ text: 'zephyr of quark', routing: { sourceId: 'fluid-blank' }, answers: {} });
    await resolver.resolveAndApply('zephyr of quark');
    expect(routerCalls).toHaveLength(0);
    expect(fake.passes).toEqual([ALL_IDS]);
  });

  it('with no decision provider the `_` pass is exactly today\'s fan-out', async () => {
    const { resolver, fake, routerCalls } = setup({ text: 'zephyr of quark _', routing: { sourceId: 'fluid-blank' }, answers: {} });
    (resolver as unknown as Record<string, unknown>)._decisions = null;
    await resolver.resolveAndApply('zephyr of quark _');
    expect(routerCalls).toHaveLength(0);
    expect(fake.passes).toEqual([ALL_IDS]);
  });
});

describe('Resolver — the `_` router, supersede', () => {
  it('a route aborted by a newer keystroke does NOT trip the breaker', async () => {
    const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD } });
    adapter.pushText('zephyr _');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const resolver = new Resolver(adapter, new HighlightState(), new DynDefs(), loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
    });
    const fake = fakeResolver({});
    const breaker = { down: false, healthy() { return !this.down; }, trip() { this.down = true; } };
    const r = resolver as unknown as Record<string, unknown>;
    r._resolver = fake; r._decisions = { id: 'fake' }; r._routeBreaker = breaker;
    let calls = 0;
    r._core = {
      UNDERSCORE_CHAT_SOURCE_IDS: CHAT_IDS,
      async routeUnderscore(_p: unknown, _t: string, ctx: { signal: AbortSignal }) {
        if (calls++ > 0) return { route: null, sourceId: null, choice: 'other', confidence: 0.1, agreement: 1, ms: 1 };
        // the first router call is in flight when the next keystroke lands
        await new Promise((res) => setTimeout(res, 5));
        void resolver.resolveAndApply('zephyr quark _');
        await new Promise((res) => setTimeout(res, 5));
        expect(ctx.signal.aborted).toBe(true);
        const e = new Error('decision: aborted'); e.name = 'DecisionError';
        throw e;
      },
    };
    await resolver.resolveAndApply('zephyr _');
    await new Promise((res) => setTimeout(res, 30));
    expect(breaker.down).toBe(false);
    expect(calls).toBe(2);
  });
});
