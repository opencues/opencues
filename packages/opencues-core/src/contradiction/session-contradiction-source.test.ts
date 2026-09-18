import { describe, it, expect } from 'vitest';
import { SessionContradictionSource, parseFlags } from './session-contradiction-source';
import { getProvider } from '../llm-provider';
import type { CueContext, HttpAdapter } from '../types';

function makeMockAdapter(content: string): HttpAdapter {
  return { post: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
}

const WATCHLIST: CueContext['sessionCommitments'] = {
  commitments: [
    { id: 'c1', category: 'stack', statement: 'Runtime is Bun, not Node' },
    { id: 'c2', category: 'constraint', statement: 'Do not add new npm dependencies' },
  ],
  ingestedAt: '2026-08-03T00:00:00Z',
};

function ctx(text: string, snapshot = WATCHLIST): CueContext {
  return { text, words: text.split(/\s+/).filter(Boolean), sessionCommitments: snapshot };
}

const baseConfig = {
  provider: getProvider('groq')!,
  endpoint: 'https://example.test/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model',
};

describe('SessionContradictionSource.supports', () => {
  it('needs a non-empty buffer AND a non-empty watchlist', () => {
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: makeMockAdapter('[]') });
    expect(src.supports(ctx('add a redis dependency'))).toBe(true);
    expect(src.supports(ctx('   '))).toBe(false);
    expect(src.supports(ctx('add a redis dependency', { commitments: [] }))).toBe(false);
    expect(src.supports({ text: 'x', words: ['x'] })).toBe(false); // no snapshot
  });
});

describe('SessionContradictionSource.getCues', () => {
  it('emits a passive sentence-cue for a grounded, well-cited flag', async () => {
    const src = new SessionContradictionSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter(JSON.stringify([
        { quote: "let's add the redis npm package", commitmentId: 'c2', tip: 'no new npm deps', reconciled: "let's use a built-in instead of the redis npm package" },
      ])),
    });
    const buffer = "let's add the redis npm package for caching";
    const res = await src.getCues(ctx(buffer));
    expect(res.results).toHaveLength(1);
    const r = res.results[0]!;
    expect(r.source).toBe('sentence-cue:session-contradiction');
    expect(r.priority).toBe(88);
    // alternatives[0] is the exact buffer substring (resolver race-guard needs this)
    expect(r.alternatives[0]).toBe("let's add the redis npm package");
    expect(buffer.slice(r.spanStart!, r.spanEnd!)).toBe(r.alternatives[0]);
    expect(r.alternatives[1]).toContain('built-in');
    expect(r.cueTip).toBe('⚠ no new npm deps');
    expect((r.metadata?.sentenceCue as { cueName?: string })?.cueName).toBe('session-contradiction');
  });

  it('DROPS a flag citing an unknown commitment id (grounding 2)', async () => {
    const src = new SessionContradictionSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter(JSON.stringify([
        { quote: 'add the redis package', commitmentId: 'c99', tip: 'x' },
      ])),
    });
    const res = await src.getCues(ctx('add the redis package now'));
    expect(res.results).toHaveLength(0);
  });

  it('DROPS a flag whose quote is not a verbatim substring (grounding 1)', async () => {
    const src = new SessionContradictionSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter(JSON.stringify([
        { quote: 'add the REDIS PACKAGE', commitmentId: 'c2', tip: 'x' }, // case-changed → not a substring
      ])),
    });
    const res = await src.getCues(ctx('add the redis package now'));
    expect(res.results).toHaveLength(0);
  });

  it('returns nothing when the LLM finds no contradiction', async () => {
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: makeMockAdapter('[]') });
    const res = await src.getCues(ctx('now write the tests'));
    expect(res.results).toHaveLength(0);
  });

  it('never throws / never wipes the buffer when the LLM call fails', async () => {
    const src = new SessionContradictionSource({
      ...baseConfig,
      httpAdapter: { post: async () => { throw new Error('network down'); } },
    });
    const res = await src.getCues(ctx('add the redis package'));
    expect(res.results).toEqual([]);
  });

  it('reconciled falls back to the quote when omitted', async () => {
    const src = new SessionContradictionSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter(JSON.stringify([
        { quote: 'switch to node', commitmentId: 'c1' },
      ])),
    });
    const res = await src.getCues(ctx('please switch to node for this'));
    expect(res.results[0]!.alternatives).toEqual(['switch to node', 'switch to node']);
    expect(res.results[0]!.cueTip).toBe('⚠ contradicts an earlier decision');
  });
});

describe('parseFlags', () => {
  it('tolerates prose / fences around the array', () => {
    expect(parseFlags('here you go:\n```json\n[{"quote":"x","commitmentId":"c1"}]\n```')).toEqual([
      { quote: 'x', commitmentId: 'c1' },
    ]);
    expect(parseFlags('no array here')).toEqual([]);
    expect(parseFlags('')).toEqual([]);
  });
});

