/**
 * Spelling as a passenger on the pause request (Jev plan step 7B). Pins the
 * pure pieces (eligibility, the detect question keyed by word index, the
 * flag rule, the edit-1 neighbourhood, the fix rule with case) and the rail:
 * a flagged word yields ONE extra small request and a word-cue result next
 * to whatever the rail emits; `none`, a low flag, no one-edit fix or a
 * failed fix request yield nothing; without the passenger nothing is asked.
 * Fixtures are synthetic per the repo fixture rule.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spellingEligible, spellingDetect, spellingFlag, edits1, spellingFixRequest, spellingFix, SPELLING_FLAG_THRESHOLD } from './spelling-decide';
import { validateDecisionRequest } from '../decisions/dispatch';
import { SessionCueSource } from './session-cue-source';
import { getProvider } from '../llm-provider';
import type { CueContext, HttpAdapter } from '../types';
import type { ChoiceAnswer, DecisionProvider, DecisionRequest } from '../decisions/types';

const choice = (c: string, conf = 0.9): ChoiceAnswer => ({ type: 'choice', choice: c, probabilities: { [c]: conf }, confidence: conf });

describe('spelling-decide — pure pieces', () => {
  it('eligibility: letters only, 3+ chars, not an acronym, not code / paths / numbers', () => {
    for (const w of ['zephyr', 'Quark,', 'behaviour', 'colour']) assert.ok(spellingEligible(w), w);
    for (const w of ['ab', 'CI', 'JWT', 'v1.2', '@opencues/core', 'foo_bar', 'x-y', '20', '/tmp/a', "it's"]) assert.ok(!spellingEligible(w), w);
  });

  it('the detect question keeps the ORIGINAL word index in its ids and validates', () => {
    const d = spellingDetect(['ab', 'zephyr', 'CI', 'quark,', 'quark'])!;
    assert.deepStrictEqual(d.ids, ['w2', 'w4', 'w5']);
    assert.deepStrictEqual(d.state, { w2: 'zephyr', w4: 'quark', w5: 'quark' });
    assert.deepStrictEqual(Object.keys(d.question.criteria), ['w2', 'w4', 'w5', 'none']);
    assert.doesNotThrow(() => validateDecisionRequest({ state: { draft: 'x', words: d.state }, questions: { typo: d.question } }));
    assert.strictEqual(spellingDetect(['ab', 'CI']), null);
  });

  it('the flag rule: a word at ≥ the threshold, mapped back to its index; none / low → null', () => {
    assert.strictEqual(spellingFlag(choice('w4', 0.9)), 3);
    assert.strictEqual(spellingFlag(choice('w4', SPELLING_FLAG_THRESHOLD - 0.01)), null);
    assert.strictEqual(spellingFlag(choice('none', 0.99)), null);
  });

  it('edits1: the common shapes first, the typed word excluded, capped for the option limit', () => {
    const e = edits1('zephr');
    assert.ok(e.includes('zephyr'), 'insert');
    assert.ok(e.includes('zeph'), 'delete');
    assert.ok(e.includes('zehpr'), 'transpose');
    assert.ok(e.includes('zepphr'), 'double');
    assert.ok(!e.includes('zephr'));
    assert.ok(e.indexOf('zeph') < e.indexOf('zephyr'), 'deletions rank before insertions');
    assert.ok(edits1('exponentialy').length <= 254);
    assert.ok(edits1('exponentialy').includes('exponentially'));
  });

  it('the fix request lowercases for candidates; the fix keeps the typed capital and never echoes the word', () => {
    const req = spellingFixRequest('Zephr is here', 'Zephr');
    assert.ok(req.candidates.includes('zephyr'));
    assert.doesNotThrow(() => validateDecisionRequest(req));
    const id = `c${req.candidates.indexOf('zephyr') + 1}`;
    assert.strictEqual(spellingFix(choice(id, 0.9), req.candidates, 'Zephr'), 'Zephyr');
    assert.strictEqual(spellingFix(choice(id, 0.9), req.candidates, 'zephr'), 'zephyr');
    assert.strictEqual(spellingFix(choice(id, 0.3), req.candidates, 'zephr'), null);
    assert.strictEqual(spellingFix(choice('none', 0.9), req.candidates, 'zephr'), null);
  });
});

// ── the rail ────────────────────────────────────────────────────────────────
const TEXT = 'the zorb tests pass but the reconect logic is flaky';
const ctx = (): CueContext => ({ text: TEXT, words: TEXT.split(' '), cursor: TEXT.length });
const http: HttpAdapter & { calls: number } = { calls: 0, post: async () => { http.calls++; return JSON.stringify({ choices: [{ message: { content: '[]' } }] }); } };
const base = { provider: getProvider('cerebras')!, endpoint: 'https://example.test', apiKey: 'x', model: 'm', enableContradiction: false, enableAsk: false, enableSemanticTips: false, httpAdapter: http };
function fakeDecisions(plan: { typo?: string; typoConf?: number; fix?: string; fixConf?: number; fixThrows?: boolean }): DecisionProvider & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  return {
    id: 'fake', model: 'x', requests,
    async ask(req) {
      requests.push(req);
      const qs = req.questions as Record<string, { criteria?: Record<string, string> }>;
      if (qs.typo) return { answers: { typo: choice(plan.typo ?? 'none', plan.typoConf ?? 0.95) } as never, model: 'x', usage: { inputTokens: 1, outputTokens: 1 }, ms: 1 };
      if (qs.fix) {
        if (plan.fixThrows) throw new Error('boom');
        const st = req.state as { candidates: Record<string, string> };
        const id = Object.entries(st.candidates).find(([, v]) => v === plan.fix)?.[0] ?? 'none';
        return { answers: { fix: choice(id, plan.fixConf ?? 0.9) } as never, model: 'x', usage: { inputTokens: 1, outputTokens: 1 }, ms: 1 };
      }
      throw new Error('unexpected request');
    },
  };
}

describe('SessionCueSource — the spelling passenger', () => {
  it('a flagged word → one fix request → a word-cue result at that index, no chat call', async () => {
    http.calls = 0;
    const d = fakeDecisions({ typo: 'w7', fix: 'reconnect' });   // "reconect" is words[6]
    const src = new SessionCueSource({ ...base, decisions: d, enableSpelling: true });
    assert.ok(src.supports(ctx()));
    const r = await src.getCues(ctx());
    assert.strictEqual(d.requests.length, 2);
    assert.ok('typo' in d.requests[0].questions && 'words' in (d.requests[0].state as object));
    assert.strictEqual(http.calls, 0);
    assert.deepStrictEqual(r.results.map((x) => ({ wordIndex: x.wordIndex, word: x.word, alternatives: x.alternatives, source: x.source })), [{ wordIndex: 6, word: 'reconect', alternatives: ['reconnect'], source: 'spelling' }]);
    assert.strictEqual(r.results[0].confidence, 0.95);
  });

  it('none, a low flag, no one-edit fix, or a failed fix request → nothing, and never a chat call', async () => {
    for (const plan of [{ typo: 'none' }, { typo: 'w7', typoConf: 0.6, fix: 'reconnect' }, { typo: 'w7', fix: 'zzz' }, { typo: 'w7', fixThrows: true }]) {
      http.calls = 0;
      const d = fakeDecisions(plan);
      const r = await new SessionCueSource({ ...base, decisions: d, enableSpelling: true }).getCues(ctx());
      assert.deepStrictEqual(r.results, [], JSON.stringify(plan));
      assert.strictEqual(http.calls, 0);
      assert.ok(d.requests.length <= 2);
    }
  });

  it('without the passenger the pause request carries no typo question and the rail does not run on spelling alone', async () => {
    const d = fakeDecisions({ typo: 'w7', fix: 'reconnect' });
    const src = new SessionCueSource({ ...base, decisions: d });
    assert.ok(!src.supports(ctx()));
    const r = await src.getCues(ctx());
    assert.deepStrictEqual(r.results, []);
    assert.ok(d.requests.every((q) => !('typo' in q.questions)));
  });
});
