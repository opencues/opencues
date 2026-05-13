/**
 * Tests for transform-partial-detector.ts
 *
 * Run with: node --test dist/sources/transform-partial-detector.test.js
 *
 * The driving case (from /tmp/opencues.log on 2026-05-13):
 *   AgentTask: ARM     prompt="translate to japanese"     ── ran to completion
 *   AgentTask: STOP    (was prompt="translate to japanese")
 *   FluidBlank:        "translate to english _" → "Hello, my name is Wilfred."
 *   TransformBlank:    "こんにちは、私の名前はウィルフレッドです\n\n今日はどう…" (94 chars)
 *                       → "こんにちは my name is wilfred\n\nHow あなたは今日…"  (51 chars)
 *                       *** PARTIAL — left CJK in the output ***
 *
 * VERIFY's existing length guard didn't fire — the rewrite was under
 * the 100-char activation floor. These tests pin a charset-coverage
 * signal that catches the bug class regardless of length.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  bucketByUnicodeBlock,
  scriptOfRequestedLanguage,
  detectPartialTransform,
} from './transform-partial-detector';

describe('bucketByUnicodeBlock', () => {
  it('empty string yields all-zero buckets', () => {
    const b = bucketByUnicodeBlock('');
    assert.strictEqual(b.latin, 0);
    assert.strictEqual(b.cjk, 0);
    assert.strictEqual(b.cyrillic, 0);
    assert.strictEqual(b.neutral, 0);
  });

  it('pure ASCII text lands in latin', () => {
    const b = bucketByUnicodeBlock('Hello world');
    assert.strictEqual(b.latin, 10);          // H,e,l,l,o,w,o,r,l,d
    assert.strictEqual(b.neutral, 1);         // the space
    assert.strictEqual(b.cjk, 0);
  });

  it('pure Japanese (Hiragana + Katakana + Han) lands in cjk', () => {
    // こ ん に ち は = 5 Hiragana
    // ウ ィ ル フ レ ッ ド = 7 Katakana
    // 名 前 = 2 Han
    const b = bucketByUnicodeBlock('こんにちはウィルフレッド名前');
    assert.strictEqual(b.cjk, 14);
    assert.strictEqual(b.latin, 0);
  });

  it('mixed Latin + CJK splits across buckets', () => {
    const b = bucketByUnicodeBlock('こんにちは Wilfred');
    assert.strictEqual(b.cjk, 5);
    assert.strictEqual(b.latin, 7);
    assert.strictEqual(b.neutral, 1);
  });

  it('Cyrillic, Greek, Devanagari go to their own buckets', () => {
    assert.strictEqual(bucketByUnicodeBlock('Привет').cyrillic, 6);
    assert.strictEqual(bucketByUnicodeBlock('Καλημέρα').greek, 8);
    assert.ok(bucketByUnicodeBlock('नमस्ते').devanagari > 0);
  });

  it('extended Latin (accents) still counts as latin', () => {
    const b = bucketByUnicodeBlock('café Müller naïve');
    // c,a,f,é,M,ü,l,l,e,r,n,a,ï,v,e = 15
    assert.strictEqual(b.latin, 15);
    assert.strictEqual(b.neutral, 2);
  });

  it('digits and ASCII punctuation are neutral, not latin', () => {
    const b = bucketByUnicodeBlock('abc 123, def!');
    assert.strictEqual(b.latin, 6);
    // 3 digits + 2 spaces + 1 comma + 1 exclamation = 7 neutral
    assert.strictEqual(b.neutral, 7);
  });

  it('emoji and unclassified codepoints go to other', () => {
    const b = bucketByUnicodeBlock('hi 😊 there');
    assert.strictEqual(b.latin, 7);
    assert.strictEqual(b.other, 1);
  });

  it('iterates codepoints, not code units (handles surrogate pairs)', () => {
    const b = bucketByUnicodeBlock('😊');
    assert.strictEqual(b.other, 1);
  });

  it('REAL CASE: input from the bug log is dominantly CJK', () => {
    const input = 'こんにちは、私の名前はウィルフレッドです\n\n今日はどうですか？ あなたは今日どうですか？ それは変です、それは決めた';
    const b = bucketByUnicodeBlock(input);
    assert.ok(b.cjk > 40, `expected cjk > 40 but got ${b.cjk}`);
    assert.strictEqual(b.latin, 0);
  });

  it('REAL CASE: partial output from the bug log has both CJK and Latin', () => {
    const output = 'こんにちは my name is wilfred\n\nHow あなたは今日どうですか？ それは変です、';
    const b = bucketByUnicodeBlock(output);
    // Partial translation leaked CJK into an otherwise English output.
    assert.ok(b.cjk > 10, `expected cjk > 10 but got ${b.cjk}`);
    assert.ok(b.latin > 15, `expected latin > 15 but got ${b.latin}`);
  });
});

describe('scriptOfRequestedLanguage', () => {
  it('null / empty / undefined inputs return null', () => {
    assert.strictEqual(scriptOfRequestedLanguage(null), null);
    assert.strictEqual(scriptOfRequestedLanguage(undefined), null);
    assert.strictEqual(scriptOfRequestedLanguage(''), null);
  });

  it('Latin-script translation targets', () => {
    assert.strictEqual(scriptOfRequestedLanguage('translate to english'), 'latin');
    assert.strictEqual(scriptOfRequestedLanguage('translate to spanish'), 'latin');
    assert.strictEqual(scriptOfRequestedLanguage('translate to french'), 'latin');
    assert.strictEqual(scriptOfRequestedLanguage('translate to german'), 'latin');
  });

  it('CJK targets', () => {
    assert.strictEqual(scriptOfRequestedLanguage('translate to japanese'), 'cjk');
    assert.strictEqual(scriptOfRequestedLanguage('translate to chinese'), 'cjk');
    assert.strictEqual(scriptOfRequestedLanguage('translate to mandarin'), 'cjk');
  });

  it('Cyrillic / Greek / Hebrew / Arabic / Devanagari / Thai', () => {
    assert.strictEqual(scriptOfRequestedLanguage('translate to russian'), 'cyrillic');
    assert.strictEqual(scriptOfRequestedLanguage('translate to greek'), 'greek');
    assert.strictEqual(scriptOfRequestedLanguage('translate to hebrew'), 'hebrew');
    assert.strictEqual(scriptOfRequestedLanguage('translate to arabic'), 'arabic');
    assert.strictEqual(scriptOfRequestedLanguage('translate to hindi'), 'devanagari');
    assert.strictEqual(scriptOfRequestedLanguage('translate to thai'), 'thai');
  });

  it('case-insensitive matching', () => {
    assert.strictEqual(scriptOfRequestedLanguage('TRANSLATE TO ENGLISH'), 'latin');
    assert.strictEqual(scriptOfRequestedLanguage('Translate to Japanese'), 'cjk');
  });

  it('accepts translation-shaped verbs (convert, render, rewrite, paraphrase, say)', () => {
    assert.strictEqual(scriptOfRequestedLanguage('convert to japanese'), 'cjk');
    assert.strictEqual(scriptOfRequestedLanguage('rewrite in french'), 'latin');
    assert.strictEqual(scriptOfRequestedLanguage('paraphrase in russian'), 'cyrillic');
    assert.strictEqual(scriptOfRequestedLanguage('say it in arabic'), 'arabic');
  });

  it('non-translation tasks return null even if a language name appears', () => {
    // "english is hard" doesn't ask for a translation.
    assert.strictEqual(scriptOfRequestedLanguage('english is hard'), null);
    assert.strictEqual(scriptOfRequestedLanguage('fix typos'), null);
    assert.strictEqual(scriptOfRequestedLanguage('make it shorter'), null);
    assert.strictEqual(scriptOfRequestedLanguage('write a poem'), null);
  });

  it('unknown languages return null', () => {
    assert.strictEqual(scriptOfRequestedLanguage('translate to klingon'), null);
  });

  it('language word as substring is not a false positive (word boundary required)', () => {
    assert.strictEqual(scriptOfRequestedLanguage('translate to thaiwanese'), null);
  });
});

describe('detectPartialTransform — the real bug case', () => {
  it('REAL CASE round 1: Japanese → English partial flagged', () => {
    const input = 'こんにちは、私の名前はウィルフレッドです\n\n今日はどうですか？ あなたは今日どうですか？ それは変です、それは決めた';
    const output = 'こんにちは my name is wilfred\n\nHow あなたは今日どうですか？ それは変です、';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, true, `expected partial=true, got reason: ${r.reason}`);
    assert.strictEqual(r.sourceScript, 'cjk');
    assert.strictEqual(r.targetScript, 'latin');
    assert.match(r.reason, /cjk.*survived/);
  });

  it('Round 2 with a CLEAN output is NOT flagged', () => {
    // The cleaned-up output that the LLM SHOULD have produced.
    const input = 'こんにちは my name is wilfred\n\nHow あなたは今日どうですか？ それは変です、';
    const completeOutput = 'Hello my name is wilfred\n\nHow are you today? That is strange';
    const r = detectPartialTransform({ input, output: completeOutput, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, false);
    assert.match(r.reason, /below threshold/);
  });

  it('truncated-but-fully-translated output is NOT flagged (length is a separate concern)', () => {
    // The LLM may produce complete-script output that's truncated
    // mid-sentence. That's a LENGTH problem, not a charset one — and
    // the existing length guard / sentence-count check is the right
    // tool. This detector deliberately only fires on surviving
    // source-script characters.
    const input = 'こんにちは、私の名前はウィルフレッドです。今日はどうですか？';
    const truncated = 'Hello, my name is Wil';
    const r = detectPartialTransform({ input, output: truncated, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, false);
  });
});

describe('detectPartialTransform — happy paths', () => {
  it('Japanese → English COMPLETE translation passes', () => {
    const input = 'こんにちは、私の名前はウィルフレッドです';
    const output = 'Hello, my name is Wilfred';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, false);
    assert.strictEqual(r.outputSourceCount, 0);
  });

  it('English → Japanese COMPLETE translation passes', () => {
    const input = 'Hello, my name is Wilfred';
    const output = 'こんにちは、私の名前はウィルフレッドです';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to japanese' });
    assert.strictEqual(r.partial, false);
    assert.strictEqual(r.sourceScript, 'latin');
    assert.strictEqual(r.targetScript, 'cjk');
  });

  it('Russian → English COMPLETE translation passes', () => {
    const input = 'Привет, меня зовут Уилфред';
    const output = 'Hello, my name is Wilfred';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, false);
  });
});

describe('detectPartialTransform — partial fingerprints across scripts', () => {
  it('Russian → English partial (Cyrillic fragments remain)', () => {
    const input = 'Привет, меня зовут Уилфред. Сегодня хороший день для программирования.';
    const output = 'Hello, меня зовут Wilfred. Today is a хороший day for programming.';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, true);
    assert.strictEqual(r.sourceScript, 'cyrillic');
  });

  it('Chinese → English partial (Han retained)', () => {
    const input = '你好，我叫威尔弗雷德。今天怎么样？';
    const output = 'Hello, my 叫 is Wilfred. How is 今天?';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, true);
    assert.strictEqual(r.sourceScript, 'cjk');
  });

  it('Arabic → English partial', () => {
    const input = 'مرحبا، اسمي ويلفريد. كيف حالك اليوم؟';
    const output = 'Hello, اسمي is Wilfred. كيف are you today?';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, true);
    assert.strictEqual(r.sourceScript, 'arabic');
  });
});

describe('detectPartialTransform — no-op cases', () => {
  it('non-translation task: returns partial=false', () => {
    const input = 'こんにちは Wilfred';
    const output = 'Hello Wilfred';
    const r = detectPartialTransform({ input, output, taskHint: 'fix typos' });
    assert.strictEqual(r.partial, false);
    assert.strictEqual(r.reason, 'task is not a translation');
  });

  it('null task hint: returns partial=false', () => {
    const r = detectPartialTransform({ input: 'こんにちは', output: 'Hello', taskHint: null });
    assert.strictEqual(r.partial, false);
  });

  it('input has too few source-script chars: skips the check', () => {
    // Only one CJK character — not enough to confidently call partial.
    const input = 'My name is こ';
    const output = 'My name is こ';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, false);
    assert.match(r.reason, /no significant non-target/);
  });

  it('input already in target script (vacuous): no partial', () => {
    const input = 'Hello world';
    const output = 'Hi world';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, false);
  });

  it('Latin-to-Latin paraphrase: never flagged (same script)', () => {
    // Spanish → English is Latin → Latin. No charset-shift expected.
    // The detector legitimately can't tell — and that's fine; not its job.
    const input = 'Hola, me llamo Wilfred';
    const output = 'Hello, my name is Wilfred';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, false);
  });

  it('output retains tiny CJK fragment under threshold: NOT flagged', () => {
    // Edge case: complete translation may legitimately keep a proper
    // name in Latin script (Tanaka, Tokyo). Our 5% threshold is
    // permissive enough.
    const input = 'こんにちは田中さん、お元気ですか';
    const output = 'Hello Tanaka-san, are you well';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, false);
    assert.strictEqual(r.outputSourceCount, 0);
  });

  it('empty input/output: doesn\'t crash, no-ops', () => {
    assert.strictEqual(detectPartialTransform({ input: '', output: '', taskHint: 'translate to english' }).partial, false);
    assert.strictEqual(detectPartialTransform({ input: '', output: 'Hello', taskHint: 'translate to english' }).partial, false);
    assert.strictEqual(detectPartialTransform({ input: 'Hello', output: '', taskHint: 'translate to english' }).partial, false);
  });
});

describe('detectPartialTransform — false-positive resistance', () => {
  it('proper names in Latin do NOT trip the detector', () => {
    // "Tokyo" stays "Tokyo" in English. Romanised place/personal
    // names are common; the user shouldn't be punished for the LLM
    // keeping them in Latin (which is correct).
    const input = 'こんにちは、東京は素晴らしい街です';
    const output = 'Hello, Tokyo is a wonderful city';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, false);
  });

  it('multi-language input: detector picks the largest non-target script', () => {
    // Mixed buffer: Cyrillic + CJK + Latin. Target = latin.
    // The detector picks Cyrillic (largest non-target) as the source.
    const input = 'Привет こんにちは hello world';
    const completeOutput = 'Hi hi hello world';
    const r = detectPartialTransform({ input, output: completeOutput, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, false);
    assert.strictEqual(r.sourceScript, 'cyrillic');
  });

  it('DOCUMENTED LIMITATION: quoted source fragment over the threshold is flagged', () => {
    // User asks "translate to english" of text where the LLM
    // legitimately quotes Japanese phrases ("the word ありがとう means…").
    // If the quoted fragments exceed 5% of the source-script count, the
    // detector flags it. This is a known false-positive class — fix at
    // integration time is to either lower the threshold for "quoted"
    // content or trust the user's intent.
    const input = 'こんにちは。Japanese has many polite expressions. 私の好きな表現はありがとうとお願いしますです。';
    const output = '"Hello. Japanese has many polite expressions. My favorite expressions are ありがとう and お願いします."';
    const r = detectPartialTransform({ input, output, taskHint: 'translate to english' });
    assert.strictEqual(r.partial, true);  // Documented limitation
  });
});
