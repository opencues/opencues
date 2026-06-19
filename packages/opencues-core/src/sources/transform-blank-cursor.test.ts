/**
 * Tests for TransformBlankSource — cursor sentinel integration.
 *
 * Run with: node --test dist/sources/transform-blank-cursor.test.js
 *
 * Mocks the HttpAdapter so we can inspect what the source sends to the
 * "LLM" and how it processes the response. Pins the load-bearing
 * contracts:
 *   - cursor offset from CueContext propagates into the APPLY prompt
 *   - [CURSOR] is injected at the correct target-relative position
 *   - subsequent pipe-composed steps run cursor-blind
 *   - sentinels in the LLM output are stripped before the rewrite is
 *     returned to the runtime
 *   - non-positional tasks work cursor-blind without regression
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
      // Pull the user message out of the OpenAI-style chat request so
      // tests can assert what the source sent.
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

function makeSource(httpAdapter: HttpAdapter): TransformBlankSource {
  return new TransformBlankSource({
    httpAdapter,
    provider: getProvider('groq')!,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  });
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

// EXTRACT response template — verdict TRANSFORM, custom instruction +
// target. Source format must match parseExtract's regex.
function extract(instruction: string, target: string): string {
  return `VERDICT: TRANSFORM\nINSTRUCTION: ${instruction}\nTARGET: ${target}`;
}

// APPLY response template.
function apply(rewrite: string): string {
  return `REWRITE: ${rewrite}`;
}

// VERIFY response template.
function verify(verdict: 'OK' | 'REPAIR', rewrite = ''): string {
  return `VERDICT: ${verdict}\nREWRITE: ${rewrite}`;
}

describe('TransformBlankSource — cursor sentinel injection', () => {
  it('injects [CURSOR] into the APPLY prompt at the target-relative cursor position', async () => {
    // Input shape: "insert a comma here _ hello world"
    //                                     ^---^ cursor sits inside "hello" (offset 27 = "hello".start + 1)
    // After EXTRACT, target = "hello world". Buffer offset 27 → "hello world" starts at 21 → 27 - 21 = 6.
    const recorded: RecordedCall[] = [];
    const responses = [
      extract('insert a comma here', 'hello world'),    // P1 EXTRACT
      apply('hello, world'),                              // P2 APPLY
      verify('OK'),                                       // P3 VERIFY
    ];
    const src = makeSource(makeRecordingAdapter(responses, recorded));
    const text = 'insert a comma here _ hello world';
    await src.getCues(ctxWithCursor(text, 27));
    // recorded[1] is the APPLY call. Its target should contain [CURSOR]
    // at the spot derived from the cursor offset.
    const applyMsg = recorded[1].userMessage;
    assert.ok(applyMsg.includes('[CURSOR]'),
      `APPLY prompt should contain [CURSOR]. Got: ${applyMsg.slice(0, 200)}`);
    // The injected target line should be "TARGET: hello [CURSOR]world"
    // or similar — the [CURSOR] is at position 6 inside "hello world".
    assert.ok(applyMsg.includes('hello [CURSOR]world') || applyMsg.includes('hello[CURSOR] world'),
      `Expected [CURSOR] near offset 6 in "hello world". Got: ${applyMsg}`);
  });

  it('omits [CURSOR] from the APPLY prompt when cursor is -1', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      extract('make this shorter', 'hello world'),
      apply('hi'),
      verify('OK'),
    ];
    const src = makeSource(makeRecordingAdapter(responses, recorded));
    await src.getCues(ctxWithCursor('make shorter _ hello world', -1));
    const applyMsg = recorded[1].userMessage;
    assert.ok(!applyMsg.includes('[CURSOR]'),
      `APPLY prompt should NOT contain [CURSOR] when cursor=-1. Got: ${applyMsg.slice(0, 200)}`);
  });

  it('omits [CURSOR] when context.cursor is undefined entirely', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      extract('translate to french', 'hello world'),
      apply('bonjour le monde'),
      verify('OK'),
    ];
    const src = makeSource(makeRecordingAdapter(responses, recorded));
    const ctx: CueContext = {
      text: 'translate _ hello world',
      words: 'translate _ hello world'.split(/\s+/),
      // cursor field omitted
    };
    await src.getCues(ctx);
    assert.ok(!recorded[1].userMessage.includes('[CURSOR]'));
  });
});

describe('TransformBlankSource — cursor sentinel stripping', () => {
  it('strips [CURSOR] if the LLM leaks it into the APPLY response', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      extract('add a comma here', 'hello world'),
      apply('hello, [CURSOR]world'),  // model echoed the sentinel
      verify('OK'),
    ];
    const src = makeSource(makeRecordingAdapter(responses, recorded));
    const results = await src.getCues(ctxWithCursor('add a comma here _ hello world', 25));
    // results[0].alternatives[1] is the rewrite that gets substituted.
    // It must NOT contain [CURSOR].
    assert.ok(results.results.length >= 1, 'expected at least one result');
    const rewrite = results.results[0].alternatives[1];
    assert.ok(!rewrite.includes('[CURSOR]'),
      `rewrite should be sentinel-free. Got: ${JSON.stringify(rewrite)}`);
    assert.ok(rewrite.includes('hello'), `expected "hello" in rewrite. Got: ${rewrite}`);
  });

  it('strips lower-case [cursor] (model case-mangled the marker)', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      extract('insert here', 'a b c'),
      apply('a [cursor]b c'),
      verify('OK'),
    ];
    const src = makeSource(makeRecordingAdapter(responses, recorded));
    const results = await src.getCues(ctxWithCursor('insert here _ a b c', 16));
    const rewrite = results.results[0].alternatives[1];
    assert.ok(!rewrite.toLowerCase().includes('[cursor]'));
  });

  it('strips MULTIPLE sentinel occurrences from a single response', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      extract('split here', 'one two three'),
      apply('[CURSOR]one [CURSOR]two[CURSOR] three'),
      verify('OK'),
    ];
    const src = makeSource(makeRecordingAdapter(responses, recorded));
    const results = await src.getCues(ctxWithCursor('split here _ one two three', 14));
    const rewrite = results.results[0].alternatives[1];
    assert.ok(!rewrite.includes('[CURSOR]'),
      `expected all sentinels stripped. Got: ${JSON.stringify(rewrite)}`);
  });
});

describe('TransformBlankSource — non-positional tasks ignore the cursor', () => {
  it('translate task: [CURSOR] is in the prompt but the rewrite is still clean translation', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      extract('translate to french', 'hello world'),
      apply('bonjour le monde'),  // model ignored [CURSOR] correctly
      verify('OK'),
    ];
    const src = makeSource(makeRecordingAdapter(responses, recorded));
    const results = await src.getCues(ctxWithCursor('translate to french _ hello world', 25));
    // [CURSOR] WAS in the prompt (per system-prompt rule, model ignores it).
    assert.ok(recorded[1].userMessage.includes('[CURSOR]'));
    // Output is sentinel-free.
    const rewrite = results.results[0].alternatives[1];
    assert.ok(!rewrite.includes('[CURSOR]'));
    assert.strictEqual(rewrite, 'bonjour le monde');
  });

  it('translate then capitalise (pipe-composed): subsequent step is cursor-blind', async () => {
    // First APPLY step sees [CURSOR]; second step's prompt should NOT.
    const recorded: RecordedCall[] = [];
    const responses = [
      extract('translate to french | capitalise', 'hello world'),
      apply('bonjour le monde'),                 // step 1 — [CURSOR] in prompt
      apply('BONJOUR LE MONDE'),                  // step 2 — no [CURSOR] in prompt
      verify('OK'),
    ];
    const src = makeSource(makeRecordingAdapter(responses, recorded));
    await src.getCues(ctxWithCursor('translate and capitalise _ hello world', 28));
    // recorded[1] = step 1 APPLY — should have [CURSOR]
    // recorded[2] = step 2 APPLY — should NOT
    assert.ok(recorded[1].userMessage.includes('[CURSOR]'),
      `step 1 should have [CURSOR]. Got: ${recorded[1].userMessage.slice(0, 200)}`);
    assert.ok(!recorded[2].userMessage.includes('[CURSOR]'),
      `step 2 should NOT have [CURSOR]. Got: ${recorded[2].userMessage.slice(0, 200)}`);
  });
});

describe('TransformBlankSource — system-prompt rule wiring', () => {
  it('APPLY system prompt mentions [CURSOR] and the positional/non-positional distinction', async () => {
    // We can't observe the system message via the recorder mechanism
    // above (only the user message is parsed). Read the constant
    // export directly to assert the prompt body contains the rules.
    const { P2_APPLY_SYSTEM } = await import('./transform-blank-source');
    assert.ok(P2_APPLY_SYSTEM.includes('[CURSOR]'),
      'APPLY system prompt should mention [CURSOR]');
    assert.ok(/POSITIONAL|positional/.test(P2_APPLY_SYSTEM),
      'APPLY system prompt should distinguish positional vs non-positional instructions');
    assert.ok(P2_APPLY_SYSTEM.includes('strip'),
      'APPLY system prompt should instruct stripping the marker');
  });
});

describe('TransformBlankSource — fused VERDICT:NONE fallthrough on long buffers', () => {
  // Regression: cerebras gpt-oss-120b intermittently returns VERDICT: NONE on a
  // LONG buffer (FULL_REWRITE output/reasoning-budget pressure) even when there
  // IS a trailing imperative — a chained "make it all make sense structurally _"
  // on a ~1.3k-char buffer silently did nothing. A long-buffer fused NONE must
  // NOT be trusted: fall through to 3-pass (separate budget-free EXTRACT).
  function fusedSource(httpAdapter: HttpAdapter): TransformBlankSource {
    return new TransformBlankSource({
      httpAdapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'k',
      model: 'gpt-oss-120b',
      mode: 'fused',
    });
  }
  const fusedNone = 'VERDICT: NONE\nINSTRUCTION:\nTARGET:\nFULL_REWRITE:';

  it('long buffer + fused NONE → falls through to 3-pass (re-classifies, does not silently cede)', async () => {
    const recorded: RecordedCall[] = [];
    const longBody = 'This is a long accumulated prompt body that exceeds the floor. '.repeat(8) + 'make it formal _';
    assert.ok(longBody.length > 400, 'fixture must clear the long-buffer floor');
    const src = fusedSource(makeRecordingAdapter(
      [fusedNone, extract('make it formal', longBody), apply('a formal rewrite'), verify('OK')],
      recorded,
    ));
    await src.getCues(ctxWithCursor(longBody, longBody.length));
    assert.ok(recorded.length >= 2,
      `expected fallthrough to 3-pass (≥2 LLM calls), got ${recorded.length} — a long-buffer fused NONE must not bail`);
  });

  it('short buffer + fused NONE → cedes after one call (genuine lookup, FluidBlank answers it)', async () => {
    const recorded: RecordedCall[] = [];
    const src = fusedSource(makeRecordingAdapter([fusedNone], recorded));
    const out = await src.getCues(ctxWithCursor('capital of france _', 18));
    assert.strictEqual(recorded.length, 1, 'a short NONE must cede after exactly one call (no 3-pass)');
    assert.strictEqual(out.results.length, 0, 'short NONE yields empty so FluidBlank can answer');
  });
});