// ── the pre-gate (decision layer) ───────────────────────────────────────
// A scripted DecisionLegs stands in for the decision package: these pin
// what the source does with a verdict. The package's tests pin the request.
import { contradictionUnits, contradictionGateSkips, SESSION_CONTRADICTION_RECONCILE_SYSTEM } from './session-contradiction-source';
import { fakeLegs } from '../decisions/fake-legs.test-helper';

const fakeGate = (choice: string, confidence: number) => fakeLegs({ contradiction: { choice, confidence } });
function countingAdapter(content: string): HttpAdapter & { calls: number } {
  const a = { calls: 0, post: async () => { a.calls++; return JSON.stringify({ choices: [{ message: { content } }] }); } };
  return a;
}
const HIT = JSON.stringify([{ quote: 'add the redis npm package', commitmentId: 'c2', tip: 'ALT-TIP no new deps', reconciled: 'ALT-REC use the built-in cache' }]);

describe('SessionContradictionSource — decision pre-gate', () => {
  it('hands the leg the draft, the watchlist as {id, statement} and the runtime-cut units', async () => {
    const d = fakeGate('none', 0.9);
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: countingAdapter(HIT), decisions: d });
    await src.getCues(ctx('zephyr draft. second one.'));
    expect(d.calls.length).toBe(1);
    expect(d.calls[0].leg).toBe('contradictionGate');
    expect(d.calls[0].args[0]).toBe('zephyr draft. second one.');
    expect(d.calls[0].args[1]).toEqual([{ id: 'c1', statement: 'Runtime is Bun, not Node' }, { id: 'c2', statement: 'Do not add new npm dependencies' }]);
    expect((d.calls[0].args[2] as Array<{ id: string; text: string }>).map((u) => u.id)).toEqual(['s1', 's2']);
  });

  it('a confident none skips the chat call entirely', async () => {
    const http = countingAdapter(HIT);
    const lines: string[] = [];
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: http, decisions: fakeGate('none', 0.9), log: (m) => lines.push(m) });
    const r = await src.getCues(ctx('bumped the README badge'));
    expect(r.results).toEqual([]);
    expect(http.calls).toBe(0);
    expect(lines.join('\n')).toMatch(/chat call skipped/);
  });

  it('a hit with no unit runs the chat call unchanged and attaches the gate confidence when the cited id matches', async () => {
    const http = countingAdapter(HIT);
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: http, decisions: fakeGate('c2', 0.88) });
    const [c] = (await src.getCues(ctx('lets add the redis npm package for caching'))).results;
    expect(http.calls).toBe(1);
    expect(c.alternatives).toEqual(['add the redis npm package', 'ALT-REC use the built-in cache']);
    expect(c.cueTip).toBe('⚠ ALT-TIP no new deps');
    expect(c.confidence).toBe(0.88);
    expect((c.metadata as { gate: { choice: string } }).gate.choice).toBe('c2');
  });

  it('a low-confidence none still runs the chat call (the gate only saves a call, never loses a cue)', async () => {
    const http = countingAdapter(HIT);
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: http, decisions: fakeGate('none', 0.3) });
    const r = await src.getCues(ctx('lets add the redis npm package for caching'));
    expect(http.calls).toBe(1);
    expect(r.results.length).toBe(1);
    expect(r.results[0].confidence).toBeUndefined();   // gate did not cite c2
    expect(contradictionGateSkips({ choice: 'none', confidence: 0.3 })).toBe(false);
    expect(contradictionGateSkips({ choice: 'none', confidence: 0.5 })).toBe(true);
    expect(contradictionGateSkips({ choice: 'c1', confidence: 0.99 })).toBe(false);
  });

  it('a gate failure falls through to the chat call and is logged', async () => {
    const http = countingAdapter(HIT);
    const lines: string[] = [];
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: http, decisions: fakeLegs({ throws: new Error('boom') }), log: (m) => lines.push(m) });
    const r = await src.getCues(ctx('lets add the redis npm package for caching'));
    expect(http.calls).toBe(1);
    expect(r.results.length).toBe(1);
    expect(lines.join('\n')).toMatch(/falling through/);
  });

  it('without decision legs nothing changes: the chat call runs, no confidence', async () => {
    const http = countingAdapter(HIT);
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: http });
    const [c] = (await src.getCues(ctx('lets add the redis npm package for caching'))).results;
    expect(http.calls).toBe(1);
    expect(c.confidence).toBeUndefined();
  });
});

