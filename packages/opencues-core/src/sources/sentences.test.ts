/**
 * Sentence-level integration tests.
 *
 * Tests realistic inputs through the full source pipeline with mocked
 * LLM responses that mirror what Groq/GPT would actually return.
 *
 * Run with: node --test dist/sources/sentences.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { buildSourcesFromConfig } from './build-sources';
import { CuesMdConfig, PromptConfig } from '../cues-md';
import { CueContext } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkConfig(promptConfig: PromptConfig): CuesMdConfig {
  return { frontmatter: {}, sections: {}, promptConfig };
}

/** Build word sources matching the real CUES.md layout */
function buildWordSources(response: string) {
  return buildSourcesFromConfig(
    mkConfig({
      sources: {
        grammar: {
          name: 'grammar',
          promptText: 'Provide 3 alternatives per word: synonym, opposite, creative.\nSkip function words.\nOutput ONLY index:alternatives format.',
          priority: 50,
          match: '.*',
        },
        legal: {
          name: 'legal',
          promptText: 'When the highlighted word is a legal term, suggest alternatives that preserve legal meaning.',
          priority: 70,
          match: 'contract|agreement|clause|indemnify|warrant|liability|shall|herein|whereas|stipulate',
        },
        medical: {
          name: 'medical',
          promptText: 'When suggesting alternatives for clinical terms, prefer ICD-10 standard terminology.',
          priority: 75,
          match: 'diagnosis|prognosis|etiology|contraindication|prophylaxis|anamnesis|comorbidity|pathology',
        },
      },
    }),
    undefined,
    { httpAdapter: { post: async () => llmResponse(response) }, apiKeys: { GROQ_API_KEY: 'k' }, globalProvider: 'groq', globalModel: 'm', enableWordCues: true },
  );
}

function llmResponse(content: string) {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

function ctx(text: string): CueContext {
  return { text, words: text.split(/\s+/).filter(w => w) };
}

// ---------------------------------------------------------------------------
// Word alternatives: simple sentences
// ---------------------------------------------------------------------------

describe('sentences: simple grammar', () => {
  it('"The dog ran quickly" → alts for content words', async () => {
    const sources = buildWordSources('1:cat,hound,puppy\n2:walked,sprinted,dashed\n3:slowly,fast,rapidly');
    const result = await sources[0].getCues(ctx('The dog ran quickly'));

    assert.strictEqual(result.results.length, 3);
    assert.strictEqual(result.results[0].wordIndex, 1);
    assert.strictEqual(result.results[0].word, 'dog');
    assert.ok(result.results[0].alternatives.includes('cat'));
    assert.ok(result.results[0].alternatives.includes('hound'));

    assert.strictEqual(result.results[1].wordIndex, 2);
    assert.ok(result.results[1].alternatives.includes('sprinted'));

    assert.strictEqual(result.results[2].wordIndex, 3);
    assert.ok(result.results[2].alternatives.includes('slowly'));
  });

  it('"She smiled" → short sentence, 1 content word', async () => {
    const sources = buildWordSources('1:grinned,laughed,frowned');
    const result = await sources[0].getCues(ctx('She smiled'));

    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].word, 'smiled');
    assert.ok(result.results[0].alternatives.includes('grinned'));
    assert.ok(result.results[0].alternatives.includes('frowned'));
  });

  it('"beautiful" → single word input', async () => {
    const sources = buildWordSources('0:gorgeous,ugly,stunning');
    const result = await sources[0].getCues(ctx('beautiful'));

    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].wordIndex, 0);
    assert.strictEqual(result.results[0].alternatives[0], 'beautiful');
    assert.ok(result.results[0].alternatives.includes('gorgeous'));
  });

  it('"The ancient temple stood majestically on the hilltop" → longer sentence', async () => {
    // Words: 0=The 1=ancient 2=temple 3=stood 4=majestically 5=on 6=the 7=hilltop
    const sources = buildWordSources(
      '1:old,modern,sacred\n2:church,shrine,monument\n3:towered,sat,rose\n4:grandly,proudly,silently\n7:mountaintop,cliff,plateau'
    );
    const result = await sources[0].getCues(ctx('The ancient temple stood majestically on the hilltop'));

    assert.strictEqual(result.results.length, 5);
    assert.ok(result.results.find(r => r.word === 'ancient'));
    assert.ok(result.results.find(r => r.word === 'temple'));
    assert.ok(result.results.find(r => r.word === 'hilltop'));
  });

  it('"I want to build an app" → tech context', async () => {
    const sources = buildWordSources('3:create,develop,design\n5:application,tool,product');
    const result = await sources[0].getCues(ctx('I want to build an app'));

    const buildResult = result.results.find(r => r.word === 'build');
    assert.ok(buildResult);
    assert.ok(buildResult.alternatives.includes('create'));
    assert.ok(buildResult.alternatives.includes('develop'));

    const appResult = result.results.find(r => r.word === 'app');
    assert.ok(appResult);
    assert.ok(appResult.alternatives.includes('application'));
  });

  it('"He felt extremely nervous before the interview" → emotional context', async () => {
    const sources = buildWordSources(
      '2:incredibly,slightly,somewhat\n3:anxious,calm,excited\n6:meeting,exam,presentation'
    );
    const result = await sources[0].getCues(ctx('He felt extremely nervous before the interview'));

    const nervousResult = result.results.find(r => r.word === 'nervous');
    assert.ok(nervousResult);
    assert.ok(nervousResult.alternatives.includes('anxious'));
    assert.ok(nervousResult.alternatives.includes('calm'));
  });

  it('"run" → minimal single word', async () => {
    const sources = buildWordSources('0:sprint,jog,dash');
    const result = await sources[0].getCues(ctx('run'));

    assert.strictEqual(result.results.length, 1);
    assert.ok(result.results[0].alternatives.includes('sprint'));
  });

  it('LLM returns no alts (all function words) → empty results', async () => {
    const sources = buildWordSources('');
    const result = await sources[0].getCues(ctx('the a an to'));

    assert.strictEqual(result.results.length, 0);
  });
});

