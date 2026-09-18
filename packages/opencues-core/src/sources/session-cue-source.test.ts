import { describe, it, expect } from 'vitest';
import { SessionCueSource } from './session-cue-source';
import { getProvider } from '../llm-provider';
import type { CueContext, HttpAdapter } from '../types';

const WATCH: CueContext['sessionCommitments'] = {
  commitments: [{ id: 'c1', category: 'constraint', statement: 'Do not add new npm dependencies' }],
};
function ctx(text: string): CueContext {
  return { text, words: text.split(/\s+/).filter(Boolean), sessionCommitments: WATCH, cursor: text.length };
}
const base = { provider: getProvider('groq')!, endpoint: 'https://x.test/v1/chat/completions', apiKey: 'k', model: 'm' };

// Route the mock by prompt: the ask call carries the AskUserQuestion prompt; the
// contradiction call doesn't. Counts each so we can prove the short-circuit.
function router(contradictionReply: string, askReply: string) {
  const calls = { contradiction: 0, ask: 0 };
  const adapter: HttpAdapter = {
    post: async (_u, body) => {
      const sys = JSON.parse(body as string).messages[0].content as string;
      const isAsk = sys.includes('AskUserQuestion');
      if (isAsk) calls.ask++; else calls.contradiction++;
      return JSON.stringify({ choices: [{ message: { content: isAsk ? askReply : contradictionReply } }] });
    },
  };
  return { adapter, calls };
}
const CONTRADICTS = JSON.stringify([{ quote: 'add the redis npm package', commitmentId: 'c1', tip: 'no new deps' }]);
const A_QUESTION = JSON.stringify({ header: 'Evidence', question: 'q?', options: [{ label: 'A', apply: 'x' }] });

describe('SessionCueSource — contradiction-first short-circuit', () => {
  it('both on + a contradiction fires → emits ⚠, SKIPS the ask call', async () => {
    const { adapter, calls } = router(CONTRADICTS, A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableAsk: true });
    const res = await src.getCues(ctx('please add the redis npm package now'));
    expect(res.results[0]?.source).toBe('sentence-cue:session-contradiction');
    expect(calls.contradiction).toBe(1);
    expect(calls.ask, 'ask call must be short-circuited when a contradiction fires').toBe(0);
  });

  it('both on + no contradiction → runs the ask call, emits ❓', async () => {
    const { adapter, calls } = router('[]', A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableAsk: true });
    const res = await src.getCues(ctx('the new approach is way better'));
    expect(res.results[0]?.source).toBe('sentence-cue:tool-ask');
    expect(calls.contradiction).toBe(1);
    expect(calls.ask).toBe(1);
  });

  it('contradiction-only → never calls ask', async () => {
    const { adapter, calls } = router('[]', A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableAsk: false });
    await src.getCues(ctx('some ordinary prose here'));
    expect(calls.ask).toBe(0);
  });

  it('ask-only → never calls contradiction', async () => {
    const { adapter, calls } = router('[]', A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: false, enableAsk: true });
    const res = await src.getCues(ctx('the thing is way better than before'));
    expect(calls.contradiction).toBe(0);
    expect(calls.ask).toBe(1);
    expect(res.results[0]?.source).toBe('sentence-cue:tool-ask');
  });

  it('neither on → no calls, no results', async () => {
    const { adapter, calls } = router('[]', A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: false, enableAsk: false });
    expect((await src.getCues(ctx('anything at all'))).results).toEqual([]);
    expect(calls.contradiction + calls.ask).toBe(0);
  });
});

// ── the tips leg (semantic tips, 2026-09-06) ────────────────────────────────
// Rail order is contradiction → tips → ask, each its own call, first non-empty
// result wins. The mock routes by prompt: the tips call carries the TIPS
// catalogue header; the ask call carries AskUserQuestion; the rest is the
// contradiction call.
import { buildTipsCatalog } from '../tips-catalog';
const TIPS_CATALOG = buildTipsCatalog([{ id: 'zeta', words: { '/zap': { tip: 'ALT-ONE zap resets the zorb', when: 'wants to begin again', alts: [] } } }]);
function ctx3(text: string): CueContext {
  return { text, words: text.split(/\s+/).filter(Boolean), sessionCommitments: WATCH, tipsCatalog: TIPS_CATALOG, cursor: text.length };
}
function router3(contradictionReply: string, tipsReply: string, askReply: string) {
  const calls = { contradiction: 0, tips: 0, ask: 0 };
  const adapter: HttpAdapter = {
    post: async (_u, body) => {
      const sys = JSON.parse(body as string).messages[0].content as string;
      const kind = sys.includes('AskUserQuestion') ? 'ask' : sys.includes('TIPS — things users') ? 'tips' : 'contradiction';
      calls[kind]++;
      const reply = kind === 'ask' ? askReply : kind === 'tips' ? tipsReply : contradictionReply;
      return JSON.stringify({ choices: [{ message: { content: reply } }] });
    },
  };
  return { adapter, calls };
}
const A_TIP = JSON.stringify([{ quote: 'lets begin again', tipId: 't1', why: 'fresh start', apply: '/zap' }]);