// ── the decision-only path (decision layer) ──────────────────────────────
/** a verdict naming gate AND unit */
const fakeDecision = (gate: string, unit: string, conf = 0.9) => fakeLegs({ contradiction: { choice: gate, confidence: conf, unit: { choice: unit, confidence: conf } } });
const THREE = 'The zorb tests pass. Lets add the redis npm package for caching. Standup moves to ten.';

describe('SessionContradictionSource — decision-only path (step 6)', () => {
  it('the units are the runtime-cut sentences, keyed by id, and slice back to the draft', () => {
    const units = contradictionUnits(THREE, THREE.split(/\s+/));
    expect(units.map((u) => u.id)).toEqual(['s1', 's2', 's3']);
    expect(units[1].text).toBe('Lets add the redis npm package for caching.');
    expect(THREE.slice(units[1].start, units[1].end)).toBe(units[1].text);
  });

  it('gate + unit → the cue is built from data: no chat call, note = the decision statement, span = the sentence, rewrite deferred', async () => {
    const http = countingAdapter(HIT);
    const d = fakeDecision('c2', 's2', 0.91);
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: http, decisions: d });
    const [c] = (await src.getCues(ctx(THREE))).results;
    expect(http.calls).toBe(0);
    expect(d.calls.length).toBe(1);
    expect(c.cueTip).toBe('⚠ Do not add new npm dependencies');
    expect(THREE.slice(c.spanStart!, c.spanEnd!)).toBe('Lets add the redis npm package for caching.');
    expect(c.alternatives).toEqual(['Lets add the redis npm package for caching.', 'Lets add the redis npm package for caching.']);
    expect(c.confidence).toBe(0.91);
    expect(c.metadata).toMatchObject({ deferredRewrite: { commitmentId: 'c2', statement: 'Do not add new npm dependencies', quote: 'Lets add the redis npm package for caching.' }, unit: { choice: 's2' } });
  });

  it('the fused path hands the verdict and the units in and makes no decision call of its own', async () => {
    const http = countingAdapter(HIT);
    const d = fakeDecision('c2', 's2');
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: http, decisions: d });
    const units = contradictionUnits(THREE, THREE.split(/\s+/));
    const verdict = { choice: 'c2', confidence: 0.9, top: 'c2 0.90', unit: { choice: 's2', confidence: 0.9 } };
    const r = await src.getCues(ctx(THREE), verdict, units);
    expect(http.calls).toBe(0);
    expect(d.calls.length).toBe(0);
    expect(r.results[0].cueTip).toBe('⚠ Do not add new npm dependencies');
  });

  it('a gate hit under the fire floor falls through to the chat call (style rules sit close to none)', async () => {
    const http = countingAdapter(HIT);
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: http, decisions: fakeDecision('c2', 's2', 0.44) });
    const r = await src.getCues(ctx(THREE));
    expect(http.calls).toBe(1);
    expect(r.results[0].alternatives).toEqual(['add the redis npm package', 'ALT-REC use the built-in cache']);
  });

  it('a `none` unit on a gate hit falls through to the chat call (never loses a cue)', async () => {
    const http = countingAdapter(HIT);
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: http, decisions: fakeDecision('c2', 'none') });
    const r = await src.getCues(ctx('lets add the redis npm package for caching'));
    expect(http.calls).toBe(1);
    expect(r.results[0].alternatives).toEqual(['add the redis npm package', 'ALT-REC use the built-in cache']);
  });

  it('reconcile: one small chat call; NONE, an echo or a failure → null; quotes stripped', async () => {
    const seen: string[] = [];
    const mk = (content: string): HttpAdapter => ({ post: async (_u: string, body: string) => { seen.push(body); return JSON.stringify({ choices: [{ message: { content } }] }); } });
    const rw = { commitmentId: 'c2', statement: 'Do not add new npm dependencies', quote: 'Lets add the redis npm package for caching.' };
    expect(await new SessionContradictionSource({ ...baseConfig, httpAdapter: mk('"Lets use the built-in cache instead of redis."') }).reconcile(rw)).toBe('Lets use the built-in cache instead of redis.');
    expect(seen[0]).toContain(SESSION_CONTRADICTION_RECONCILE_SYSTEM.slice(0, 40));
    expect(seen[0]).toContain('DECISION: Do not add new npm dependencies');
    expect(await new SessionContradictionSource({ ...baseConfig, httpAdapter: mk('NONE') }).reconcile(rw)).toBeNull();
    expect(await new SessionContradictionSource({ ...baseConfig, httpAdapter: mk(rw.quote) }).reconcile(rw)).toBeNull();
    const bad: HttpAdapter = { post: async () => { throw new Error('boom'); } };
    expect(await new SessionContradictionSource({ ...baseConfig, httpAdapter: bad }).reconcile(rw)).toBeNull();
  });
});
