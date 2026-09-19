import { describe, it, expect } from 'vitest';
import { TypeSafeDecisionProvider, parseTypeSafeBody, buildTypeSafeBody, TYPESAFE_PINNED_MODEL } from './typesafe';
import type { DecisionRequest } from './types';

// Fixtures are deliberately synthetic (ALT-ONE / zephyr shapes) — a fixture
// that reads like product output gets mined as documentation.
const REQ = {
  state: { draft: 'zephyr quark pending' },
  questions: {
    q_noul: { type: 'noul', instructions: 'Is `draft` about zephyr?' },
    q_choice: { type: 'choice', instructions: 'Which bucket?', criteria: { 'ALT-ONE': 'first', 'ALT-TWO': null, none: 'neither' } },
    q_score: { type: 'score', instructions: 'How quarky?', criteria: ['not', 'somewhat', 'very'] },
  },
} as const satisfies DecisionRequest;

const OK_BODY = JSON.stringify({
  model: 'jev-1.13.0',
  answers: {
    q_noul: { type: 'noul', noul: 0.91 },
    q_choice: { type: 'choice', choice: 'ALT-ONE', probabilities: { 'ALT-ONE': 0.8, 'ALT-TWO': 0.15, none: 0.05 }, confidence: 0.74 },
    q_score: { type: 'score', score: 1.3, legend: { '0': 'not', '1': 'somewhat', '2': 'very' }, probabilities: { '0': 0, '1': 0.7, '2': 0.3 }, confidence: 0.54 },
  },
  usage: { input_tokens: 349, output_tokens: 58 },
});

function fakeHttp(bodies: string[]) {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  return {
    calls,
    adapter: {
      post: async (url: string, body: string, headers: Record<string, string>) => {
        calls.push({ url, body, headers });
        const next = bodies.shift();
        if (next === undefined) throw new Error('no more fake bodies');
        if (next === '__THROW__') throw new Error('socket hang up');
        return next;
      },
    },
  };
}

describe('TypeSafeDecisionProvider', () => {
  it('sends the pinned model, bearer key and the request as-is; returns typed answers + usage', async () => {
    const http = fakeHttp([OK_BODY]);
    const p = new TypeSafeDecisionProvider({ apiKey: 'k', httpAdapter: http.adapter });
    const res = await p.ask(REQ);
    expect(http.calls[0].headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(http.calls[0].body)).toEqual({ state: REQ.state, model: TYPESAFE_PINNED_MODEL, questions: REQ.questions });
    expect(res.answers.q_noul.noul).toBe(0.91);
    expect(res.answers.q_choice.choice).toBe('ALT-ONE');
    expect(res.answers.q_choice.confidence).toBe(0.74);
    expect(res.answers.q_score.score).toBe(1.3);
    expect(res.usage).toEqual({ inputTokens: 349, outputTokens: 58 });
    expect(res.model).toBe('jev-1.13.0');
  });

  it('classifies error bodies (the adapter carries no status line)', () => {
    const k = (raw: string) => { const r = parseTypeSafeBody(raw); return r.ok ? 'ok' : r.error.kind; };
    expect(k('{"detail":{"error_type":"max_tokens_exceeded"}}')).toBe('budget');
    expect(k('{"detail":{"error_type":"system_overloaded","message":"high traffic"}}')).toBe('overloaded');
    expect(k('{"detail":"Too many choices. Must have at most 255 choices."}')).toBe('shape');
    expect(k('{"detail":"Too many score levels. Must have at most 10 levels."}')).toBe('shape');
    expect(k('{"detail":{"error_type":"api_usage_error","message":"Unknown model: jev"}}')).toBe('shape');
    expect(k('{"detail":"Unauthorized"}')).toBe('auth');
    expect(k('not json')).toBe('malformed');
    expect(k(OK_BODY)).toBe('ok');
  });

  it('retries exactly once on overloaded, then succeeds', async () => {
    const http = fakeHttp(['{"detail":{"error_type":"system_overloaded"}}', OK_BODY]);
    const p = new TypeSafeDecisionProvider({ apiKey: 'k', httpAdapter: http.adapter, sleep: async () => {} });
    const res = await p.ask(REQ);
    expect(http.calls.length).toBe(2);
    expect(res.answers.q_noul.noul).toBe(0.91);
  });

  it('surfaces overloaded after the single retry fails', async () => {
    const http = fakeHttp(['{"detail":{"error_type":"system_overloaded"}}', '{"detail":{"error_type":"system_overloaded"}}']);
    const p = new TypeSafeDecisionProvider({ apiKey: 'k', httpAdapter: http.adapter, sleep: async () => {} });
    await expect(p.ask(REQ)).rejects.toMatchObject({ name: 'DecisionError', kind: 'overloaded' });
    expect(http.calls.length).toBe(2);
  });

  it('wraps transport failures and does not retry them', async () => {
    const http = fakeHttp(['__THROW__']);
    const p = new TypeSafeDecisionProvider({ apiKey: 'k', httpAdapter: http.adapter, sleep: async () => {} });
    await expect(p.ask(REQ)).rejects.toMatchObject({ kind: 'transport' });
    expect(http.calls.length).toBe(1);
  });

  it('rejects a 200 body missing an answer for a question', async () => {
    const http = fakeHttp([JSON.stringify({ model: 'jev-1.13.0', answers: { q_noul: { type: 'noul', noul: 0.5 } }, usage: {} })]);
    const p = new TypeSafeDecisionProvider({ apiKey: 'k', httpAdapter: http.adapter });
    await expect(p.ask(REQ)).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('buildTypeSafeBody keys are exactly state/model/questions', () => {
    expect(Object.keys(JSON.parse(buildTypeSafeBody(REQ, 'm')))).toEqual(['state', 'model', 'questions']);
  });
});