describe('SessionCueSource — the tips leg sits between contradiction and ask', () => {
  it('a contradiction fires → it wins; the tips call ran alongside it (parallel legs), ask is skipped', async () => {
    const { adapter, calls } = router3(CONTRADICTS, A_TIP, A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableSemanticTips: true, enableAsk: true });
    const res = await src.getCues(ctx3('please add the redis npm package now, lets begin again'));
    expect(res.results[0]?.source).toBe('sentence-cue:session-contradiction');
    expect(calls).toEqual({ contradiction: 1, tips: 1, ask: 0 });
  });
  it('no contradiction, a tip fires → ask is skipped, the tip is the result', async () => {
    const { adapter, calls } = router3('[]', A_TIP, A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableSemanticTips: true, enableAsk: true });
    const res = await src.getCues(ctx3('ok lets begin again on the zorb'));
    expect(res.results[0]?.source).toBe('sentence-cue:tip');
    expect(res.results[0]?.alternatives[1]).toBe('/zap');
    expect(calls).toEqual({ contradiction: 1, tips: 1, ask: 0 });
  });
  it('no contradiction, no tip → ask runs', async () => {
    const { adapter, calls } = router3('[]', '[]', A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableSemanticTips: true, enableAsk: true });
    const res = await src.getCues(ctx3('the new approach is way better'));
    expect(res.results[0]?.source).toBe('sentence-cue:tool-ask');
    expect(calls).toEqual({ contradiction: 1, tips: 1, ask: 1 });
  });
  it('tips off → the tips call never happens, even with a catalogue on the context', async () => {
    const { adapter, calls } = router3('[]', A_TIP, '[]');
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableSemanticTips: false, enableAsk: false });
    const res = await src.getCues(ctx3('ok lets begin again on the zorb'));
    expect(res.results).toEqual([]);
    expect(calls).toEqual({ contradiction: 1, tips: 0, ask: 0 });
  });
  it('tips-only → supports() needs a catalogue, and the tips call is the only call', async () => {
    const { adapter, calls } = router3('[]', A_TIP, '[]');
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: false, enableSemanticTips: true, enableAsk: false });
    expect(src.supports({ text: 'x', words: ['x'] })).toBe(false);
    expect(src.supports(ctx3('lets begin again'))).toBe(true);
    await src.getCues(ctx3('lets begin again'));
    expect(calls).toEqual({ contradiction: 0, tips: 1, ask: 0 });
  });
});

// ── contradiction ∥ tips (Sep 2026) ──────────────────────────────────────────
// The tips leg used to wait for the contradiction leg. Same routing as router3,
// plus a delay / a throw on the contradiction call so the ordering is observable.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function railRouter(opts: { contradiction: string | Error; contradictionDelayMs?: number; tips: string }) {
  const calls = { contradiction: 0, tips: 0, ask: 0 };
  const adapter: HttpAdapter = {
    post: async (_u, body) => {
      const sys = JSON.parse(body as string).messages[0].content as string;
      const kind = sys.includes('AskUserQuestion') ? 'ask' : sys.includes('TIPS — things users') ? 'tips' : 'contradiction';
      calls[kind]++;
      if (kind === 'ask') return JSON.stringify({ choices: [{ message: { content: A_QUESTION } }] });
      if (kind === 'tips') return JSON.stringify({ choices: [{ message: { content: opts.tips } }] });
      await sleep(opts.contradictionDelayMs ?? 0);
      if (opts.contradiction instanceof Error) throw opts.contradiction;
      return JSON.stringify({ choices: [{ message: { content: opts.contradiction } }] });
    },
  };
  return { adapter, calls };
}

