import { describe, it, expect, afterEach } from 'vitest';
import { TypeSafeDecisionProvider, parseTypeSafeBody, buildTypeSafeBody, TYPESAFE_PINNED_MODEL } from './typesafe';
import { ChatFallbackDecisionProvider, extractJsonObject } from './chat-fallback';
import { dispatchDecision, validateDecisionRequest, applyDecisionDehydrationFloor } from './dispatch';
import { DecisionError, DECISION_LIMITS, type DecisionRequest } from './types';
import { setOutboundDehydrationGuard } from '../llm-provider';
import { registerUsageSink, type UsageEvent } from '../usage-meter';
import { compileDehydrator } from '../dehydrate';

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

describe('validateDecisionRequest', () => {
  it('rejects an array-index path reference in instructions', () => {
    const bad = { state: { rules: ['a', 'b'] }, questions: { q: { type: 'noul', instructions: 'Does `draft` violate `rules[1]`?' } } } as const;
    expect(() => validateDecisionRequest(bad)).toThrow(/array index/);
  });
  it('accepts a name-keyed path reference', () => {
    const ok = { state: { rules: { r1: 'a' } }, questions: { q: { type: 'noul', instructions: 'Does `draft` violate `rules.r1`?' } } } as const;
    expect(() => validateDecisionRequest(ok)).not.toThrow();
  });
  it('enforces the option and level limits', () => {
    const many: Record<string, null> = {};
    for (let i = 0; i <= DECISION_LIMITS.maxChoiceOptions; i++) many[`o${i}`] = null;
    expect(() => validateDecisionRequest({ state: 's', questions: { q: { type: 'choice', instructions: 'x', criteria: many } } })).toThrow(/256 options/);
    expect(() => validateDecisionRequest({ state: 's', questions: { q: { type: 'score', instructions: 'x', criteria: ['only'] } } })).toThrow(/1 levels/);
    expect(() => validateDecisionRequest({ state: 's', questions: { q: { type: 'score', instructions: 'x', criteria: Array(11).fill('l') } } })).toThrow(/11 levels/);
    expect(() => validateDecisionRequest({ state: 's', questions: {} })).toThrow(/at least one question/);
  });
});

describe('dispatchDecision', () => {
  afterEach(() => setOutboundDehydrationGuard(null));

  it('dehydrates every string in the state, leaves question text alone, and warns on a question hit', async () => {
    const guard = compileDehydrator(new Map([['FIRST_NAME', 'Zephyrina']]));
    setOutboundDehydrationGuard(() => guard);
    const req = {
      state: { draft: 'Zephyrina is pending', nested: ['hello Zephyrina', { deep: 'Zephyrina again' }] },
      questions: { q: { type: 'noul', instructions: 'Is Zephyrina mentioned?' } },
    } as const;
    const warnings: string[] = [];
    const out = applyDecisionDehydrationFloor(req, (m) => warnings.push(m));
    expect(JSON.stringify(out.state)).not.toContain('Zephyrina');
    expect(JSON.stringify(out.state)).toContain('FIRST_NAME');
    expect(out.questions.q.instructions).toContain('Zephyrina');
    expect(warnings.some((w) => /QUESTION text/.test(w))).toBe(true);
    expect(warnings.some((w) => /caught 3 residual/.test(w))).toBe(true);
  });

  it('reports usage to the meter under providerId typesafe and logs one line per call', async () => {
    const events: UsageEvent[] = [];
    const off = registerUsageSink((e) => events.push(e));
    try {
      const http = fakeHttp([OK_BODY]);
      const p = new TypeSafeDecisionProvider({ apiKey: 'k', httpAdapter: http.adapter });
      const lines: string[] = [];
      await dispatchDecision(p, REQ, { leg: 'tips', log: (l) => lines.push(l) });
      expect(events).toEqual([{ providerId: 'typesafe', model: 'jev-1.13.0', promptTokens: 349, cachedTokens: 0, completionTokens: 58 }]);
      expect(lines[0]).toMatch(/^\[decision\]\[tips\] typesafe\/jev-1\.13\.0 3q 349in\/58out \d+ms$/);
    } finally { off(); }
  });

  it('never swallows a failure: logs it and rethrows a DecisionError', async () => {
    const http = fakeHttp(['{"detail":{"error_type":"max_tokens_exceeded"}}']);
    const p = new TypeSafeDecisionProvider({ apiKey: 'k', httpAdapter: http.adapter });
    const lines: string[] = [];
    await expect(dispatchDecision(p, REQ, { log: (l) => lines.push(l) })).rejects.toBeInstanceOf(DecisionError);
    expect(lines.join('\n')).toMatch(/failed \(budget\)/);
  });
});

