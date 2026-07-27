/**
 * Outbound-dehydration negative invariants — FluidBlank + TransformBlank.
 *
 * THE invariant of the buffer-dehydration feature: in
 * `identity-context-mode: safe`, NO catalog value substring appears
 * ANYWHERE in an outbound LLM request body (messages, prediction, all
 * of it) — even when the user TYPED the value into the buffer. `raw`
 * mode is byte-compatible with the pre-feature behaviour (values ship).
 * Round-trip: the LLM echoes tokens; the source hydrates real values
 * back before the result leaves it.
 *
 * The whole RECORDED BODY is scanned (not just the user message) so a
 * value smuggled via the Cerebras `prediction` param or any future
 * body field fails the test too.
 *
 * No live LLM — HttpAdapter is mocked.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TransformBlankSource } from './transform-blank-source';
import { FluidBlankSource } from './fluid-blank-source';
import { SentenceCueSource } from './sentence-cue-source';
import { ConfigIntentSource } from './config-intent-source';
import { ConfigSource } from './config-source';
import { RoutedWordSourceGroup } from './routed-word-source-group';
import { getProvider } from '../llm-provider';
import { parseIdentityMd } from '../identity-context';
import type { HttpAdapter, CueContext } from '../types';

// Distinctive synthetic values — the static FUSED_SYSTEM prompts carry
// few-shot examples with real-looking names ("Wilfred", "Acme"), so
// ordinary values would false-positive the whole-body scan below.
const USER_MD = `---
firstName: Zorbath
fullName: Zorbath Quillfeather
company: Umbrella Dynamics
email: zorbath@quillfeather.io
workCity: Reykjavik
---`;

const VALUES = ['Zorbath Quillfeather', 'Zorbath', 'Umbrella Dynamics', 'zorbath@quillfeather.io', 'Reykjavik'];

function makeRecorder(responses: readonly string[], bodies: string[]): HttpAdapter {
  let i = 0;
  return {
    post: async (_url, body) => {
      bodies.push(body);
      const next = responses[i++ % responses.length];
      return JSON.stringify({ choices: [{ message: { content: next } }] });
    },
  };
}

function ctx(text: string, mode: 'safe' | 'raw' = 'safe', extra?: Partial<CueContext>): CueContext {
  const uc = parseIdentityMd(USER_MD);
  const words = text.split(/\s+/).filter(Boolean);
  return {
    text,
    words,
    blankIndices: words.map((w, i) => (w === '_' ? i : -1)).filter(i => i >= 0),
    identityContext: { fields: uc.fields, catalog: uc.catalog, mode },
    ...extra,
  };
}

/** Assert no catalog value (or its lowercase form) appears in any recorded body. */
function assertNoValues(bodies: string[], label: string): void {
  for (const body of bodies) {
    for (const v of VALUES) {
      assert.ok(!body.includes(v) && !body.includes(v.toLowerCase()),
        `${label}: outbound body leaked catalog value "${v}". Body: ${body.slice(0, 600)}`);
    }
  }
}

const fused = (instruction: string, target: string, rewrite: string) =>
  `VERDICT: TRANSFORM\nINSTRUCTION: ${instruction}\nTARGET: ${target}\nFULL_REWRITE: ${rewrite}`;

