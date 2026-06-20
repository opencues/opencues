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
  matchBlocksToSpans,
  estimateSentenceCueBudget,
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

  it('a sentence starting MID-WORD (spaceless CJK 。) anchors to its containing word, not word 0', () => {
    // 'aa いう。えお' — word 0 = "aa", word 1 = "いう。えお". The second
    // sentence "えお" begins after the 。 inside word 1 (no space), so NO
    // word STARTS within it. The old fallback put it at word 0 → it then
    // collided with the FIRST sentence at registration and got dropped
    // (the long-second-sentence "not highlighted" bug). It must anchor to
    // its containing word (1).
    const text = 'aa いう。えお';
    const spans = segmentSentences(text, text.split(/\s+/).filter(Boolean));
    assert.strictEqual(spans.length, 2);
    assert.strictEqual(spans[1].text, 'えお');
    assert.strictEqual(spans[1].firstWordIndex, 1, 'mid-word sentence must anchor to containing word 1, not 0');
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

  it('splits CJK sentences at the ideographic full stop 。 (no trailing space)', () => {
    // Regression: a Japanese paragraph used to collapse into ONE giant
    // "sentence" (the regex only knew ASCII .!? + a trailing-space rule,
    // which CJK doesn't use) — so the sentence-cue highlight selected the
    // whole block. Observed live on Claude Code.
    const text = 'HTMLを使用します。サイトはモバイルです。次の文です。';
    const spans = segmentSentences(text, text.split(/\s+/));
    assert.strictEqual(spans.length, 3);
    assert.strictEqual(spans[0].text, 'HTMLを使用します。');
    assert.strictEqual(spans[1].text, 'サイトはモバイルです。');
    assert.strictEqual(spans[2].text, '次の文です。');
  });

  it('treats the CJK comma 、 as NOT a sentence terminator', () => {
    const text = 'HTML、CSS を使用して、設計します。次は開発します。';
    const spans = segmentSentences(text, text.split(/\s+/));
    assert.strictEqual(spans.length, 2);
    assert.strictEqual(spans[0].text, 'HTML、CSS を使用して、設計します。');
  });

  it('splits fullwidth ！ and ？ too', () => {
    const text = 'すごい！本当に？はい。';
    const spans = segmentSentences(text, text.split(/\s+/));
    assert.strictEqual(spans.length, 3);
  });

  it('keeps mid-token ASCII periods (version numbers) — does NOT drop the text before them', () => {
    // Regression (observed live on Claude Code): the "2.1" in "WCAG 2.1 AA"
    // made the old class-based regex stop at the `.`, fail to find a
    // terminator (no trailing space), and SKIP "アクセシビリティ（WCAG 2." —
    // dropping it from every sentence span so it couldn't be cued.
    const text = 'アクセシビリティ（WCAG 2.1 AA）を確保します。次の文です。';
    const spans = segmentSentences(text, text.split(/\s+/));
    assert.strictEqual(spans.length, 2);
    assert.strictEqual(spans[0].text, 'アクセシビリティ（WCAG 2.1 AA）を確保します。');
    assert.strictEqual(spans[1].text, '次の文です。');
  });

  it('keeps mid-token ASCII periods in Latin text (gpt-5.4) instead of splitting/dropping', () => {
    const text = 'Use gpt-5.4 today. It is fast.';
    const spans = segmentSentences(text, text.split(/\s+/));
    assert.strictEqual(spans.length, 2);
    assert.strictEqual(spans[0].text, 'Use gpt-5.4 today.');
    assert.strictEqual(spans[1].text, 'It is fast.');
  });

  it('covers the buffer with no dropped chars (contiguous spans modulo whitespace)', () => {
    const text = 'CDN は IP 1.2.3.4 で配信します。ロードは 2 秒以下に下回ります。';
    const spans = segmentSentences(text, text.split(/\s+/));
    // Every non-whitespace char must belong to some span — no gaps.
    let covered = '';
    for (const s of spans) covered += text.slice(s.start, s.end);
    assert.strictEqual(covered.replace(/\s/g, ''), text.replace(/\s/g, ''));
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
// estimateSentenceCueBudget — output budget MUST scale with the input
// (live bug: a fixed ~768/2048 budget truncated 4 long Japanese sentences
// to one block; the tail sentences silently vanished)
// ---------------------------------------------------------------------------

describe('estimateSentenceCueBudget', () => {
  it('stays small for tiny input (the provider reasoning-floor still raises it to 2048 for gpt-oss)', () => {
    // Just the reasoning headroom for an empty/tiny buffer — well under the
    // 2048 the provider floors gpt-oss to, so small buffers are unchanged.
    assert.ok(estimateSentenceCueBudget([]) <= 2048);
    assert.ok(estimateSentenceCueBudget([10]) <= 2048);
  });

  it('scales above the old 2048 floor for several long sentences', () => {
    // 4 sentences ≈ 62 + 95 + 112 + 153 chars (the live repro's lengths).
    const budget = estimateSentenceCueBudget([62, 95, 112, 153]);
    assert.ok(budget > 2048, `expected > 2048, got ${budget}`);
    // …but stays bounded.
    assert.ok(budget <= 8192);
  });

  it('caps at 8192 for a pathological paste', () => {
    assert.strictEqual(estimateSentenceCueBudget(Array(50).fill(500)), 8192);
  });

  it('is monotonic in total input length', () => {
    const small = estimateSentenceCueBudget([40, 40]);
    const large = estimateSentenceCueBudget([200, 200]);
    assert.ok(large > small);
  });
});

// ---------------------------------------------------------------------------
// matchBlocksToSpans — exact → longest-prefix, consume-once. The model's
// echo of a LONG sentence drifts in the TAIL (paraphrase, normalised hyphen,
// dropped space), so exact full-sentence equality drops exactly the long
// sentences that need cueing most (live bug: a 180-char Japanese security
// sentence parsed but never matched).
// ---------------------------------------------------------------------------

describe('matchBlocksToSpans', () => {
  const mk = (sentence: string, alts: string[] = ['x']) => ({ sentence, alts, ceded: false });

  it('matches when the model echo drifts only in the tail', () => {
    const span = 'HTTPS を必須とし、厳格な Content‑Security‑Policy ヘッダーを適用し、XSS やインジェクションの脅威を軽減します';
    // Model echoed the head verbatim but paraphrased the tail + normalised
    // the non-breaking hyphen ‑ → - .
    const echoed = 'HTTPS を必須とし、厳格な Content-Security-Policy ヘッダーを適用し、XSS や脅威を抑えます';
    const [match] = matchBlocksToSpans([span], [mk(echoed, ['…formal…'])]);
    assert.ok(match, 'tail-drifted echo should still match by shared prefix');
    assert.deepStrictEqual(match!.alts, ['…formal…']);
  });

  it('keeps distinct sentences distinct and consumes each block once', () => {
    const s1 = 'モダンでレスポンシブなウェブアプリケーションを設計します。';
    const s2 = 'ダークモードのサポートと画像の遅延読み込みを実装します。';
    const out = matchBlocksToSpans([s1, s2], [mk(s1, ['a']), mk(s2, ['b'])]);
    assert.deepStrictEqual(out[0]!.alts, ['a']);
    assert.deepStrictEqual(out[1]!.alts, ['b']);
  });

  it('does NOT cross-match two sentences that only share a short opener', () => {
    // Below the MIN_PREFIX run — must NOT match (would otherwise steal the
    // wrong block).
    const [m] = matchBlocksToSpans(['the cat'], [mk('the dog ran far away today')]);
    assert.strictEqual(m, undefined);
  });

  it('returns undefined for a span with no emitted block', () => {
    const [m] = matchBlocksToSpans(['some sentence here that was dropped'], []);
    assert.strictEqual(m, undefined);
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
