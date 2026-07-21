/**
 * Tests for the answerCharBudget → FIELD LIMIT prompt plumbing.
 *
 * When a host declares a small visible field capacity
 * (`CueContext.answerCharBudget` — e.g. the mac host sends 37 while
 * Spotlight's search field is focused), FluidBlankSource and
 * TransformBlankSource append a FIELD LIMIT instruction to the USER
 * message of their fused calls. Two structural contracts pinned here:
 *
 *   1. USER-message only — the block must NEVER reach the SYSTEM
 *      message (per-call context would salt the cerebras prefix cache;
 *      docs/architecture/cerebras.md).
 *   2. Absent by default — no budget (or a non-positive one) leaves the
 *      prompts byte-identical to the pre-feature shape, which is what
 *      keeps the bench suites' evidence valid without re-runs.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { FluidBlankSource, renderCharBudgetBlock } from './fluid-blank-source';
import { TransformBlankSource } from './transform-blank-source';
import { getProvider } from '../llm-provider';
import type { HttpAdapter } from '../types';

interface RecordedCall {
  userMessage: string;
  systemMessage: string;
}

function makeRecordingAdapter(
  responses: readonly string[],
  recorded: RecordedCall[],
): HttpAdapter {
  let i = 0;
  return {
    post: async (_url, body) => {
      let userMessage = '';
      let systemMessage = '';
      try {
        const parsed = JSON.parse(body);
        const msgs = parsed.messages as Array<{ role: string; content: string }>;
        userMessage = msgs.find(m => m.role === 'user')?.content ?? '';
        systemMessage = msgs.find(m => m.role === 'system')?.content ?? '';
      } catch { /* unparseable */ }
      recorded.push({ userMessage, systemMessage });
      const next = responses[i++ % responses.length];
      return JSON.stringify({ choices: [{ message: { content: next } }] });
    },
  };
}

describe('renderCharBudgetBlock', () => {
  it('renders the instruction with a floored budget', () => {
    assert.match(renderCharBudgetBlock(37), /FIELD LIMIT: the destination field shows only about 37 characters/);
    assert.strictEqual(renderCharBudgetBlock(37.9), renderCharBudgetBlock(37));
  });

  it('empty on undefined / non-finite / < 1 (feature structurally off)', () => {
    assert.strictEqual(renderCharBudgetBlock(undefined), '');
    assert.strictEqual(renderCharBudgetBlock(0), '');
    assert.strictEqual(renderCharBudgetBlock(-5), '');
    assert.strictEqual(renderCharBudgetBlock(Number.NaN), '');
    assert.strictEqual(renderCharBudgetBlock(Number.POSITIVE_INFINITY), '');
  });
});

describe('FluidBlankSource — FIELD LIMIT (answerCharBudget)', () => {
  const baseConfig = {
    provider: getProvider('groq')!,
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  };

  it('appends FIELD LIMIT to the USER message — and never to SYSTEM', async () => {
    const recorded: RecordedCall[] = [];
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeRecordingAdapter(['SPAN: capital of france _\nANSWER: Paris'], recorded),
    });
    await src.getCues({
      text: 'capital of france _',
      words: ['capital', 'of', 'france', '_'],
      answerCharBudget: 37,
    });
    assert.strictEqual(recorded.length, 1, 'exactly one fused call');
    assert.match(recorded[0]!.userMessage, /FIELD LIMIT: the destination field shows only about 37 characters/);
    assert.doesNotMatch(recorded[0]!.systemMessage, /FIELD LIMIT/);
  });

  it('absent without a budget', async () => {
    const recorded: RecordedCall[] = [];
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeRecordingAdapter(['SPAN: capital of spain _\nANSWER: Madrid'], recorded),
    });
    await src.getCues({ text: 'capital of spain _', words: ['capital', 'of', 'spain', '_'] });
    assert.doesNotMatch(recorded[0]!.userMessage, /FIELD LIMIT/);
  });
});

describe('TransformBlankSource — FIELD LIMIT (answerCharBudget)', () => {
  const fused = (instruction: string, target: string, rewrite: string) =>
    `VERDICT: TRANSFORM\nINSTRUCTION: ${instruction}\nTARGET: ${target}\nFULL_REWRITE: ${rewrite}`;

  function makeFusedSource(httpAdapter: HttpAdapter): TransformBlankSource {
    return new TransformBlankSource({
      httpAdapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'test-key',
      model: 'test-model',
    });
  }

  function ctx(text: string, answerCharBudget?: number) {
    const words = text.split(/\s+/).filter(Boolean);
    return {
      text,
      words,
      blankIndices: words.map((w, i) => (w === '_' ? i : -1)).filter(i => i >= 0),
      answerCharBudget,
    };
  }

  it('appends FIELD LIMIT to the fused USER message — and never to SYSTEM', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([fused('uppercase', 'hello', 'HELLO')], recorded));
    await src.getCues(ctx('uppercase _ hello', 37));
    assert.strictEqual(recorded.length, 1, 'exactly one fused call');
    assert.match(recorded[0]!.userMessage, /FIELD LIMIT: the destination field shows only about 37 characters/);
    assert.doesNotMatch(recorded[0]!.systemMessage, /FIELD LIMIT/);
  });

  it('absent without a budget', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([fused('uppercase', 'hello', 'HELLO')], recorded));
    await src.getCues(ctx('uppercase _ hello'));
    assert.doesNotMatch(recorded[0]!.userMessage, /FIELD LIMIT/);
  });
});