describe('SessionCueSource — contradiction and tips run in parallel; contradiction wins', () => {
  it('a slow contradiction leg no longer delays the tip: the pass takes about max(legs), not their sum', async () => {
    const { adapter, calls } = railRouter({ contradiction: '[]', contradictionDelayMs: 150, tips: A_TIP });
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableAsk: false, enableSemanticTips: true });
    const t0 = Date.now();
    const res = await src.getCues(ctx3('ok lets begin again on the zorb'));
    expect(res.results[0]?.source).toBe('sentence-cue:tip');
    expect(calls).toEqual({ contradiction: 1, tips: 1, ask: 0 });
    expect(Date.now() - t0).toBeLessThan(150 + 100);   // bounded by the slow leg alone
  });
  it('both fire → the contradiction wins; the tips call was spent alongside it (the price of parallel)', async () => {
    const { adapter, calls } = railRouter({ contradiction: CONTRADICTS, tips: A_TIP });
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableAsk: true, enableSemanticTips: true });
    const res = await src.getCues(ctx3('please add the redis npm package now, lets begin again'));
    expect(res.results[0]?.source).toBe('sentence-cue:session-contradiction');
    expect(calls).toEqual({ contradiction: 1, tips: 1, ask: 0 });   // ask still short-circuited
  });
  it('a contradiction leg that throws is an empty leg — the tip still lands', async () => {
    const { adapter } = railRouter({ contradiction: new Error('network down'), tips: A_TIP });
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableAsk: false, enableSemanticTips: true });
    const res = await src.getCues(ctx3('ok lets begin again on the zorb'));
    expect(res.results[0]?.source).toBe('sentence-cue:tip');
  });
  it('neither flags → the ask leg still runs, after both', async () => {
    const { adapter, calls } = railRouter({ contradiction: '[]', tips: '[]' });
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableAsk: true, enableSemanticTips: true });
    const res = await src.getCues(ctx3('the new approach is way better'));
    expect(res.results[0]?.source).toBe('sentence-cue:tool-ask');
    expect(calls).toEqual({ contradiction: 1, tips: 1, ask: 1 });
  });
});

// ── the fused per-pause request (decision layer) ────────────────────────
import { buildTipsCatalog } from '../tips-catalog';
import { fakeLegs, type FakeLegsPlan } from '../decisions/fake-legs.test-helper';
import { DecisionError } from '../decisions/types';

const PACK_F = buildTipsCatalog([{ id: 'zeta', words: {
  '/zap': { tip: 'ALT-ONE zap resets the zorb', when: 'wants to begin again from nothing', say: 'ALT-SAY beginning again? /zap', alts: [] },
} }]);
function fctx(text: string): CueContext {
  return { text, words: text.split(/\s+/).filter(Boolean), sessionCommitments: WATCH, tipsCatalog: PACK_F, cursor: text.length };
}
/** a verdict per leg; anything not listed answers none / 0 */
function fakeFused(plan: { tip?: string; tipConf?: number; gate?: string; gateConf?: number; ask?: number; unit?: string }) {
  const p: FakeLegsPlan = {
    tips: { choice: plan.tip ?? 'none', confidence: plan.tipConf ?? 0.9 },
    contradiction: { choice: plan.gate ?? 'none', confidence: plan.gateConf ?? 0.9, unit: plan.unit ? { choice: plan.unit, confidence: plan.gateConf ?? 0.9 } : undefined },
    ask: plan.ask ?? 0,
  };
  return fakeLegs(p);
}

