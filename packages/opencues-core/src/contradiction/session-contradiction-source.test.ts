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

// ── the pre-gate (Jev plan step 2) ───────────────────────────────────────
import { contradictionGateRequest, contradictionGateSkips, CONTRADICTION_GATE_NONE } from './session-contradiction-source';
import type { DecisionProvider, DecisionRequest } from '../decisions/types';

function fakeGate(choice: string, confidence: number): DecisionProvider & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  return {
    id: 'fake', model: 'fake-1', requests,
    async ask(req) {
      requests.push(req);
      const q = req.questions.gate as { criteria: Record<string, string> };
      const ids = Object.keys(q.criteria);
      const probabilities: Record<string, number> = {};
      for (const o of ids) probabilities[o] = o === choice ? confidence : (1 - confidence) / (ids.length - 1);
      return { answers: { gate: { type: 'choice', choice, probabilities, confidence } } as never, model: 'fake-1', usage: { inputTokens: 5, outputTokens: 2 }, ms: 1 };
    },
  };
}
function countingAdapter(content: string): HttpAdapter & { calls: number } {
  const a = { calls: 0, post: async () => { a.calls++; return JSON.stringify({ choices: [{ message: { content } }] }); } };
  return a;
}
const HIT = JSON.stringify([{ quote: 'add the redis npm package', commitmentId: 'c2', tip: 'ALT-TIP no new deps', reconciled: 'ALT-REC use the built-in cache' }]);

describe('SessionContradictionSource — decision pre-gate', () => {
  it('builds the gate keyed BY ID (never an array), options = every commitment + a concrete none', () => {
    const req = contradictionGateRequest('zephyr draft', WATCHLIST!);
    expect(req.state).toEqual({ draft: 'zephyr draft', decisions: { c1: 'Runtime is Bun, not Node', c2: 'Do not add new npm dependencies' } });
    expect(Object.keys(req.questions.gate.criteria)).toEqual(['c1', 'c2', 'none']);
    expect(req.questions.gate.criteria.none).toBe(CONTRADICTION_GATE_NONE);
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

  it('a hit runs the chat call unchanged and attaches the gate confidence when the cited id matches', async () => {
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
    expect(contradictionGateSkips({ type: 'choice', choice: 'none', probabilities: {}, confidence: 0.3 })).toBe(false);
    expect(contradictionGateSkips({ type: 'choice', choice: 'none', probabilities: {}, confidence: 0.5 })).toBe(true);
    expect(contradictionGateSkips({ type: 'choice', choice: 'c1', probabilities: {}, confidence: 0.99 })).toBe(false);
  });

  it('a gate failure falls through to the chat call and is logged', async () => {
    const http = countingAdapter(HIT);
    const lines: string[] = [];
    const bad: DecisionProvider = { id: 'bad', model: 'x', async ask() { throw new Error('boom'); } };
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: http, decisions: bad, log: (m) => lines.push(m) });
    const r = await src.getCues(ctx('lets add the redis npm package for caching'));
    expect(http.calls).toBe(1);
    expect(r.results.length).toBe(1);
    expect(lines.join('\n')).toMatch(/falling through/);
  });

  it('without a decision provider nothing changes: the chat call runs, no confidence', async () => {
    const http = countingAdapter(HIT);
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: http });
    const [c] = (await src.getCues(ctx('lets add the redis npm package for caching'))).results;
    expect(http.calls).toBe(1);
    expect(c.confidence).toBeUndefined();
  });
});
