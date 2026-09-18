import { describe, it, expect, afterEach } from 'vitest';
import type { DecisionProvider } from './types';
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


/** a provider that answers with OK_BODY's answers, or throws a typed error */
function fakeProvider(fail?: { kind: 'budget' | 'transport'; message: string }): DecisionProvider {
  const body = JSON.parse(OK_BODY) as { answers: Record<string, unknown>; usage: { input_tokens: number; output_tokens: number } };
  return {
    id: 'typesafe', model: 'jev-1.13.0',
    async ask() {
      if (fail) throw new DecisionError(fail.kind, fail.message);
      return { answers: body.answers as never, model: 'jev-1.13.0', usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens }, ms: 3 };
    },
  };
}

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
      const lines: string[] = [];
      await dispatchDecision(fakeProvider(), REQ, { leg: 'tips', log: (l) => lines.push(l) });
      expect(events).toEqual([{ providerId: 'typesafe', model: 'jev-1.13.0', promptTokens: 349, cachedTokens: 0, completionTokens: 58 }]);
      expect(lines[0]).toMatch(/^\[decision\]\[tips\] typesafe\/jev-1\.13\.0 3q 349in\/58out \d+ms$/);
    } finally { off(); }
  });

  it('never swallows a failure: logs it and rethrows a DecisionError', async () => {
    const lines: string[] = [];
    await expect(dispatchDecision(fakeProvider({ kind: 'budget', message: 'max_tokens_exceeded' }), REQ, { log: (l) => lines.push(l) })).rejects.toBeInstanceOf(DecisionError);
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

// ── the `_` router (decision layer) ───────────────────────────────────────
import { DecisionBreaker, DECISIONS_BREAKER_MS, DECISIONS_BREAKER_AUTH_MS } from './breaker';

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
