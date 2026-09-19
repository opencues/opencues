/**
 * ContradictionLlmSource on the claims leg: the package names the type, the
 * grammar cuts the operands, the verifier judges — no chat call. A failed leg
 * takes the chat parse.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ContradictionLlmSource } from './contradiction-llm-source';
import { captureClaim } from './capture';
import { fakeLegs } from '../decisions/fake-legs.test-helper';
import { getProvider } from '../llm-provider';
import type { CueContext, HttpAdapter } from '../types';

const NOW = () => new Date('2026-07-17T09:00:00');   // the 24th is a Friday
function countingAdapter(reply: string): HttpAdapter & { calls: number } {
  const a = { calls: 0, post: async () => { a.calls++; return JSON.stringify({ choices: [{ message: { content: reply } }] }); } };
  return a;
}
const base = { provider: getProvider('groq')!, endpoint: 'https://example.test/v1/chat/completions', apiKey: 'test-key', model: 'test-model', now: NOW };
const ctx = (text: string): CueContext => ({ text, words: text.split(/\s+/) });
/** a package that names the type the test says and lets the grammar cut the claim */
const naming = (types: Record<string, string>) => fakeLegs({ claims: (sentences) => sentences.map((s) => { const t = types[s.id]; const claim = t ? captureClaim(t, s.text) : null; return { id: s.id, type: (claim ? t : 'none') as never, confidence: claim ? 0.9 : 0.1, claim, top: '' }; }) });

describe('ContradictionLlmSource — the claims leg', () => {
  it('a named claim that the verifier rejects → the cue, with the correction, and no chat call', async () => {
    const http = countingAdapter('[]');
    const legs = naming({ s1: 'weekday_date' });
    const src = new ContradictionLlmSource({ ...base, httpAdapter: http, decisions: legs });
    const r = await src.getCues(ctx('See you Thursday the 24th. Thanks!'));
    assert.strictEqual(http.calls, 0);
    assert.strictEqual(r.results.length, 1);
    assert.deepStrictEqual(r.results[0].alternatives, ['Thursday the 24th', 'Friday the 24th']);
    assert.strictEqual(r.results[0].cueTip, '⚠ the 24th is a Friday, not Thursday');
    assert.strictEqual(r.results[0].source, 'sentence-cue:contradiction-weekday-date');
    // both sentences went to the leg, keyed by id
    assert.deepStrictEqual(legs.calls[0].args[0], [{ id: 's1', text: 'See you Thursday the 24th.' }, { id: 's2', text: 'Thanks!' }]);
  });

  it('a claim the maths confirms is silent; a sentence named `none` is silent', async () => {
    const http = countingAdapter('[]');
    const src = new ContradictionLlmSource({ ...base, httpAdapter: http, decisions: naming({ s1: 'bill_split' }) });
    const r = await src.getCues(ctx('Dinner was $120 between four of us so $30 each. See you Friday the 24th.'));
    assert.strictEqual(http.calls, 0);
    assert.deepStrictEqual(r.results, []);
  });

  it('a wrong split → the corrected per-person figure', async () => {
    const src = new ContradictionLlmSource({ ...base, httpAdapter: countingAdapter('[]'), decisions: naming({ s1: 'bill_split' }) });
    const r = await src.getCues(ctx('Dinner was $120 between four of us so $25 each.'));
    assert.deepStrictEqual(r.results[0]?.alternatives, ['$25 each', '$30 each']);
    assert.strictEqual(r.results[0]?.cueTip, '⚠ $120 ÷ 4 = $30 each, not $25');
  });

  it('a failed leg falls through to the chat parse', async () => {
    const http = countingAdapter('[{"type":"weekday_date","weekday":"Thursday","day":24,"month":null,"quote":"Thursday the 24th"}]');
    const src = new ContradictionLlmSource({ ...base, httpAdapter: http, decisions: fakeLegs({ throws: new Error('boom') }) });
    const r = await src.getCues(ctx('See you Thursday the 24th.'));
    assert.strictEqual(http.calls, 1);
    assert.strictEqual(r.results[0]?.cueTip, '⚠ the 24th is a Friday, not Thursday');
  });

  it('without a package the chat parse runs as before', async () => {
    const http = countingAdapter('[]');
    const src = new ContradictionLlmSource({ ...base, httpAdapter: http });
    await src.getCues(ctx('See you Thursday the 24th.'));
    assert.strictEqual(http.calls, 1);
  });
});

describe('ContradictionLlmSource — tier 5d on the rules leg', () => {
  const rules = { community: 'r/zorb', rules: [{ index: 1, name: 'ALT-RULE-ONE', description: 'zorb' }, { index: 2, name: 'ALT-RULE-TWO', description: 'zorb' }] };
  const communityRules = { refresh: async () => {}, current: () => rules };
  it('a named rule → the passive tip from the cached rule, the sentence as the span, no judge call', async () => {
    const http = countingAdapter('[]');
    const legs = fakeLegs({ claims: [], communityRules: { s2: 2 } });
    const src = new ContradictionLlmSource({ ...base, httpAdapter: http, decisions: legs, communityRules });
    const r = await src.getCues(ctx('Hello there. Buy my zorb course now.'));
    assert.strictEqual(http.calls, 0);
    assert.strictEqual(r.results.length, 1);
    assert.deepStrictEqual(r.results[0].alternatives, ['Buy my zorb course now.']);
    assert.strictEqual(r.results[0].cueTip, '⚠ may conflict with r/zorb rule 2: “ALT-RULE-TWO”');
    const ruleCall = legs.calls.find((c) => c.leg === 'communityRules')!;
    assert.deepStrictEqual(ruleCall.args[1], [{ index: 1, name: 'ALT-RULE-ONE', description: 'zorb' }, { index: 2, name: 'ALT-RULE-TWO', description: 'zorb' }]);
  });
  it('a rule number outside the posted rules is dropped; a failed leg takes the judge call', async () => {
    const src = new ContradictionLlmSource({ ...base, httpAdapter: countingAdapter('[]'), decisions: fakeLegs({ claims: [], communityRules: { s1: 9 } }), communityRules });
    assert.deepStrictEqual((await src.getCues(ctx('Buy my zorb course now.'))).results, []);
    const http = countingAdapter('[{"type":"community_rule_conflict","rule":1,"quote":"zorb course"}]');
    const src2 = new ContradictionLlmSource({ ...base, httpAdapter: http, decisions: fakeLegs({ throws: new Error('boom') }), communityRules });
    const r = await src2.getCues(ctx('Buy my zorb course now.'));
    assert.ok(http.calls >= 1);
    assert.strictEqual(r.results[0]?.cueTip, '⚠ may conflict with r/zorb rule 1: “ALT-RULE-ONE”');
  });
});
