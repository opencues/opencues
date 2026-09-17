/**
 * Replace-parse on the decision layer (Jev plan step 7A). Pins the pure
 * pieces (candidates, request shape, decision rule, the fused-diff value
 * derivation) and the source-level contract: with a decision provider the
 * chat detector is never dispatched, the kind/target/command answers plus
 * the fused rewrite produce the bounded-splice result through the SAME
 * verify gate, and every failure shape falls back to the fused result.
 * Fixtures are synthetic per the repo fixture rule.
 */
import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { replaceCandidates, replaceDecisionRequest, decideReplace, deriveReplaceValue, REPLACE_TARGET_THRESHOLD } from './replace-decide';
import { validateDecisionRequest } from '../decisions/dispatch';
import { TransformBlankSource } from './transform-blank-source';
import { getProvider } from '../llm-provider';
import type { HttpAdapter, CueContext } from '../types';
import type { DecisionProvider, DecisionRequest, ChoiceAnswer } from '../decisions/types';

const choice = (c: string, conf = 0.9): ChoiceAnswer => ({ type: 'choice', choice: c, probabilities: { [c]: conf }, confidence: conf });

describe('replace-decide — candidates and request', () => {
  it('targets are the words and 2-grams, punctuation-trimmed and deduped; commands are the suffixes ending at the _', () => {
    const { targets, commands } = replaceCandidates('her name is Sarha, fix the spelling _');
    assert.deepStrictEqual(targets.slice(0, 7), ['her', 'name', 'is', 'Sarha', 'fix', 'the', 'spelling']);
    assert.ok(targets.includes('her name') && targets.includes('is Sarha'));
    assert.deepStrictEqual(commands, ['spelling _', 'the spelling _', 'fix the spelling _', 'Sarha, fix the spelling _', 'is Sarha, fix the spelling _', 'name is Sarha, fix the spelling _', 'her name is Sarha, fix the spelling _']);
  });

  it('the request keys candidates and phrases by id, references them by path, and validates', () => {
    const req = replaceDecisionRequest('zephyr quark fix that _');
    assert.strictEqual((req.state as { candidates: Record<string, string> }).candidates.t1, 'zephyr');
    assert.strictEqual((req.state as { phrases: Record<string, string> }).phrases.p1, 'that _');
    assert.deepStrictEqual(Object.keys(req.questions), ['kind', 'target', 'command']);
    assert.deepStrictEqual(Object.keys(req.questions.kind.criteria), ['fill', 'replace', 'none']);
    assert.ok(Object.keys(req.questions.target.criteria).includes('none'));
    assert.doesNotThrow(() => validateDecisionRequest(req as unknown as DecisionRequest));
  });

  it('decideReplace: kind must be replace at ≥ 0.5, target a candidate at ≥ the target threshold, command a phrase', () => {
    const targets = ['zephyr', 'quark'], commands = ['fix that _'];
    const ok = decideReplace({ kind: choice('replace', 0.8), target: choice('t1', 0.7), command: choice('p1') }, targets, commands);
    assert.deepStrictEqual(ok, { target: 'zephyr', command: 'fix that _', kindConfidence: 0.8, targetConfidence: 0.7 });
    assert.strictEqual(decideReplace({ kind: choice('fill', 0.9), target: choice('t1', 0.9), command: choice('p1') }, targets, commands), null);
    assert.strictEqual(decideReplace({ kind: choice('replace', 0.4), target: choice('t1', 0.9), command: choice('p1') }, targets, commands), null);
    assert.strictEqual(decideReplace({ kind: choice('replace', 0.9), target: choice('none', 0.9), command: choice('p1') }, targets, commands), null);
    assert.strictEqual(decideReplace({ kind: choice('replace', 0.9), target: choice('t1', REPLACE_TARGET_THRESHOLD - 0.01), command: choice('p1') }, targets, commands), null);
    assert.strictEqual(decideReplace({ kind: choice('replace', 0.9), target: choice('t1', 0.9), command: choice('none') }, targets, commands), null);
  });
});

describe('replace-decide — the value from the fused rewrite', () => {
  it('a spelling fix: the changed region is inside the target (shared prefix) → the whole target and its replacement', () => {
    assert.deepStrictEqual(deriveReplaceValue('her name is Sarha fix the spelling _', 'fix the spelling _', 'Sarha', 'her name is Sarah'), { target: 'Sarha', value: 'Sarah' });
  });
  it('punctuation overhang is absorbed into the target', () => {
    assert.deepStrictEqual(deriveReplaceValue('the capital of x is munich, fix that _', 'fix that _', 'munich', 'the capital of x is Berlin.'), { target: 'munich,', value: 'Berlin.' });
  });
  it('a command in the middle: the rest of the text must survive unchanged', () => {
    assert.deepStrictEqual(deriveReplaceValue('the package is lodahs correct the typo _ then install it', 'correct the typo _', 'lodahs', 'the package is lodash then install it'), { target: 'lodahs', value: 'lodash' });
  });
  it('null when the rewrite changed something else too, or nothing, or the target is not unique, or the command is absent', () => {
    assert.strictEqual(deriveReplaceValue('alpha zephyr beta fix that _', 'fix that _', 'zephyr', 'ALPHA quark beta'), null);
    assert.strictEqual(deriveReplaceValue('alpha zephyr beta fix that _', 'fix that _', 'zephyr', 'alpha zephyr beta'), null);
    assert.strictEqual(deriveReplaceValue('zephyr and zephyr fix that _', 'fix that _', 'zephyr', 'quark and zephyr'), null);
    assert.strictEqual(deriveReplaceValue('alpha zephyr beta fix that _', 'nope _', 'zephyr', 'alpha quark beta'), null);
  });
  it('a whole-text rewrite never derives (the region overhangs the target by words)', () => {
    assert.strictEqual(deriveReplaceValue('hello world make it all caps _', 'make it all caps _', 'world', 'HELLO WORLD'), null);
  });
});

