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
  parseSingleSentenceAlts,
  estimateSentenceCueBudget,
  mapWithConcurrency,
} from './sentence-cue-source';
import type { CueContext, HttpAdapter } from '../types';
import { getProvider } from '../llm-provider';

// Per-sentence calls fire one request per sentence (possibly concurrent), so
// a positional response list is non-deterministic. This mock returns a
// response based on which sentence is in the request body — `match` substrings
// → ALT-block content. `fallback` (default `ALT: NONE`) covers anything else.
function makeMockAdapter(
  routes: Array<{ match: string; content: string }>,
  fallback = 'ALT: NONE',
): HttpAdapter {
  return {
    post: async (_url: string, body: string) => {
      const route = routes.find(r => body.includes(r.match));
      const content = route ? route.content : fallback;
      return JSON.stringify({ choices: [{ message: { content } }] });
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

  it('a trailing zero-width render-kick char (ZWNJ U+200C) is NOT segmented as its own sentence', () => {
    // Claude Code appends a zero-width char (ZWSP/ZWNJ) to force a repaint.
    // A buffer ending in that kick-char must NOT segment it as a phantom
    // final "sentence" — that inflated the count, collided on the last word,
    // and bumped the REAL final sentence out of registration (the
    // "実施されます。 left out" bug). Two real sentences + trailing ZWNJ = 2.
    const text = 'すべての通信は暗号化されます。認証データは保護されます。‌';
    const spans = segmentSentences(text, text.split(/\s+/).filter(Boolean));
    assert.strictEqual(spans.length, 2, 'trailing ZWNJ must not count as a sentence');
    assert.ok(spans[1].text.endsWith('保護されます。'), 'last real sentence intact');
    assert.ok(!spans[1].text.includes('‌'), 'ZWNJ trimmed from the last span');
  });

  it('also ignores a lone ZWSP (U+200B) and BOM (U+FEFF) span', () => {
    const text = '文章です。​﻿';
    const spans = segmentSentences(text, text.split(/\s+/).filter(Boolean));
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].text, '文章です。');
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
// parseSingleSentenceAlts — per-sentence ALT-line parser (no SENTENCE: echo,
// no "---", no matching: the call was scoped to ONE known sentence)
// ---------------------------------------------------------------------------

describe('parseSingleSentenceAlts', () => {
  it('parses three ALT lines', () => {
    const r = parseSingleSentenceAlts('ALT: Thank you.\nALT: Many thanks.\nALT: My gratitude.');
    assert.deepStrictEqual(r.alts, ['Thank you.', 'Many thanks.', 'My gratitude.']);
    assert.strictEqual(r.ceded, false);
  });

  it('treats ALT: NONE as a cede signal', () => {
    const r = parseSingleSentenceAlts('ALT: NONE');
    assert.strictEqual(r.ceded, true);
    assert.deepStrictEqual(r.alts, []);
  });

  it('tolerates leading whitespace (model copies indentation from the spec example)', () => {
    // The exact regression that silently dropped an indented English block:
    // a strict `^ALT:` anchor parsed zero alts.
    const r = parseSingleSentenceAlts('  ALT: Thank you very much.\n  ALT: I appreciate it.');
    assert.deepStrictEqual(r.alts, ['Thank you very much.', 'I appreciate it.']);
  });

  it('de-duplicates identical alts', () => {
    const r = parseSingleSentenceAlts('ALT: Hello.\nALT: Hello.\nALT: Greetings.');
    assert.deepStrictEqual(r.alts, ['Hello.', 'Greetings.']);
  });

  it('returns no alts for garbage / no ALT lines', () => {
    assert.deepStrictEqual(parseSingleSentenceAlts('whatever the model said'), { alts: [], ceded: false });
  });
});

// ---------------------------------------------------------------------------
// mapWithConcurrency — the "queue of sorts" that caps in-flight per-sentence
// calls while preserving order
// ---------------------------------------------------------------------------

describe('mapWithConcurrency', () => {
  it('preserves input order in the result', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    assert.deepStrictEqual(out, [10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit in flight', async () => {
    let inFlight = 0, peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return 0;
    });
    assert.ok(peak <= 3, `peak in-flight ${peak} must be <= 3`);
  });

  it('handles an empty list', async () => {
    assert.deepStrictEqual(await mapWithConcurrency([], 5, async () => 1), []);
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

  it('getCues hit: emits one CueResult per sentence with alternatives=[original, ...alts]', async () => {
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        { match: 'thanks a bunch.', content: 'ALT: Thank you very much.\nALT: Many thanks.\nALT: I am grateful.' },
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

  it('getCues multi-sentence: one call PER sentence, ceded sentences dropped', async () => {
    // Per-sentence calls: sentence 1 → alts, sentence 2 ("ok.") → ALT: NONE
    // (the content-aware mock routes by the sentence in the request body).
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter(
        [{ match: 'thanks a bunch.', content: 'ALT: Thank you very much.' }],
        'ALT: NONE', // fallback for "ok."
      ),
      sourceConfig: moreFormalSource,
    });
    const buffer = 'thanks a bunch. ok.';
    const result = await src.getCues(ctxFromText(buffer));
    // Only the first sentence (non-NONE) produces a result.
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0]!.alternatives[0], 'thanks a bunch.');
  });

  it('getCues multi-sentence: EVERY sentence gets its own result (no batch-drop)', async () => {
    // The whole point of the per-sentence refactor: 3 sentences → 3 results,
    // none silently dropped. Each routed independently.
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        { match: 'First one.', content: 'ALT: The first.' },
        { match: 'Second one.', content: 'ALT: The second.' },
        { match: 'Third one.', content: 'ALT: The third.' },
      ]),
      sourceConfig: moreFormalSource,
    });
    const result = await src.getCues(ctxFromText('First one. Second one. Third one.'));
    assert.strictEqual(result.results.length, 3);
    assert.deepStrictEqual(result.results.map(r => r.alternatives[1]), ['The first.', 'The second.', 'The third.']);
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

  it('span comes from SEGMENTATION, not the model — result always anchored to the buffer', async () => {
    // Per-sentence design: the model just returns alts; the span (spanStart/
    // spanEnd) is always the segmented sentence's range, so a result can never
    // point at chars the model invented. alts are used verbatim.
    const src = new SentenceCueSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        { match: 'thanks a bunch.', content: 'ALT: An entirely formal alternative.' },
      ]),
      sourceConfig: moreFormalSource,
    });
    const result = await src.getCues(ctxFromText('thanks a bunch.'));
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0]!.spanStart, 0);
    assert.strictEqual(result.results[0]!.spanEnd, 'thanks a bunch.'.length);
    assert.strictEqual(result.results[0]!.alternatives[0], 'thanks a bunch.');
  });

  it('per-sentence calls share a STABLE system prompt; only the sentence varies (cerebras prefix-cache contract)', async () => {
    const systems: string[] = [];
    const users: string[] = [];
    const capturing: HttpAdapter = {
      post: async (_url: string, body: string) => {
        const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
        systems.push(parsed.messages.find(m => m.role === 'system')!.content);
        users.push(parsed.messages.find(m => m.role === 'user')!.content);
        return JSON.stringify({ choices: [{ message: { content: 'ALT: x.' } }] });
      },
    };
    const src = new SentenceCueSource({ ...baseConfig, httpAdapter: capturing, sourceConfig: moreFormalSource });
    await src.getCues(ctxFromText('First one. Second one.'));
    assert.strictEqual(systems.length, 2);
    assert.strictEqual(systems[0], systems[1], 'system prompt must be identical across per-sentence calls');
    // Each user message carries exactly ONE sentence.
    assert.ok(users.some(u => u.includes('First one.')));
    assert.ok(users.some(u => u.includes('Second one.')));
    assert.ok(!users[0].includes('Second one.') || !users[1].includes('First one.'), 'sentences not batched into one message');
  });
});
