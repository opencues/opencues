/**
 * Tests for the FILL-PLACEHOLDER behaviour of TransformBlankSource.
 *
 * Bug (June 2026): a transform command issued at the BOTTOM of a long
 * document ("…+44 7700 900123 add recipient name Karen _") over a buffer
 * containing a matching placeholder at the TOP ("Dear [Recipient Name],")
 * was nondeterministic on the FUSED path (cerebras): the model sometimes
 * FILLED the placeholder ("Dear Karen,") and sometimes APPENDED a literal
 * "Recipient Name: Karen" line, leaving the placeholder untouched. Root
 * cause: the fused prompt had an ADD/APPEND rule but NO placeholder-fill
 * rule — the 3-pass APPLY prompt (groq path) already had one (rule #12a),
 * so groq filled and cerebras drifted. Fix: port a FILL PLACEHOLDER rule
 * into FUSED_SYSTEM with precedence over ADD/APPEND, matching the chosen
 * "prefer filling the placeholder" behaviour.
 *
 * These are deterministic pins:
 *   1. PROMPT CONTRACT — both prompts (fused + 3-pass APPLY) must carry a
 *      placeholder-fill rule with precedence over append. A mock can't
 *      validate prompt CONTENT (it returns canned output), so this guard
 *      is what stops the rule being silently deleted; the real accuracy
 *      validation is the LLM bench (tests/benchmarks/transform-blank,
 *      `targeted-placeholder-*` cases).
 *   2. PLUMBING — a fill-shaped fused response is carried through getCues
 *      as a whole-buffer substitute (placeholder filled, command stripped),
 *      not dropped or mangled.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TransformBlankSource, FUSED_SYSTEM, P2_APPLY_SYSTEM } from './transform-blank-source';
import { getProvider } from '../llm-provider';
import type { HttpAdapter, CueContext } from '../types';

function mockAdapter(responses: string[]): { adapter: HttpAdapter; calls: number } {
  const state = { calls: 0 };
  const adapter: HttpAdapter = {
    post: async (_url, _body) => {
      const text = responses[state.calls] ?? '';
      state.calls++;
      return JSON.stringify({ choices: [{ message: { content: text } }] });
    },
  };
  return { adapter, get calls() { return state.calls; } };
}

describe('TransformBlank — FILL PLACEHOLDER prompt contract', () => {
  it('FUSED_SYSTEM carries a placeholder-fill rule with precedence over append', () => {
    assert.match(FUSED_SYSTEM, /FILL PLACEHOLDER/,
      'fused prompt must name the FILL PLACEHOLDER rule');
    assert.match(FUSED_SYSTEM, /takes precedence over ADD\/APPEND/i,
      'fill rule must declare precedence over the append rule');
    // The canonical failing instruction must appear as a worked example so
    // the model has a concrete fill-not-append anchor.
    assert.match(FUSED_SYSTEM, /add recipient name Karen/,
      'fused prompt must include the recipient-name fill example');
    assert.match(FUSED_SYSTEM, /Dear Karen,/,
      'fused example must show the placeholder filled, not appended');
  });

  it('3-pass APPLY prompt still carries its FILL PLACEHOLDER rule (the bug-class twin)', () => {
    assert.match(P2_APPLY_SYSTEM, /FILL PLACEHOLDER/,
      '3-pass APPLY prompt must keep its placeholder-fill rule');
  });
});

describe('TransformBlank — FILL PLACEHOLDER plumbing (fused)', () => {
  const letter = [
    'Dear [Recipient Name],',
    '',
    'I am writing to formally resign, effective [Date].',
    '',
    'Sincerely,',
    'Wilfred add recipient name Karen _',
  ].join('\n');

  const filled = [
    'Dear Karen,',
    '',
    'I am writing to formally resign, effective [Date].',
    '',
    'Sincerely,',
    'Wilfred',
  ].join('\n');

  it('carries a fill-shaped fused response through as a whole-buffer substitute', async () => {
    const fusedResponse = [
      'VERDICT: TRANSFORM',
      'INSTRUCTION: add recipient name Karen',
      `TARGET: ${letter.replace(' add recipient name Karen _', '')}`,
      `FULL_REWRITE: ${filled}`,
    ].join('\n');
    const { adapter } = mockAdapter([fusedResponse]);

    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b', // cerebras → fused
    });

    const words = letter.split(/\s+/).filter(Boolean);
    const ctx: CueContext = {
      text: letter,
      words,
      blankIndices: words.map((w, i) => (w === '_' ? i : -1)).filter(i => i >= 0),
    };
    const result = await source.getCues(ctx);

    assert.strictEqual(result.results.length, 1, 'one substitute expected');
    const alts = result.results[0].alternatives;
    assert.strictEqual(alts[0], letter, 'alternatives[0] is the original buffer');
    assert.strictEqual(alts[1], filled, 'alternatives[1] is the filled buffer');
    // The placeholder is gone and the command tokens are stripped.
    assert.doesNotMatch(alts[1], /\[Recipient Name\]/, 'placeholder must be filled');
    assert.doesNotMatch(alts[1], /add recipient name Karen/, 'command must be stripped');
    assert.doesNotMatch(alts[1], /Recipient Name:\s*Karen/i, 'value must NOT be appended as a label line');
    assert.match(alts[1], /Dear Karen,/, 'greeting filled in place');
  });
});