// Legal / medical / mixed domain sentence blocks deleted (June 2026):
// these tests pinned the SHAPE of `buildWordSources` from a sources/
// matrix that has been retired. The parser today returns a different
// envelope and there is no working translation from the inline-YAML
// fixture format the tests used. Kept under `.skip` for months without
// resolution — clearing them out so the test-pass counter reflects
// real coverage. Re-add real-shape tests when needed.

// ---------------------------------------------------------------------------
// Word alternatives: sentences with numbers
// ---------------------------------------------------------------------------

describe('sentences: with numbers', () => {
  it('"buy 5 apples" → number position skipped', async () => {
    const sources = buildWordSources('0:purchase,get,grab\n2:oranges,bananas,pears');
    const result = await sources[0].getCues(ctx('buy 5 apples'));

    // Index 1 is "5" → skipped by parser
    assert.strictEqual(result.results.length, 2);
    assert.ok(!result.results.find(r => r.wordIndex === 1));
    assert.ok(result.results.find(r => r.word === 'buy'));
    assert.ok(result.results.find(r => r.word === 'apples'));
  });

  it('"the 3 dogs ran 10 miles" → multiple numbers skipped', async () => {
    const sources = buildWordSources('2:cats,hounds,puppies\n3:walked,sprinted,dashed\n5:kilometers,blocks,laps');
    const result = await sources[0].getCues(ctx('the 3 dogs ran 10 miles'));

    assert.ok(!result.results.find(r => r.wordIndex === 1), 'index 1 (3) should be skipped');
    assert.ok(!result.results.find(r => r.wordIndex === 4), 'index 4 (10) should be skipped');
    assert.ok(result.results.find(r => r.word === 'dogs'));
    assert.ok(result.results.find(r => r.word === 'miles'));
  });
});