describe('ChatFallbackDecisionProvider', () => {
  it('turns a JSON reply into the same answer contract, spreading the remainder evenly', async () => {
    const chat = async () => 'Sure:\n```json\n{"q_noul":{"noul":0.2},"q_choice":{"choice":"ALT-TWO","confidence":0.7},"q_score":{"level":2,"confidence":0.9}}\n```';
    const p = new ChatFallbackDecisionProvider(chat, 'fake-chat');
    const res = await p.ask(REQ);
    expect(res.answers.q_noul.noul).toBe(0.2);
    expect(res.answers.q_choice.choice).toBe('ALT-TWO');
    expect(res.answers.q_choice.probabilities['ALT-TWO']).toBe(0.7);
    expect(res.answers.q_choice.probabilities['ALT-ONE']).toBeCloseTo(0.15, 10);
    expect(res.answers.q_choice.probabilities.none).toBeCloseTo(0.15, 10);
    expect(res.answers.q_score.score).toBeCloseTo(0 * 0.05 + 1 * 0.05 + 2 * 0.9, 5);
    expect(res.model).toBe('fake-chat');
  });
  it('falls back to the first option on an unknown choice id and clamps confidence', async () => {
    const p = new ChatFallbackDecisionProvider(async () => '{"q_choice":{"choice":"NOPE","confidence":7}}', 'fake');
    const res = await p.ask({ state: 's', questions: { q_choice: REQ.questions.q_choice } });
    expect(res.answers.q_choice.choice).toBe('ALT-ONE');
    expect(res.answers.q_choice.confidence).toBe(1);
  });
  it('rejects a reply with no JSON object', async () => {
    const p = new ChatFallbackDecisionProvider(async () => 'no idea', 'fake');
    await expect(p.ask(REQ)).rejects.toMatchObject({ kind: 'malformed' });
  });
  it('extractJsonObject finds the first balanced object', () => {
    expect(extractJsonObject('x {"a":{"b":1}} y {"c":2}')).toEqual({ a: { b: 1 } });
    expect(extractJsonObject('nothing')).toBeNull();
  });
});

// ── the `_` router (Jev plan step 5) ───────────────────────────────────────
import { decideUnderscoreRoute, underscoreRouteRequest, underscoreRouteDraft, routeUnderscore, UNDERSCORE_ROUTE_SOURCES, UNDERSCORE_CHAT_SOURCE_IDS } from './underscore-router';
import { DecisionBreaker, DECISIONS_BREAKER_MS, DECISIONS_BREAKER_AUTH_MS } from './breaker';
import type { DecisionProvider } from './types';

const routeAnswers = (choice: string, confidence: number, nouls: Partial<Record<'settings' | 'transform' | 'lookup', number>> = {}) => ({
  route: { choice, confidence, probabilities: { [choice]: confidence } },
  is_settings: { noul: nouls.settings ?? 0.9 },
  is_transform: { noul: nouls.transform ?? 0.9 },
  is_lookup: { noul: nouls.lookup ?? 0.9 },
});

