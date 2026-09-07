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
  it('a contradiction fires → tips and ask are both skipped', async () => {
    const { adapter, calls } = router3(CONTRADICTS, A_TIP, A_QUESTION);
    const src = new SessionCueSource({ ...base, httpAdapter: adapter, enableContradiction: true, enableSemanticTips: true, enableAsk: true });
    const res = await src.getCues(ctx3('please add the redis npm package now, lets begin again'));
    expect(res.results[0]?.source).toBe('sentence-cue:session-contradiction');
    expect(calls).toEqual({ contradiction: 1, tips: 0, ask: 0 });
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