describe('TransformBlank — outbound dehydration (safe mode)', () => {
  const make = (adapter: HttpAdapter) => new TransformBlankSource({
    httpAdapter: adapter,
    provider: getProvider('cerebras')!,
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: 'test-key',
    // prediction is capability-gated per model name (gpt-oss / zai-glm)
    model: 'gpt-oss-120b',
  });

  it('typed PII never reaches the request body; tokens do', async () => {
    const bodies: string[] = [];
    const src = make(makeRecorder([fused('fix typos', 'x', 'x')], bodies));
    await src.getCues(ctx('fix typos _ Zorbath Quillfeather lives in Reykjavik and works at Umbrella Dynamics'));
    assert.strictEqual(bodies.length, 1);
    assertNoValues(bodies, 'transform-safe');
    assert.ok(bodies[0].includes('[FULL NAME]'), 'outbound INPUT should carry the token');
    assert.ok(bodies[0].includes('[WORK CITY]'));
  });

  it('raw mode ships the typed value unchanged (no dehydration)', async () => {
    const bodies: string[] = [];
    const src = make(makeRecorder([fused('fix typos', 'x', 'x')], bodies));
    await src.getCues(ctx('fix typos _ Zorbath lives here', 'raw'));
    assert.ok(bodies[0].includes('Zorbath'), 'raw mode must not scrub the buffer');
  });

  it('cerebras prediction param is dehydrated too (>200 char body)', async () => {
    const bodies: string[] = [];
    const src = make(makeRecorder([fused('fix typos', 'x', 'x')], bodies));
    const filler = 'This is a long body that needs to cross the prediction threshold. '.repeat(4);
    await src.getCues(ctx(`fix typos _ ${filler} Signed by Zorbath Quillfeather of Umbrella Dynamics.`));
    const parsed = JSON.parse(bodies[0]) as { prediction?: { content?: string } };
    assert.ok(parsed.prediction?.content, 'expected a prediction param on a long body');
    assertNoValues(bodies, 'transform-prediction');
    assert.ok(parsed.prediction!.content!.includes('[FULL NAME]'), 'prediction should be in token space');
  });

  it('round-trip: LLM echoes tokens → result hydrates back to real values', async () => {
    const bodies: string[] = [];
    const src = make(makeRecorder([
      fused('fix typos', 'x', '[FULL NAME] lives in [WORK CITY].'),
    ], bodies));
    const res = await src.getCues(ctx('fix typos _ Zorbath Quillfeather lives in Reykjavik.'));
    const out = JSON.stringify(res.results);
    assert.ok(out.includes('Zorbath Quillfeather lives in Reykjavik.'),
      `result should be hydrated to value space. Got: ${out.slice(0, 400)}`);
    assertNoValues(bodies, 'transform-roundtrip');
  });

  it('a mid-value cursor can never split a value into fragments', async () => {
    // The positional-cue path injects [CURSOR]; with dehydration the
    // value is already a token before injection, so no fragment like
    // "Wil[CURSOR]fred" can ship. "Wil" appearing anywhere in the body
    // is the failure signature.
    const bodies: string[] = [];
    const src = make(makeRecorder([fused('insert a dash here', 'x', 'x')], bodies));
    const text = 'insert a dash here _ Zorbath wrote this yesterday';
    await src.getCues(ctx(text, 'safe', { cursor: text.indexOf('Zorbath') + 3 }));
    for (const body of bodies) {
      assert.ok(!body.includes('Zor'), `value fragment leaked: ${body.slice(0, 400)}`);
    }
  });
});

describe('FluidBlank — outbound dehydration (safe mode)', () => {
  const make = (adapter: HttpAdapter) => new FluidBlankSource({
    httpAdapter: adapter,
    provider: getProvider('groq')!,
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  });

  it('typed PII never reaches the request body; tokens do', async () => {
    const bodies: string[] = [];
    const src = make(makeRecorder(['SPAN: email for _\nANSWER: 42'], bodies));
    await src.getCues(ctx('the email for Zorbath at Umbrella Dynamics is _'));
    assert.strictEqual(bodies.length, 1);
    assertNoValues(bodies, 'fluid-safe');
    assert.ok(bodies[0].includes('[FIRST NAME]'), 'outbound INPUT should carry the token');
    assert.ok(bodies[0].includes('[COMPANY]'));
  });

  it('raw mode ships the typed value unchanged', async () => {
    const bodies: string[] = [];
    const src = make(makeRecorder(['SPAN: x _\nANSWER: 42'], bodies));
    await src.getCues(ctx('the email for Zorbath is _', 'raw'));
    assert.ok(bodies[0].includes('Zorbath'), 'raw mode must not scrub the buffer');
  });

  it('ambient block is scrubbed with the same pass', async () => {
    const bodies: string[] = [];
    const src = make(makeRecorder(['SPAN: x _\nANSWER: 42'], bodies));
    await src.getCues(ctx('answer _', 'safe', {
      ambient: {
        label: 'Confirm booking for Zorbath Quillfeather',
        pageTitle: 'Umbrella Dynamics — checkout',
      },
    }));
    assertNoValues(bodies, 'fluid-ambient');
    assert.ok(bodies[0].includes('[FULL NAME]'), 'ambient label should carry the token');
  });

  it('round-trip: LLM answers with a token → result hydrates to the real value', async () => {
    const bodies: string[] = [];
    const src = make(makeRecorder(['SPAN: my email is _\nANSWER: [EMAIL]'], bodies));
    const res = await src.getCues(ctx('my email is _'));
    const out = JSON.stringify(res.results);
    assert.ok(out.includes('zorbath@quillfeather.io'),
      `answer should hydrate to the real value. Got: ${out.slice(0, 400)}`);
  });

  it('empty catalog in safe mode is a structural no-op (no scrub, no crash)', async () => {
    const bodies: string[] = [];
    const src = make(makeRecorder(['SPAN: x _\nANSWER: 42'], bodies));
    const words = 'plain question _'.split(/\s+/);
    await src.getCues({
      text: 'plain question _',
      words,
      blankIndices: [words.indexOf('_')],
      identityContext: { fields: [], catalog: new Map(), mode: 'safe' },
    });
    assert.strictEqual(bodies.length, 1);
    assert.ok(bodies[0].includes('plain question _'));
  });
});