describe('underscore router', () => {
  it('the stacked request: one choice over five kinds + one agreement noul per chat route, state keyed `draft`', () => {
    const req = underscoreRouteRequest('zephyr quark _');
    expect(req.state).toEqual({ draft: 'zephyr quark _' });
    expect(Object.keys(req.questions)).toEqual(['route', 'is_settings', 'is_transform', 'is_lookup']);
    expect(Object.keys(req.questions.route.criteria)).toEqual(['settings', 'transform', 'lookup', 'device', 'other']);
    expect(() => validateDecisionRequest(req)).not.toThrow();
  });

  it('routes only when the choice is a chat route, clears the threshold AND its noul agrees', () => {
    expect(decideUnderscoreRoute(routeAnswers('lookup', 0.8), 1).sourceId).toBe('fluid-blank');
    expect(decideUnderscoreRoute(routeAnswers('settings', 0.8), 1).sourceId).toBe('config-intent');
    expect(decideUnderscoreRoute(routeAnswers('transform', 0.8), 1).sourceId).toBe('transform-blank');
    // below threshold
    expect(decideUnderscoreRoute(routeAnswers('lookup', 0.4), 1).sourceId).toBeNull();
    // disagreement: the choice says transform, the transform noul says no
    expect(decideUnderscoreRoute(routeAnswers('transform', 0.9, { transform: 0.2 }), 1).sourceId).toBeNull();
    // device / other never restrict the pass
    expect(decideUnderscoreRoute(routeAnswers('device', 0.99), 1).sourceId).toBeNull();
    expect(decideUnderscoreRoute(routeAnswers('other', 0.99), 1).sourceId).toBeNull();
    // custom threshold
    expect(decideUnderscoreRoute(routeAnswers('lookup', 0.6), 1, 0.7).sourceId).toBeNull();
  });

  it('the chat source id set is exactly the three routed sources', () => {
    expect([...UNDERSCORE_CHAT_SOURCE_IDS].sort()).toEqual(Object.values(UNDERSCORE_ROUTE_SOURCES).sort());
  });

  it('windows a long buffer around the `_`', () => {
    const long = 'a'.repeat(9000) + ' zephyr _ ' + 'b'.repeat(3000);
    const d = underscoreRouteDraft(long, 1000);
    expect(d.length).toBe(1000);
    expect(d).toContain('zephyr _');
    expect(underscoreRouteDraft('short _')).toBe('short _');
  });

  it('routeUnderscore dehydrates the draft in identity safe mode before it ships, and logs the decision', async () => {
    const seen: string[] = [];
    const fake: DecisionProvider = {
      id: 'fake', model: 'x',
      async ask(req) {
        seen.push((req.state as { draft: string }).draft);
        return { answers: routeAnswers('lookup', 0.9) as never, model: 'x', usage: { inputTokens: 1, outputTokens: 1 }, ms: 3 };
      },
    };
    const lines: string[] = [];
    const catalog = new Map([['[ZEPHYR_NAME]', 'Quarkle']]);
    const r = await routeUnderscore(fake, 'email Quarkle about _', { identityContext: { mode: 'safe', catalog }, log: (l) => lines.push(l) });
    expect(seen[0]).toBe('email [ZEPHYR_NAME] about _');
    expect(r.sourceId).toBe('fluid-blank');
    expect(lines.some((l) => l.includes('[decision][route]') && l.includes('fluid-blank'))).toBe(true);
    // raw mode: untouched
    await routeUnderscore(fake, 'email Quarkle about _', { identityContext: { mode: 'raw', catalog } });
    expect(seen[1]).toBe('email Quarkle about _');
  });

  it('routeUnderscore surfaces the provider failure (the caller owns the breaker)', async () => {
    const bad: DecisionProvider = { id: 'bad', model: 'x', async ask() { throw new DecisionError('overloaded', 'busy'); } };
    await expect(routeUnderscore(bad, 'x _')).rejects.toMatchObject({ kind: 'overloaded' });
  });
});

describe('DecisionBreaker', () => {
  it('opens a 30s window on a plain failure and a 10 min window on auth, logging once per trip', () => {
    const lines: string[] = [];
    const b = new DecisionBreaker((l) => lines.push(l), 'zephyr');
    expect(b.healthy()).toBe(true);
    b.trip({ kind: 'transport', message: 'boom' });
    expect(b.healthy()).toBe(false);
    expect(lines[0]).toMatch(/^zephyr: decision provider down for 30s/);
    expect(DECISIONS_BREAKER_MS).toBe(30_000);
    expect(DECISIONS_BREAKER_AUTH_MS).toBe(600_000);
    b.trip({ kind: 'auth', message: 'no key' });
    expect(lines[1]).toMatch(/down for 600s \(auth/);
  });
});
