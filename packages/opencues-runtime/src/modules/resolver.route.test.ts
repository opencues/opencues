// The `_` router seam in the runtime resolver (decision layer, design A).
// Pins the runtime CONTRACT, not the router's judgement (that is the router
// bench): which sources a routed pass dispatches, the cede fallback, the
// breaker on failure, and that a `_`-free pass never asks the router.
import { describe, expect, it } from 'vitest';
import { Resolver, UNDERSCORE_ROUTE_BUDGET_MS } from './resolver';
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
  r._decisions = {
    id: 'fake',
    async route(text: string) {
      routerCalls.push(text);
      if (opts.routing instanceof Error) throw opts.routing;
      return { route: opts.routing.sourceId ? 'x' : null, sourceId: opts.routing.sourceId, choice: 'x', confidence: 0.9, agreement: 0.9, ms: 1 };
    },
  };
  r._routeBreaker = breaker;
  r._core = { UNDERSCORE_CHAT_SOURCE_IDS: CHAT_IDS };
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
    r._resolver = fake; r._routeBreaker = breaker; r._core = { UNDERSCORE_CHAT_SOURCE_IDS: CHAT_IDS };
    let calls = 0;
    r._decisions = {
      async route(_t: string, ctx: { signal: AbortSignal }) {
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

describe('Resolver — the `_` router, latency budget', () => {
  it('a route slower than the budget fans out without tripping the breaker', async () => {
    const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD } });
    adapter.pushText('zephyr _');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const resolver = new Resolver(adapter, new HighlightState(), new DynDefs(), loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
    });
    const fake = fakeResolver({});
    const breaker = { down: false, healthy() { return !this.down; }, trip() { this.down = true; } };
    const r = resolver as unknown as Record<string, unknown>;
    r._resolver = fake; r._routeBreaker = breaker; r._core = { UNDERSCORE_CHAT_SOURCE_IDS: CHAT_IDS };
    r._decisions = {
      route(_t: string, ctx: { signal: AbortSignal }) {
        // never answers on its own; rejects when the budget aborts it, as the wire adapter does
        return new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => { const e = new Error('decision: aborted'); e.name = 'DecisionError'; rej(e); }));
      },
    };
    const t0 = Date.now();
    await resolver.resolveAndApply('zephyr _');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(UNDERSCORE_ROUTE_BUDGET_MS - 20);
    expect(breaker.down).toBe(false);
    expect(fake.passes).toEqual([ALL_IDS]);
  });
});

// ── a device the route named (security-audit row #32) ──────────────────────
describe('Resolver — the `_` router hands a decided device to BlankFill', () => {
  function setupDevice(opts: { text: string; sourceId: string | null; device: { blank: string; value: string } | null; fillReturns?: boolean }) {
    const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD } });
    adapter.pushText(opts.text);
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const fills: Array<{ text: string; inv: { blank: string; keyword: string; action: string; value?: string }; commandStartWord: number }> = [];
    const resolver = new Resolver(adapter, new HighlightState(), new DynDefs(), loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
      fillDevice: (text, inv, commandStartWord) => { fills.push({ text, inv, commandStartWord }); return opts.fillReturns ?? true; },
    });
    const fake = fakeResolver({});
    const r = resolver as unknown as Record<string, unknown>;
    r._resolver = fake;
    r._decisions = {
      id: 'fake',
      async route() {
        return { route: opts.sourceId ? 'x' : null, sourceId: opts.sourceId, choice: 'x', confidence: 0.9, agreement: 0.9, ms: 1, device: opts.device ? { ...opts.device, confidence: 0.9, valueConfidence: 0.9, top: '' } : null };
      },
    };
    r._routeBreaker = { down: false, healthy() { return true; }, trip() { /* */ } };
    r._core = { UNDERSCORE_CHAT_SOURCE_IDS: CHAT_IDS };
    return { adapter, resolver, fake, fills };
  }

  it('a device verdict that resolves under the policy → BlankFill runs it over the phrase and the pass ends (no fan-out)', async () => {
    const { resolver, fake, fills } = setupDevice({ text: 'zephyr. make it louder _', sourceId: null, device: { blank: 'volume', value: 'up' } });
    await resolver.resolveAndApply('zephyr. make it louder _');
    expect(fills).toEqual([{ text: 'zephyr. make it louder _', inv: { blank: 'volume', keyword: 'volume', action: 'step', value: 'up' }, commandStartWord: 1 }]);
    expect(fake.passes).toHaveLength(0);
  });

  it('a chat route wins over a device named on the same request', async () => {
    const { resolver, fake, fills } = setupDevice({ text: 'capital of zorbland _', sourceId: 'fluid-blank', device: { blank: 'volume', value: 'up' } });
    await resolver.resolveAndApply('capital of zorbland _');
    expect(fills).toEqual([]);
    // the routed pass (fluid cedes with no answer here) then the fan-out over the rest — the router's normal shape
    expect(fake.passes[0]).toEqual(['session-cue', 'sentence-cue', 'fluid-blank']);
  });

  it('a verdict the policy rejects (a user blank, a number out of range) falls through to the fan-out', async () => {
    const a = setupDevice({ text: 'zorb it _', sourceId: null, device: { blank: 'zorb-script', value: 'up' } });
    await a.resolver.resolveAndApply('zorb it _');
    expect(a.fills).toEqual([]); expect(a.fake.passes).toHaveLength(1);
    const b = setupDevice({ text: 'volume to 400 _', sourceId: null, device: { blank: 'volume', value: 'number' } });
    await b.resolver.resolveAndApply('volume to 400 _');
    expect(b.fills).toEqual([]); expect(b.fake.passes).toHaveLength(1);
  });

  it('BlankFill declining (nothing registered here) → the pass continues', async () => {
    const { resolver, fake, fills } = setupDevice({ text: 'where am i _', sourceId: null, device: { blank: 'location', value: 'here' }, fillReturns: false });
    await resolver.resolveAndApply('where am i _');
    expect(fills).toHaveLength(1);
    expect(fake.passes).toHaveLength(1);
  });
});

