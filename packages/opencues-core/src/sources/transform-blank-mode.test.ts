/**
 * Tests for TransformBlankSource mode dispatch — pickTransformBlankMode
 * + the fused-vs-3pass branching inside getCues.
 *
 * Pins:
 *   - groq → 3-pass (single-call collapse on gpt-oss-120b, see
 *     Experiment 1 in EXPERIMENTS.md).
 *   - cerebras / gemini / claude / openai → fused (1 LLM call).
 *   - explicit `mode: '3-pass'|'fused'` overrides the provider default.
 *   - fused path issues exactly ONE LLM call on success.
 *   - 3-pass path issues at least TWO LLM calls (EXTRACT + APPLY).
 *   - fused falls through to 3-pass when REWRITE is empty (graceful
 *     degradation when the model parses but can't produce).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TransformBlankSource, pickTransformBlankMode } from './transform-blank-source';
import { getProvider } from '../llm-provider';
import type { HttpAdapter, CueContext } from '../types';

interface RecordedCall {
  body: string;
  /** Parsed user-message content. */
  userMsg: string;
}

function makeMockAdapter(responses: string[] | ((idx: number) => string)): {
  adapter: HttpAdapter;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const adapter: HttpAdapter = {
    post: async (_url, body) => {
      let userMsg = '';
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
        userMsg = parsed.messages?.find(m => m.role === 'user')?.content ?? '';
      } catch { /* leave blank */ }
      calls.push({ body, userMsg });
      const idx = calls.length - 1;
      const text = typeof responses === 'function' ? responses(idx) : responses[idx] ?? '';
      // HttpAdapter.post returns the raw JSON body string (no envelope).
      return JSON.stringify({ choices: [{ message: { content: text } }] });
    },
  };
  return { adapter, calls };
}

describe('pickTransformBlankMode — provider → mode auto-route', () => {
  it('groq defaults to 3-pass (gpt-oss-120b collapses on single-call)', () => {
    assert.strictEqual(pickTransformBlankMode('groq', undefined), '3-pass');
    assert.strictEqual(pickTransformBlankMode('groq', 'auto'), '3-pass');
  });

  it('cerebras defaults to fused (1.8-3× faster, parity-ish accuracy)', () => {
    assert.strictEqual(pickTransformBlankMode('cerebras', undefined), 'fused');
    assert.strictEqual(pickTransformBlankMode('cerebras', 'auto'), 'fused');
  });

  it('gemini, anthropic, openai default to fused (capable generalists)', () => {
    assert.strictEqual(pickTransformBlankMode('gemini', undefined), 'fused');
    assert.strictEqual(pickTransformBlankMode('anthropic', undefined), 'fused');
    assert.strictEqual(pickTransformBlankMode('openai', undefined), 'fused');
  });

  it('explicit "3-pass" wins over provider default (force-accuracy)', () => {
    assert.strictEqual(pickTransformBlankMode('cerebras', '3-pass'), '3-pass');
    assert.strictEqual(pickTransformBlankMode('gemini', '3-pass'), '3-pass');
  });

  it('explicit "fused" wins over provider default (force-speed)', () => {
    assert.strictEqual(pickTransformBlankMode('groq', 'fused'), 'fused');
  });

  it('unknown providers default to fused (best-effort for new providers)', () => {
    assert.strictEqual(pickTransformBlankMode('some-future-provider', undefined), 'fused');
  });
});