// ── the source ──────────────────────────────────────────────────────────────
const DETECT_MARKER = 'You read a short text containing _ and classify';
function mockHttp(rewrite: string): { adapter: HttpAdapter; calls: () => { fused: number; detect: number } } {
  let fused = 0, detect = 0;
  const adapter: HttpAdapter = {
    post: async (_url, body) => {
      const system: string = JSON.parse(body).messages?.[0]?.content ?? '';
      if (system.startsWith(DETECT_MARKER)) { detect++; return JSON.stringify({ choices: [{ message: { content: 'CLASS: FILL\nCOMMAND: NONE\nTARGET: NONE\nVALUE:' } }] }); }
      fused++;
      return JSON.stringify({ choices: [{ message: { content: ['VERDICT: TRANSFORM', 'INSTRUCTION: zap the word', 'TARGET: ', `REWRITE: ${rewrite}`].join('\n') } }] });
    },
  };
  return { adapter, calls: () => ({ fused, detect }) };
}
function fakeDecisions(plan: { kind: string; kindConf?: number; target: string; targetConf?: number; command?: string } | 'throw'): DecisionProvider & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  return {
    id: 'fake', model: 'x', requests,
    async ask(req) {
      requests.push(req);
      if (plan === 'throw') throw new Error('boom');
      const pick = (q: { criteria: Record<string, unknown> }, want: string, conf: number) => choice(Object.keys(q.criteria).includes(want) ? want : 'none', conf);
      const qs = req.questions as Record<string, { criteria: Record<string, unknown> }>;
      // target / command by TEXT: find the id whose state entry equals it
      const st = req.state as { candidates: Record<string, string>; phrases: Record<string, string> };
      const tId = Object.entries(st.candidates).find(([, v]) => v === plan.target)?.[0] ?? 'none';
      const cId = Object.entries(st.phrases).find(([, v]) => v === (plan.command ?? 'zap the word _'))?.[0] ?? 'none';
      return { answers: { kind: pick(qs.kind, plan.kind, plan.kindConf ?? 0.9), target: choice(tId, plan.targetConf ?? 0.9), command: choice(cId) } as never, model: 'x', usage: { inputTokens: 1, outputTokens: 1 }, ms: 1 };
    },
  };
}
const TEXT = 'alpha zephyr beta zap the word _';
const ctx = (): CueContext => ({ text: TEXT, words: TEXT.split(' ') });
function mkSource(adapter: HttpAdapter, decisions?: DecisionProvider): TransformBlankSource {
  return new TransformBlankSource({ httpAdapter: adapter, provider: getProvider('cerebras')!, endpoint: 'https://api.cerebras.ai/v1/chat/completions', apiKey: 'x', model: 'gpt-oss-120b', replaceParse: true, decisions });
}

describe('TransformBlankSource replace-parse on the decision layer', () => {
  beforeEach(() => { TransformBlankSource.resetVariantPoolForTest(); });

  it('kind + target + a fused rewrite that changed exactly the target → the bounded-splice result; the chat detector is never dispatched', async () => {
    const { adapter, calls } = mockHttp('alpha ALT-ONE beta');
    const d = fakeDecisions({ kind: 'replace', target: 'zephyr' });
    const r = await mkSource(adapter, d).getCues(ctx());
    assert.deepStrictEqual(calls(), { fused: 1, detect: 0 });
    assert.strictEqual(d.requests.length, 1);
    const res = r!.results[0];
    assert.strictEqual(res.metadata?.transformTarget, 'zephyr');
    assert.strictEqual(res.metadata?.transformInstruction, 'zap the word');
    assert.strictEqual(res.metadata?.pipelineMode, 'replace-splice-decision');
    assert.deepStrictEqual(res.alternatives, [TEXT, 'ALT-ONE']);
  });

  it('the fused rewrite changed more than the target → the fused whole-buffer result (no splice)', async () => {
    const { adapter } = mockHttp('ALPHA ALT-ONE BETA');
    const r = await mkSource(adapter, fakeDecisions({ kind: 'replace', target: 'zephyr' })).getCues(ctx());
    assert.strictEqual(r!.results[0].metadata?.transformTarget, undefined);
    assert.deepStrictEqual(r!.results[0].alternatives, [TEXT, 'ALPHA ALT-ONE BETA']);
  });

  it('kind = fill, a low-confidence target, or a thrown request → the fused result, untouched', async () => {
    for (const plan of [{ kind: 'fill', target: 'zephyr' }, { kind: 'replace', target: 'zephyr', targetConf: 0.2 }, 'throw' as const]) {
      TransformBlankSource.resetVariantPoolForTest();
      const { adapter, calls } = mockHttp('alpha ALT-ONE beta');
      const r = await mkSource(adapter, fakeDecisions(plan)).getCues(ctx());
      assert.deepStrictEqual(calls(), { fused: 1, detect: 0 });
      assert.strictEqual(r!.results[0].metadata?.transformTarget, undefined);
      assert.deepStrictEqual(r!.results[0].alternatives, [TEXT, 'alpha ALT-ONE beta']);
    }
  });

  it('without a decision provider the chat detector runs as before', async () => {
    const { adapter, calls } = mockHttp('alpha ALT-ONE beta');
    await mkSource(adapter).getCues(ctx());
    assert.deepStrictEqual(calls(), { fused: 1, detect: 1 });
  });
});