describe('SessionCueSource — one decision request per pause', () => {
  it('sends ONE pause call carrying the tips entries, the watchlist + units and the ask flag', async () => {
    const d = fakeFused({});
    const r = router(CONTRADICTS, A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: r.adapter, enableContradiction: true, enableAsk: true, enableSemanticTips: true, decisions: d });
    const out = await src.getCues(fctx('bumped the README badge'));
    expect(d.calls.length).toBe(1);
    expect(d.calls[0].leg).toBe('pause');
    const input = d.pauseInputs[0];
    expect(input.text).toBe('bumped the README badge');
    expect(input.tips?.map((e) => e.id)).toEqual(['t1']);
    expect(input.contradiction?.commitments).toEqual([{ id: 'c1', statement: 'Do not add new npm dependencies' }]);
    expect(input.contradiction?.units.map((u) => u.text)).toEqual(['bumped the README badge']);
    expect(input.ask).toBe(true);
    expect(input.spelling).toBe(false);
    // everything none / below the ask gate → no chat call at all
    expect(r.calls).toEqual({ contradiction: 0, ask: 0 });
    expect(out.results).toEqual([]);
  });

  it('a gate hit runs the contradiction chat call and wins; no second decision call, no ask call', async () => {
    const d = fakeFused({ gate: 'c1', gateConf: 0.95, tip: 't1', ask: 0.99 });
    const r = router(CONTRADICTS, A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: r.adapter, enableContradiction: true, enableAsk: true, enableSemanticTips: true, decisions: d });
    const out = await src.getCues(fctx('lets add the redis npm package'));
    expect(d.calls.length).toBe(1);
    expect(r.calls).toEqual({ contradiction: 1, ask: 0 });
    expect(out.results[0].cueTip).toBe('⚠ no new deps');
    expect(out.results[0].confidence).toBe(0.95);
  });

  it('a gate hit WITH a unit answer (step 6) lands with no chat call: note = the decision statement, rewrite deferred', async () => {
    const d = fakeFused({ gate: 'c1', gateConf: 0.95, unit: 's1', tip: 't1', ask: 0.99 });
    const r = router(CONTRADICTS, A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: r.adapter, enableContradiction: true, enableAsk: true, enableSemanticTips: true, decisions: d });
    const out = await src.getCues(fctx('lets add the redis npm package'));
    expect(d.calls.length).toBe(1);
    expect(r.calls).toEqual({ contradiction: 0, ask: 0 });
    expect(out.results[0].cueTip).toBe('⚠ Do not add new npm dependencies');
    expect(out.results[0].alternatives).toEqual(['lets add the redis npm package', 'lets add the redis npm package']);
    expect((out.results[0].metadata as { deferredRewrite: { quote: string } }).deferredRewrite.quote).toBe('lets add the redis npm package');
    // the rail exposes the deferred rewrite to the runtime
    expect(typeof src.reconcileContradiction).toBe('function');
  });

  it('a tip hit lands with no chat call at all', async () => {
    const d = fakeFused({ tip: 't1', tipConf: 0.8 });
    const r = router(CONTRADICTS, A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: r.adapter, enableContradiction: true, enableAsk: true, enableSemanticTips: true, decisions: d });
    const out = await src.getCues(fctx('lets begin again on the zorb'));
    expect(r.calls).toEqual({ contradiction: 0, ask: 0 });
    expect(out.results[0].alternatives).toEqual(['lets begin again on the zorb', '/zap']);
    expect(out.results[0].confidence).toBe(0.8);
  });

  it('the ask chat call runs only above the ask gate', async () => {
    const r1 = router(CONTRADICTS, A_QUESTION);
    const low = new SessionCueSource({ ...base, httpAdapter: r1.adapter, enableContradiction: true, enableAsk: true, enableSemanticTips: true, decisions: fakeFused({ ask: 0.4 }) });
    await low.getCues(fctx('do the thing'));
    expect(r1.calls.ask).toBe(0);
    const r2 = router(CONTRADICTS, A_QUESTION);
    const high = new SessionCueSource({ ...base, httpAdapter: r2.adapter, enableContradiction: true, enableAsk: true, enableSemanticTips: true, decisions: fakeFused({ ask: 0.85 }) });
    const out = await high.getCues(fctx('do the thing'));
    expect(r2.calls.ask).toBe(1);
    expect(out.results.length).toBeGreaterThan(0);
  });

  it('a failed fused request falls back to the CHAT path in the same pause (the legs do not re-ask the provider)', async () => {
    const flaky = fakeLegs({ throws: new Error('boom') });
    const r = router(CONTRADICTS, A_QUESTION);
    const lines: string[] = [];
    const src = new SessionCueSource({ ...base, httpAdapter: r.adapter, enableContradiction: true, enableSemanticTips: true, decisions: flaky, log: (m) => lines.push(m) });
    const out = await src.getCues(fctx('lets add the redis npm package'));
    expect(lines.join('\n')).toMatch(/falling back to the chat path/);
    expect(flaky.calls.length).toBe(1);
    expect(r.calls.contradiction).toBe(2);     // tips + contradiction chat calls
    expect(out.results[0].cueTip).toBe('⚠ no new deps');
  });

  it('decisionsFanout: off keeps one decision call per leg', async () => {
    const d = fakeFused({});
    const r = router(CONTRADICTS, A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: r.adapter, enableContradiction: true, enableSemanticTips: true, decisions: d, decisionsFanout: false });
    await src.getCues(fctx('bumped the README badge'));
    expect(d.calls.map((c) => c.leg).sort()).toEqual(['contradictionGate', 'tipsMatch']);
  });
});

