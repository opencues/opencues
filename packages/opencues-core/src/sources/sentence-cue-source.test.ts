/**
 * Tests for sentence-cue-source.ts
 *
 * Run with: vitest packages/opencues-core/src/sources/sentence-cue-source.test.ts
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  SentenceCueSource,
  segmentSentences,
  parseSentenceAltOutput,
} from './sentence-cue-source';
import type { CueContext, HttpAdapter } from '../types';
import { getProvider } from '../llm-provider';

function makeMockAdapter(responses: string[]): HttpAdapter {
  let i = 0;
  return {
    post: async () => {
      const r = responses[i++ % responses.length];
      return JSON.stringify({ choices: [{ message: { content: r } }] });
    },
  };
}

function makeFailingAdapter(): HttpAdapter {
  return { post: async () => { throw new Error('network down'); } };
}

function ctxFromText(text: string): CueContext {
  return { text, words: text.split(/\s+/) };
}

// ---------------------------------------------------------------------------
// segmentSentences — must produce correct char + word offsets
// ---------------------------------------------------------------------------

describe('segmentSentences', () => {
  it('returns empty for empty input', () => {
    assert.deepStrictEqual(segmentSentences('', []), []);
  });

  it('handles a single sentence ending in period', () => {
    const text = 'thanks a bunch for the help.';
    const spans = segmentSentences(text, text.split(/\s+/));
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].text, text);
    assert.strictEqual(spans[0].start, 0);
    assert.strictEqual(spans[0].end, text.length);
    assert.strictEqual(spans[0].firstWordIndex, 0);
  });

  it('splits two sentences on period', () => {
    const text = 'first sentence. second sentence.';
    const spans = segmentSentences(text, text.split(/\s+/));
    assert.strictEqual(spans.length, 2);
    assert.strictEqual(spans[0].text, 'first sentence.');
    assert.strictEqual(spans[1].text, 'second sentence.');
    // Word indices: "first"=0, "sentence."=1, "second"=2, "sentence."=3
    assert.strictEqual(spans[0].firstWordIndex, 0);
    assert.strictEqual(spans[1].firstWordIndex, 2);
  });

  it('handles question marks and exclamation points', () => {
    const text = 'hello? thanks!';
    const spans = segmentSentences(text, text.split(/\s+/));
    assert.strictEqual(spans.length, 2);
    assert.strictEqual(spans[0].text, 'hello?');
    assert.strictEqual(spans[1].text, 'thanks!');
  });

  it('tolerates EOF without trailing punctuation', () => {
    const text = 'no period at end';
    const spans = segmentSentences(text, text.split(/\s+/));
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].text, 'no period at end');
  });

  it('char offsets index into the original buffer', () => {
    const text = '   leading whitespace sentence.';
    const spans = segmentSentences(text, text.trim().split(/\s+/));
    assert.strictEqual(spans.length, 1);
    // Offsets should point into the ORIGINAL buffer — first non-whitespace char.
    assert.strictEqual(text.charAt(spans[0].start), 'l');
    assert.strictEqual(spans[0].text, 'leading whitespace sentence.');
  });

  it('skips runs of pure whitespace between sentences', () => {
    const text = 'one. two.   three.';
    const spans = segmentSentences(text, text.split(/\s+/));
    assert.strictEqual(spans.length, 3);
  });
});

// ---------------------------------------------------------------------------
// parseSentenceAltOutput — block parser
// ---------------------------------------------------------------------------

describe('parseSentenceAltOutput', () => {
  it('parses a single block with three alts', () => {
    const blocks = parseSentenceAltOutput(
      'SENTENCE: thanks.\nALT: Thank you.\nALT: Many thanks.\nALT: My gratitude.\n---',
    );
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].sentence, 'thanks.');
    assert.deepStrictEqual(blocks[0].alts, ['Thank you.', 'Many thanks.', 'My gratitude.']);
    assert.strictEqual(blocks[0].ceded, false);
  });

  it('parses two blocks separated by ---', () => {
    const blocks = parseSentenceAltOutput(
      'SENTENCE: one.\nALT: One!\n---\nSENTENCE: two.\nALT: Two!\n---',
    );
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0].sentence, 'one.');
    assert.strictEqual(blocks[1].sentence, 'two.');
  });

  it('treats ALT: NONE as a cede signal (no alts populated)', () => {
    const blocks = parseSentenceAltOutput('SENTENCE: ok.\nALT: NONE\n---');
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].ceded, true);
    assert.deepStrictEqual(blocks[0].alts, []);
  });

  it('de-duplicates near-identical alts within a block', () => {
    const blocks = parseSentenceAltOutput(
      'SENTENCE: hi.\nALT: Hello.\nALT: Hello.\nALT: Greetings.\n---',
    );
    assert.deepStrictEqual(blocks[0].alts, ['Hello.', 'Greetings.']);
  });

  it('tolerates trailing whitespace on each field', () => {
    const blocks = parseSentenceAltOutput(
      'SENTENCE: thanks.  \nALT: Thank you. \n---',
    );
    assert.strictEqual(blocks[0].sentence, 'thanks.');
    assert.deepStrictEqual(blocks[0].alts, ['Thank you.']);
  });

  it('returns empty array for garbage input', () => {
    assert.deepStrictEqual(parseSentenceAltOutput('whatever'), []);
  });
});

// ---------------------------------------------------------------------------
// SentenceCueSource — supports / getCues lifecycle
// ---------------------------------------------------------------------------

describe('SentenceCueSource', () => {
  const baseConfig = {
    provider: getProvider('groq')!,
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  };

  const moreFormalSource = {
    name: 'more-formal',
    scope: 'sentence' as const,
    priority: 85,
    promptText: 'Rewrite each sentence to be more formal.',
  };

  it('supports() returns false when buffer is empty', () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      sourceConfig: moreFormalSource,
    });
    assert.strictEqual(src.supports(ctxFromText('')), false);
  });

  it('supports() returns false when buffer contains a `_`', () => {
    // Sentence cues are prose-time — `_` means a blank source claims.
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      sourceConfig: moreFormalSource,
    });
    assert.strictEqual(src.supports(ctxFromText('capital of france _')), false);
  });

  it('supports() returns true on prose with a sentence terminator', () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      sourceConfig: moreFormalSource,
    });
    assert.strictEqual(src.supports(ctxFromText('thanks a bunch for the help.')), true);
  });

  it('supports() returns true on prose without a terminator (segmenter tolerant)', () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      sourceConfig: moreFormalSource,
    });
    assert.strictEqual(src.supports(ctxFromText('thanks a bunch for the help')), true);
  });

  it('priority pulls from sourceConfig.priority', () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      sourceConfig: { ...moreFormalSource, priority: 92 },
    });
    assert.strictEqual(src.priority, 92);
  });

  it('priority defaults to 85 when sourceConfig.priority is absent', () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      sourceConfig: { ...moreFormalSource, priority: undefined },
    });
    assert.strictEqual(src.priority, 85);
  });

  it('id namespaces the cue name (sentence-cue:<name>)', () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      sourceConfig: moreFormalSource,
    });
    assert.strictEqual(src.id, 'sentence-cue:more-formal');
  });

  it('isCycleable is true (sentence cues offer ≥3 alts to cycle)', () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      sourceConfig: moreFormalSource,
    });
    assert.strictEqual(src.isCycleable, true);
  });

  it('getCues hit: emits one CueResult per matched sentence with alternatives=[original, ...alts]', async () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SENTENCE: thanks a bunch.\nALT: Thank you very much.\nALT: Many thanks.\nALT: I am grateful.\n---',
      ]),
      sourceConfig: moreFormalSource,
    });
    const result = await src.getCues(ctxFromText('thanks a bunch.'));
    assert.strictEqual(result.results.length, 1);
    const r = result.results[0]!;
    assert.deepStrictEqual(r.alternatives, [
      'thanks a bunch.',
      'Thank you very much.',
      'Many thanks.',
      'I am grateful.',
    ], 'alternatives[0] must be the original; alts[1..N] the rewrites');
    assert.strictEqual(r.source, 'sentence-cue:more-formal');
    assert.strictEqual(r.priority, 85);
    assert.strictEqual(r.spanStart, 0);
    assert.strictEqual(r.spanEnd, 'thanks a bunch.'.length);
    assert.strictEqual(r.wordIndex, 0);
  });

  it('getCues multi-sentence: emits one result per sentence, ceded sentences dropped', async () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SENTENCE: thanks a bunch.\nALT: Thank you very much.\n---\nSENTENCE: ok.\nALT: NONE\n---',
      ]),
      sourceConfig: moreFormalSource,
    });
    const buffer = 'thanks a bunch. ok.';
    const result = await src.getCues(ctxFromText(buffer));
    // Only the first sentence (non-NONE) should produce a result.
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0]!.alternatives[0], 'thanks a bunch.');
  });

  it('getCues with LLM error: returns empty results, no throw', async () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeFailingAdapter(),
      sourceConfig: moreFormalSource,
    });
    const result = await src.getCues(ctxFromText('thanks a bunch.'));
    assert.strictEqual(result.results.length, 0);
  });

  it('getCues with empty prompt text: returns empty results', async () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      sourceConfig: { ...moreFormalSource, promptText: undefined },
    });
    const result = await src.getCues(ctxFromText('thanks.'));
    assert.strictEqual(result.results.length, 0);
  });

  it('getCues: model emits sentence not in buffer → dropped', async () => {
    // If the model hallucinates a sentence that doesn't appear in the
    // buffer, the source MUST NOT emit a result for it (no anchor for
    // the splice). Mirrors fluid-blank's "answer must be substitutable"
    // contract.
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SENTENCE: a completely different sentence.\nALT: An entirely formal alternative.\n---',
      ]),
      sourceConfig: moreFormalSource,
    });
    const result = await src.getCues(ctxFromText('thanks a bunch.'));
    assert.strictEqual(result.results.length, 0);
  });
});
