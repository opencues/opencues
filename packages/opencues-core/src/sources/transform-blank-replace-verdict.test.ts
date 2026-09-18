/**
 * TransformBlankSource with a `replace` decision leg: the verdict names the
 * target and the command; the value comes off the fused rewrite's diff.
 * Fixtures are synthetic (alpha / zephyr / ALT-ONE).
 */
import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { TransformBlankSource } from './transform-blank-source';
import { getProvider } from '../llm-provider';
import type { HttpAdapter, CueContext } from '../types';
import { fakeLegs } from '../decisions/fake-legs.test-helper';
import type { DecisionLegs, ReplaceVerdict } from '../decisions/legs';

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
const verdict = (target: string, command = 'zap the word _'): ReplaceVerdict => ({ target, command, kind: 'replace', confidence: 0.9, summary: 'kind replace 0.90' });
const TEXT = 'alpha zephyr beta zap the word _';
const ctx = (): CueContext => ({ text: TEXT, words: TEXT.split(' ') });
function mkSource(adapter: HttpAdapter, decisions?: DecisionLegs): TransformBlankSource {
  return new TransformBlankSource({ httpAdapter: adapter, provider: getProvider('cerebras')!, endpoint: 'https://api.cerebras.ai/v1/chat/completions', apiKey: 'x', model: 'gpt-oss-120b', replaceParse: true, decisions });
}

describe('TransformBlankSource replace-parse on the decision layer', () => {
  beforeEach(() => { TransformBlankSource.resetVariantPoolForTest(); });

  it('a verdict + a fused rewrite that changed exactly the target → the bounded-splice result; the chat detector is never dispatched', async () => {
    const { adapter, calls } = mockHttp('alpha ALT-ONE beta');
    const d = fakeLegs({ replace: verdict('zephyr') });
    const r = await mkSource(adapter, d).getCues(ctx());
    assert.deepStrictEqual(calls(), { fused: 1, detect: 0 });
    assert.strictEqual(d.calls.length, 1);
    assert.strictEqual(d.calls[0].leg, 'replace');
    assert.strictEqual(d.calls[0].args[0], TEXT);
    const res = r!.results[0];
    assert.strictEqual(res.metadata?.transformTarget, 'zephyr');
    assert.strictEqual(res.metadata?.transformInstruction, 'zap the word');
    assert.strictEqual(res.metadata?.pipelineMode, 'replace-splice-decision');
    assert.deepStrictEqual(res.alternatives, [TEXT, 'ALT-ONE']);
  });

  it('the fused rewrite changed more than the target → the fused whole-buffer result (no splice)', async () => {
    const { adapter } = mockHttp('ALPHA ALT-ONE BETA');
    const r = await mkSource(adapter, fakeLegs({ replace: verdict('zephyr') })).getCues(ctx());
    assert.strictEqual(r!.results[0].metadata?.transformTarget, undefined);
    assert.deepStrictEqual(r!.results[0].alternatives, [TEXT, 'ALPHA ALT-ONE BETA']);
  });

  it('a null verdict or a thrown request → the fused result, untouched', async () => {
    for (const legs of [fakeLegs({ replace: null }), fakeLegs({ throws: new Error('boom') })]) {
      TransformBlankSource.resetVariantPoolForTest();
      const { adapter, calls } = mockHttp('alpha ALT-ONE beta');
      const r = await mkSource(adapter, legs).getCues(ctx());
      assert.deepStrictEqual(calls(), { fused: 1, detect: 0 });
      assert.strictEqual(r!.results[0].metadata?.transformTarget, undefined);
      assert.deepStrictEqual(r!.results[0].alternatives, [TEXT, 'alpha ALT-ONE beta']);
    }
  });

  it('without decision legs the chat detector runs as before', async () => {
    const { adapter, calls } = mockHttp('alpha ALT-ONE beta');
    await mkSource(adapter).getCues(ctx());
    assert.deepStrictEqual(calls(), { fused: 1, detect: 1 });
  });
});