// ── review fixes: breaker, per-leg ask gate ──────────────────────────────
describe('SessionCueSource — circuit breaker and per-leg ask gate', () => {
  it('a failed fused request trips the breaker: the SAME pause and the next run every leg on chat with no further decision call', async () => {
    const down = fakeLegs({ throws: new DecisionError('overloaded', 'typesafe: overloaded') });
    const r = router(CONTRADICTS, A_QUESTION);
    const lines: string[] = [];
    const src = new SessionCueSource({ ...base, httpAdapter: r.adapter, enableContradiction: true, enableSemanticTips: true, decisions: down, log: (m) => lines.push(m) });
    const out = await src.getCues(fctx('lets add the redis npm package'));
    expect(down.calls.length).toBe(1);                      // the fused request only; the legs did NOT retry the provider
    expect(r.calls.contradiction).toBe(2);                  // chat path ran: the tips AND contradiction chat calls (the router counts both as non-ask)
    expect(out.results[0].cueTip).toBe('⚠ no new deps');
    expect(lines.join('\n')).toMatch(/decision provider down for 30s/);
    await src.getCues(fctx('bumped the README badge'));
    expect(down.calls.length).toBe(1);                      // still down: no decision call on the next pause either
    expect(r.calls.contradiction).toBe(4);
  });

  it('an auth failure trips the breaker for the long window', async () => {
    const bad = fakeLegs({ throws: new DecisionError('auth', 'typesafe: Unauthorized') });
    const r = router(CONTRADICTS, A_QUESTION);
    const lines: string[] = [];
    const src = new SessionCueSource({ ...base, httpAdapter: r.adapter, enableSemanticTips: true, decisions: bad, log: (m) => lines.push(m) });
    await src.getCues(fctx('lets begin again on the zorb'));
    expect(lines.join('\n')).toMatch(/down for 600s \(auth/);
  });

  it('fanout off + healthy provider: the ask call is still gated by its own leg', async () => {
    const d = fakeFused({ ask: 0.2 });
    const r = router(CONTRADICTS, A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: r.adapter, enableAsk: true, decisions: d, decisionsFanout: false });
    const out = await src.getCues(fctx('do the thing'));
    expect(d.calls.map((c) => c.leg)).toEqual(['askGate']);
    expect(r.calls.ask).toBe(0);
    expect(out.results).toEqual([]);
  });
});

// ── the spelling passenger (decision layer) ─────────────────────────────
describe('SessionCueSource — the spelling passenger', () => {
  const TEXT = 'the zorb tests pass but the reconect logic is flaky';
  const sctx = (): CueContext => ({ text: TEXT, words: TEXT.split(' '), cursor: TEXT.length });
  const http: HttpAdapter & { calls: number } = { calls: 0, post: async () => { http.calls++; return JSON.stringify({ choices: [{ message: { content: '[]' } }] }); } };
  const sbase = { ...base, enableContradiction: false, enableAsk: false, enableSemanticTips: false, httpAdapter: http };

  it('a spelling verdict → a word-cue result at that index, the typed punctuation kept, no chat call', async () => {
    http.calls = 0;
    const d = fakeLegs({ spelling: { wordIndex: 6, fix: 'reconnect', flag: 0.95, fixConfidence: 0.9 } });
    const src = new SessionCueSource({ ...sbase, decisions: d, enableSpelling: true });
    expect(src.supports(sctx())).toBe(true);
    const r = await src.getCues(sctx());
    expect(d.calls.length).toBe(1);
    expect(d.pauseInputs[0].spelling).toBe(true);
    expect(http.calls).toBe(0);
    expect(r.results.map((x) => ({ wordIndex: x.wordIndex, word: x.word, alternatives: x.alternatives, source: x.source }))).toEqual([{ wordIndex: 6, word: 'reconect', alternatives: ['reconnect'], source: 'spelling' }]);
    expect(r.results[0].confidence).toBe(0.95);
  });

  it('no verdict, a verdict on a missing word, or an echo → nothing, and never a chat call', async () => {
    for (const spelling of [null, { wordIndex: 99, fix: 'x', flag: 0.9, fixConfidence: 0.9 }, { wordIndex: 6, fix: 'reconect', flag: 0.9, fixConfidence: 0.9 }]) {
      http.calls = 0;
      const r = await new SessionCueSource({ ...sbase, decisions: fakeLegs({ spelling }), enableSpelling: true }).getCues(sctx());
      expect(r.results).toEqual([]);
      expect(http.calls).toBe(0);
    }
  });

  it('without the passenger the pause input carries spelling: false and the rail does not run on spelling alone', async () => {
    const d = fakeLegs({ spelling: { wordIndex: 6, fix: 'reconnect', flag: 0.95, fixConfidence: 0.9 } });
    const src = new SessionCueSource({ ...sbase, decisions: d });
    expect(src.supports(sctx())).toBe(false);
    const r = await src.getCues(sctx());
    expect(r.results).toEqual([]);
    expect(d.pauseInputs.every((i) => !i.spelling)).toBe(true);
  });
});