// ── a data table the route named (row #32, data-policy.ts) ────────────────
describe('Resolver — the `_` router hands a decided table to BlankFill', () => {
  function setupTable(opts: { text: string; sourceId: string | null; route?: string | null; table: string | null; fillReturns?: boolean }) {
    const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD } });
    adapter.pushText(opts.text);
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const fills: Array<{ text: string; inv: { blank: string; keyword: string; action: string; value?: string }; commandStartWord: number }> = [];
    const resolver = new Resolver(adapter, new HighlightState(), new DynDefs(), loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
      fillDevice: (text, inv, commandStartWord) => { fills.push({ text, inv, commandStartWord }); return opts.fillReturns ?? true; },
    });
    const fake = fakeResolver({});
    const r = resolver as unknown as Record<string, unknown>;
    r._resolver = fake;
    r._decisions = {
      id: 'fake',
      async route() {
        return { route: opts.route ?? (opts.sourceId ? 'x' : null), sourceId: opts.sourceId, choice: 'x', confidence: 0.9, agreement: 0.9, ms: 1, device: null, table: opts.table ? { table: opts.table, confidence: 0.9, top: '' } : null };
      },
    };
    r._routeBreaker = { down: false, healthy() { return true; }, trip() { /* */ } };
    r._core = { UNDERSCORE_CHAT_SOURCE_IDS: CHAT_IDS };
    return { adapter, resolver, fake, fills };
  }

  it('a table verdict → the argument is captured from the draft, BlankFill runs the built-in, the pass ends (no LLM at all)', async () => {
    const { resolver, fake, fills } = setupTable({ text: 'zephyr. what port does postgres use _', sourceId: null, table: 'port' });
    await resolver.resolveAndApply('zephyr. what port does postgres use _');
    expect(fills).toEqual([{ text: 'zephyr. what port does postgres use _', inv: { blank: 'tables', keyword: 'default port for', action: 'get', value: 'postgres' }, commandStartWord: 1 }]);
    expect(fake.passes).toHaveLength(0);
  });

  it('a table stands over a `lookup` route (that is the chat path it replaces)', async () => {
    const { resolver, fake, fills } = setupTable({ text: 'capital of france _', sourceId: 'fluid-blank', route: 'lookup', table: 'capital' });
    await resolver.resolveAndApply('capital of france _');
    expect(fills).toEqual([{ text: 'capital of france _', inv: { blank: 'countries', keyword: 'capital of', action: 'get', value: 'france' }, commandStartWord: 0 }]);
    expect(fake.passes).toHaveLength(0);
  });

  it('a settings or rewrite route wins over a table named on the same request', async () => {
    const { resolver, fake, fills } = setupTable({ text: 'zorb mode off _', sourceId: 'config-intent', route: 'settings', table: 'port' });
    await resolver.resolveAndApply('zorb mode off _');
    expect(fills).toEqual([]);
    expect(fake.passes).toHaveLength(2);
  });

  it('a verdict the policy rejects (unknown table, an argument off the floor) falls through to the fan-out', async () => {
    const a = setupTable({ text: 'zorb it _', sourceId: null, table: 'zorb-script' });
    await a.resolver.resolveAndApply('zorb it _');
    expect(a.fills).toEqual([]); expect(a.fake.passes).toHaveLength(1);
    const b = setupTable({ text: 'what port for http://zorb _', sourceId: null, table: 'port' });
    await b.resolver.resolveAndApply('what port for http://zorb _');
    expect(b.fills).toEqual([]); expect(b.fake.passes).toHaveLength(1);
  });

  it('BlankFill declining (a miss in the table) → the pass continues', async () => {
    const { resolver, fake, fills } = setupTable({ text: 'what port does zorbd use _', sourceId: null, table: 'port', fillReturns: false });
    await resolver.resolveAndApply('what port does zorbd use _');
    expect(fills).toHaveLength(1);
    expect(fake.passes).toHaveLength(1);
  });
});