describe('SentenceCue — outbound dehydration (safe mode)', () => {
  const sourceConfig = {
    name: 'more-formal',
    scope: 'sentence' as const,
    priority: 85,
    promptText: 'Rewrite each sentence to be more formal.',
  };
  const make = (adapter: HttpAdapter) => new SentenceCueSource({
    httpAdapter: adapter,
    provider: getProvider('groq')!,
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    sourceConfig,
  });

  it('sentence ships dehydrated; alternatives hydrate back', async () => {
    const bodies: string[] = [];
    const src = make(makeRecorder(['ALT: [FIRST NAME] extends sincere gratitude.'], bodies));
    const res = await src.getCues(ctx('Zorbath says thanks a bunch.'));
    assertNoValues(bodies, 'sentence-cue');
    assert.ok(bodies[0].includes('[FIRST NAME]'), 'outbound SENTENCE should carry the token');
    const out = JSON.stringify(res.results);
    assert.ok(out.includes('Zorbath extends sincere gratitude.'),
      `alternative should hydrate to value space. Got: ${out.slice(0, 400)}`);
    // alternatives[0] must remain the ORIGINAL sentence (revert anchor).
    assert.ok(out.includes('Zorbath says thanks a bunch.'));
  });
});

describe('ConfigIntent — outbound dehydration (safe mode)', () => {
  const make = (adapter: HttpAdapter) => new ConfigIntentSource({
    httpAdapter: adapter,
    provider: getProvider('groq')!,
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    applyScalar: async () => {},
  });

  it('classifier + summon inputs are dehydrated', async () => {
    const bodies: string[] = [];
    const src = make(makeRecorder(['VERDICT: NONE'], bodies));
    await src.getCues(ctx('note for Zorbath at Umbrella Dynamics. voice mode off _'));
    assert.ok(bodies.length >= 1, 'expected at least the classifier call');
    assertNoValues(bodies, 'config-intent');
  });
});

describe('Word-cues — PII words withheld from dispatch (safe mode)', () => {
  it('a PII word is never dispatched; other words still are', async () => {
    const bodies: string[] = [];
    const concise = new ConfigSource({
      sourceConfig: {
        name: 'concise',
        promptText: 'suggest legal alternatives',
        priority: 70,
        parser: 'alternatives' as const,
        scope: 'words' as const,
        match: '.*',
      },
      httpAdapter: makeRecorder(['0:lawyer,counsel'], bodies),
      provider: getProvider('groq')!,
      endpoint: 'https://example.test',
      apiKey: 'k',
      model: 'm',
    });
    const group = new RoutedWordSourceGroup({ sources: [concise] });
    const uc = parseIdentityMd(USER_MD);
    const text = 'Zorbath hired an attorney yesterday';
    const words = text.split(/\s+/);
    await group.getCues({
      text,
      words,
      cursor: 0, // cursor NOT at end-of-buffer — no in-progress trailing word
      identityContext: { fields: uc.fields, catalog: uc.catalog, mode: 'safe' },
    });
    assert.ok(bodies.length >= 1, 'expected a word-cue dispatch');
    assertNoValues(bodies, 'word-cues');
    for (const body of bodies) {
      assert.ok(body.includes('attorney'), 'non-PII words still dispatch');
    }
  });

  it('raw mode dispatches PII words unchanged', async () => {
    const bodies: string[] = [];
    const concise = new ConfigSource({
      sourceConfig: {
        name: 'concise',
        promptText: 'suggest legal alternatives',
        priority: 70,
        parser: 'alternatives' as const,
        scope: 'words' as const,
        match: '.*',
      },
      httpAdapter: makeRecorder(['0:lawyer'], bodies),
      provider: getProvider('groq')!,
      endpoint: 'https://example.test',
      apiKey: 'k',
      model: 'm',
    });
    const group = new RoutedWordSourceGroup({ sources: [concise] });
    const uc = parseIdentityMd(USER_MD);
    const text = 'Zorbath hired an attorney yesterday';
    const words = text.split(/\s+/);
    await group.getCues({
      text,
      words,
      cursor: 0,
      identityContext: { fields: uc.fields, catalog: uc.catalog, mode: 'raw' },
    });
    assert.ok(bodies.some(b => b.includes('Zorbath')), 'raw mode must not withhold words');
  });
});
