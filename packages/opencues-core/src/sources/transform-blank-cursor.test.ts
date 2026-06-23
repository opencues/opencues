/**
 * Tests for TransformBlankSource — fused VERDICT:NONE cede behaviour
 * AND cursor-anchor handling.
 *
 * Run with: node --test dist/sources/transform-blank-cursor.test.js
 *
 * Cursor anchor: positional instructions ("add a line break here",
 * "split this paragraph here", "insert X here") carry a `[CURSOR]` marker
 * injected into the fused INPUT at the user's caret offset. Injection is
 * GATED on a positional cue so non-positional transforms aren't distracted
 * by a marker; any `[CURSOR]` the model leaks into FULL_REWRITE is
 * stripped. The pure helper `translateBufferCursorToTargetCursor` keeps
 * its own coverage in `transform-cursor-translate.test.ts`.
 *
 * NONE cede contract: a `VERDICT: NONE` fused response must cede (return
 * empty, exactly one call) so the next source (FluidBlank) can answer `_`.
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
  /** Parsed system-message content. */
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
      } catch { /* unparseable body — leave blank */ }
      recorded.push({ body, userMessage, systemMessage });
      const next = responses[i++ % responses.length];
      return JSON.stringify({ choices: [{ message: { content: next } }] });
    },
  };
}

function fusedSrc(httpAdapter: HttpAdapter): TransformBlankSource {
  return new TransformBlankSource({
    httpAdapter,
    provider: getProvider('cerebras')!,
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: 'k',
    model: 'gpt-oss-120b',
  });
}

const fusedResp = (instruction: string, target: string, rewrite: string) =>
  `VERDICT: TRANSFORM\nINSTRUCTION: ${instruction}\nTARGET: ${target}\nFULL_REWRITE: ${rewrite}`;

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

describe('TransformBlankSource — cursor anchor (fused)', () => {
  it('injects [CURSOR] into the fused INPUT for a positional instruction with a cursor', async () => {
    const recorded: RecordedCall[] = [];
    const src = fusedSrc(makeRecordingAdapter([fusedResp('add a line break here', 'one two', 'one\ntwo')], recorded));
    await src.getCues(ctxWithCursor('one two add a line break here _', 7));
    assert.strictEqual(recorded.length, 1, 'one fused call');
    assert.ok(recorded[0].userMessage.includes('[CURSOR]'),
      `positional instruction should carry [CURSOR] in the INPUT. Got: ${recorded[0].userMessage}`);
  });

  it('does NOT inject [CURSOR] for a NON-positional instruction (gate)', async () => {
    const recorded: RecordedCall[] = [];
    const src = fusedSrc(makeRecordingAdapter([fusedResp('uppercase', 'one two', 'ONE TWO')], recorded));
    await src.getCues(ctxWithCursor('one two uppercase _', 7));
    assert.ok(!recorded[0].userMessage.includes('[CURSOR]'),
      `non-positional instruction must NOT carry [CURSOR]. Got: ${recorded[0].userMessage}`);
  });

  it('does NOT inject [CURSOR] when cursor is undefined, even with a positional cue', async () => {
    const recorded: RecordedCall[] = [];
    const src = fusedSrc(makeRecordingAdapter([fusedResp('add a line break here', 'one two', 'one\ntwo')], recorded));
    await src.getCues({
      text: 'one two add a line break here _',
      words: 'one two add a line break here _'.split(/\s+/),
      blankIndices: [7],
      // cursor omitted
    });
    assert.ok(!recorded[0].userMessage.includes('[CURSOR]'),
      `no cursor → no marker. Got: ${recorded[0].userMessage}`);
  });

  it('strips [CURSOR] if the model leaks it into FULL_REWRITE', async () => {
    const recorded: RecordedCall[] = [];
    const src = fusedSrc(makeRecordingAdapter([fusedResp('add a line break here', 'one two', 'one[CURSOR]\ntwo')], recorded));
    const res = await src.getCues(ctxWithCursor('one two add a line break here _', 7));
    const rewrite = res.results[0]?.alternatives?.[1] ?? '';
    assert.ok(!rewrite.includes('[CURSOR]'), `leaked [CURSOR] must be stripped. Got: ${JSON.stringify(rewrite)}`);
    assert.ok(rewrite.includes('one') && rewrite.includes('two'), `content preserved. Got: ${JSON.stringify(rewrite)}`);
  });

  it('the fused system prompt documents the CURSOR ANCHOR rule + the non-positional carve-out', async () => {
    const recorded: RecordedCall[] = [];
    const src = fusedSrc(makeRecordingAdapter([fusedResp('add a paragraph break here', 'a b', 'a\n\nb')], recorded));
    await src.getCues(ctxWithCursor('a b add a paragraph break here _', 3));
    const sys = recorded[0].systemMessage;
    assert.ok(/CURSOR ANCHOR/.test(sys), 'system prompt should contain the CURSOR ANCHOR rule');
    assert.ok(/NON-positional/i.test(sys) || /IGNORE the .?\[CURSOR\]/.test(sys),
      'rule should tell the model to ignore the marker for non-positional instructions');
  });
});