describe('TransformBlankSource — fused path issues one LLM call', () => {
  it('fused TRANSFORM with target produces 1 call + uses REWRITE directly', async () => {
    const fusedResponse = [
      'VERDICT: TRANSFORM',
      'INSTRUCTION: change boy to girl',
      'TARGET: the boy ran fast',
      'REWRITE: the girl ran fast',
    ].join('\n');
    const { adapter, calls } = makeMockAdapter([fusedResponse]);

    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
      // mode: undefined → auto → cerebras → fused
    });

    const ctx: CueContext = {
      text: 'change boy to girl _ the boy ran fast',
      words: ['change', 'boy', 'to', 'girl', '_', 'the', 'boy', 'ran', 'fast'],
    };
    const result = await source.getCues(ctx);

    assert.strictEqual(calls.length, 1, 'fused mode should issue exactly one LLM call');
    assert.strictEqual(result.results.length, 1);
    assert.deepStrictEqual(result.results[0].alternatives, [ctx.text, 'the girl ran fast']);
    assert.strictEqual(result.results[0].metadata?.pipelineMode, 'fused');
    assert.strictEqual(result.results[0].metadata?.verifyVerdict, 'SKIPPED');
  });

  it('fused TASK_ARM emits taskAction metadata (no rewrite needed)', async () => {
    const fusedResponse = [
      'VERDICT: TASK_ARM',
      'INSTRUCTION: correct spelling',
      'TARGET:',
      'REWRITE:',
    ].join('\n');
    const { adapter, calls } = makeMockAdapter([fusedResponse]);

    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
    });

    const ctx: CueContext = {
      text: 'agentically correct spelling _',
      words: ['agentically', 'correct', 'spelling', '_'],
    };
    const result = await source.getCues(ctx);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].metadata?.taskAction, 'TASK_ARM');
    assert.strictEqual(result.results[0].metadata?.taskPayload, 'correct spelling');
  });

  it('fused VERDICT=NONE returns empty results (no further calls)', async () => {
    const fusedResponse = [
      'VERDICT: NONE',
      'INSTRUCTION:',
      'TARGET:',
      'REWRITE:',
    ].join('\n');
    const { adapter, calls } = makeMockAdapter([fusedResponse]);

    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
    });

    const result = await source.getCues({
      text: 'capital of france _',
      words: ['capital', 'of', 'france', '_'],
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(result.results.length, 0);
  });

  it('fused with empty REWRITE falls back to 3-pass (graceful degradation)', async () => {
    // First call (fused) parses VERDICT+INSTRUCTION+TARGET but emits empty
    // REWRITE — model didn't produce the result in one breath. Source
    // should fall through to 3-pass starting at EXTRACT, so we expect
    // 1 (fused, ignored) + 1 (P1 EXTRACT) + 1 (P2 APPLY) ≥ 3 calls total.
    let nthCall = 0;
    const { adapter, calls } = makeMockAdapter((idx) => {
      nthCall = idx + 1;
      if (idx === 0) {
        return 'VERDICT: TRANSFORM\nINSTRUCTION: change boy to girl\nTARGET: the boy ran\nREWRITE:';
      }
      // P1 EXTRACT (idx=1)
      if (idx === 1) return 'VERDICT: TRANSFORM\nINSTRUCTION: change boy to girl\nTARGET: the boy ran';
      // P2 APPLY (idx=2)
      if (idx === 2) return 'REWRITE: the girl ran';
      // P3 VERIFY (idx=3)
      return 'VERDICT: OK\nREWRITE: the girl ran';
    });

    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
    });

    const result = await source.getCues({
      text: 'change boy to girl _ the boy ran',
      words: ['change', 'boy', 'to', 'girl', '_', 'the', 'boy', 'ran'],
    });

    // ≥3 calls = fused attempt + EXTRACT + APPLY (verify is optional).
    assert.ok(nthCall >= 3, `expected fused to fall through to 3-pass (got ${nthCall} calls)`);
    assert.strictEqual(result.results.length, 1);
    assert.deepStrictEqual(result.results[0].alternatives?.[1], 'the girl ran');
  });
});

describe('TransformBlankSource — 3-pass path on groq', () => {
  it('groq issues EXTRACT + APPLY (+ optional VERIFY) — NOT a single call', async () => {
    let callCount = 0;
    const { adapter } = makeMockAdapter((idx) => {
      callCount = idx + 1;
      if (idx === 0) return 'VERDICT: TRANSFORM\nINSTRUCTION: change boy to girl\nTARGET: the boy ran';
      if (idx === 1) return 'REWRITE: the girl ran';
      return 'VERDICT: OK\nREWRITE: the girl ran';
    });

    // Use a non-gpt-oss model name so useStrictJson() returns false and the
    // source uses the label-based prompts (which the mock above returns).
    // groq's auto-route still picks 3-pass regardless of model.
    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('groq')!,
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: 'x',
      model: 'kimi-k2-instruct',
      // mode: undefined → auto → groq → 3-pass
    });

    const result = await source.getCues({
      text: 'change boy to girl _ the boy ran',
      words: ['change', 'boy', 'to', 'girl', '_', 'the', 'boy', 'ran'],
    });

    assert.ok(callCount >= 2, `3-pass should issue ≥2 calls (EXTRACT + APPLY), got ${callCount}`);
    assert.strictEqual(result.results.length, 1);
    assert.deepStrictEqual(result.results[0].alternatives?.[1], 'the girl ran');
  });

  it('explicit mode="fused" forces fused even on groq', async () => {
    const fusedResponse = [
      'VERDICT: TRANSFORM',
      'INSTRUCTION: change boy to girl',
      'TARGET: the boy ran',
      'REWRITE: the girl ran',
    ].join('\n');
    const { adapter, calls } = makeMockAdapter([fusedResponse]);

    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('groq')!,
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: 'x',
      model: 'kimi-k2-instruct',  // non-gpt-oss → label-based prompts
      mode: 'fused', // force fused despite groq default
    });

    const result = await source.getCues({
      text: 'change boy to girl _ the boy ran',
      words: ['change', 'boy', 'to', 'girl', '_', 'the', 'boy', 'ran'],
    });

    assert.strictEqual(calls.length, 1, 'mode=fused should override groq → 3-pass auto-route');
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].metadata?.pipelineMode, 'fused');
  });
});
