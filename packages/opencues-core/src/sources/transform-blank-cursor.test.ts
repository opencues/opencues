/**
 * Tests for TransformBlankSource — fused VERDICT:NONE cede behaviour.
 *
 * Run with: node --test dist/sources/transform-blank-cursor.test.js
 *
 * The cursor-sentinel (`[CURSOR]`) injection/stripping suites were
 * removed when TransformBlank collapsed to the single fused pipeline —
 * the fused path never injects a `[CURSOR]` sentinel. The pure helper
 * `translateBufferCursorToTargetCursor` keeps its own coverage in
 * `transform-cursor-translate.test.ts`.
 *
 * What remains here: the fused NONE cede contract — a `VERDICT: NONE`
 * fused response must cede (return empty, exactly one call) so the next
 * source (FluidBlank) can answer the `_`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TransformBlankSource } from './transform-blank-source';
import { getProvider } from '../llm-provider';
import type { HttpAdapter, CueContext } from '../types';

interface RecordedCall {
  body: string;
  /** Parsed user-message content extracted from the request body. */
  userMessage: string;
}

function makeRecordingAdapter(
  responses: readonly string[],
  recorded: RecordedCall[],
): HttpAdapter {
  let i = 0;
  return {
    post: async (_url, body) => {
      let userMessage = '';
      try {
        const parsed = JSON.parse(body);
        const msgs = parsed.messages as Array<{ role: string; content: string }>;
        userMessage = msgs.find(m => m.role === 'user')?.content ?? '';
      } catch { /* unparseable body — leave userMessage blank */ }
      recorded.push({ body, userMessage });
      const next = responses[i++ % responses.length];
      return JSON.stringify({ choices: [{ message: { content: next } }] });
    },
  };
}

function ctxWithCursor(text: string, cursor: number): CueContext {
  return {
    text,
    words: text.split(/\s+/).filter(Boolean),
    blankIndices: text.split(/\s+/).filter(Boolean)
      .map((w, i) => (w === '_' ? i : -1))
      .filter(i => i >= 0),
    cursor,
  };
}

describe('TransformBlankSource — fused VERDICT:NONE handling', () => {
  function fusedSource(httpAdapter: HttpAdapter): TransformBlankSource {
    return new TransformBlankSource({
      httpAdapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'k',
      model: 'gpt-oss-120b',
    });
  }
  const fusedNone = 'VERDICT: NONE\nINSTRUCTION:\nTARGET:\nFULL_REWRITE:';

  it('long buffer + fused NONE → cedes (returns null, one call) rather than trusting the misfire', async () => {
    const recorded: RecordedCall[] = [];
    const longBody = 'This is a long accumulated prompt body that exceeds the floor. '.repeat(8) + 'make it formal _';
    assert.ok(longBody.length > 400, 'fixture must clear the long-buffer floor');
    const src = fusedSource(makeRecordingAdapter([fusedNone], recorded));
    const out = await src.getCues(ctxWithCursor(longBody, longBody.length));
    assert.strictEqual(recorded.length, 1, 'a long-buffer NONE cedes after exactly one call');
    assert.strictEqual(out.results.length, 0, 'long NONE yields empty so the next source can handle the `_`');
  });

  it('short buffer + fused NONE → cedes after one call (genuine lookup, FluidBlank answers it)', async () => {
    const recorded: RecordedCall[] = [];
    const src = fusedSource(makeRecordingAdapter([fusedNone], recorded));
    const out = await src.getCues(ctxWithCursor('capital of france _', 18));
    assert.strictEqual(recorded.length, 1, 'a short NONE must cede after exactly one call');
    assert.strictEqual(out.results.length, 0, 'short NONE yields empty so FluidBlank can answer');
  });
});
