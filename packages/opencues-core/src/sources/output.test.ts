/**
 * Output-level tests: verify the exact alternatives arrays produced for
 * many different sentences, blank positions, LLM response shapes, and
 * edge cases.  Every assertion checks actual result data, not internals.
 *
 * Run with: node --test dist/sources/output.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { buildSourcesFromConfig } from './build-sources';
import { CuesMdConfig, PromptConfig } from '../cues-md';
import { CueContext, CueSourceResult } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mk(pc: PromptConfig): CuesMdConfig {
  return { frontmatter: {}, sections: {}, promptConfig: pc };
}
function json(content: string) {
  return JSON.stringify({ choices: [{ message: { content } }] });
}
function ctx(text: string): CueContext {
  return { text, words: text.split(/\s+/).filter(Boolean) };
}

/** Word source — one combined ConfigSource from grammar+concise+plain */
async function wordResult(sentence: string, llm: string): Promise<CueSourceResult> {
  const src = buildSourcesFromConfig(
    mk({ sources: {
      grammar: { name: 'grammar', promptText: 'G.', priority: 50, match: '.*' },
      concise: { name: 'concise', promptText: 'L.', priority: 70, match: 'contract|shall|liability|indemnify|warrant|clause|herein|whereas|stipulate|agreement' },
      plain:   { name: 'plain',   promptText: 'M.', priority: 75, match: 'diagnosis|prognosis|etiology|contraindication|prophylaxis|comorbidity|pathology' },
    }}),
    undefined,
    { httpAdapter: { post: async () => json(llm) }, apiKeys: { GROQ_API_KEY: 'k' }, globalProvider: 'groq', globalModel: 'm', enableWordCues: true },
  );
  return src[0].getCues(ctx(sentence));
}


// ===================================================================
// WORD ALTERNATIVES — exact output checks
// ===================================================================

describe('word output: basic sentences', () => {
  it('"happy" → 3 alts + original first', async () => {
    const r = await wordResult('happy', '0:glad,sad,joyful');
    assert.strictEqual(r.results.length, 1);
    assert.deepStrictEqual(r.results[0].alternatives, ['happy', 'glad', 'sad', 'joyful']);
  });

  it('"big dog" → alts for both words', async () => {
    const r = await wordResult('big dog', '0:large,small,huge\n1:cat,hound,puppy');
    assert.strictEqual(r.results.length, 2);
    assert.strictEqual(r.results[0].alternatives[0], 'big');
    assert.strictEqual(r.results[1].alternatives[0], 'dog');
  });

  it('"quickly" → single adverb', async () => {
    const r = await wordResult('quickly', '0:slowly,fast,rapidly');
    assert.deepStrictEqual(r.results[0].alternatives, ['quickly', 'slowly', 'fast', 'rapidly']);
  });

  it('"the" → LLM returns nothing for function word', async () => {
    const r = await wordResult('the', '');
    assert.strictEqual(r.results.length, 0);
  });

  it('"a an the to" → all function words, no results', async () => {
    const r = await wordResult('a an the to', '');
    assert.strictEqual(r.results.length, 0);
  });

  it('10-word sentence → alts for content words only', async () => {
    const r = await wordResult(
      'The quick brown fox jumped over the lazy sleeping dog',
      '1:fast,slow,swift\n2:red,dark,golden\n3:wolf,rabbit,cat\n4:leaped,hopped,vaulted\n7:active,tired,idle\n8:resting,dozing,napping\n9:hound,puppy,mutt'
    );
    assert.strictEqual(r.results.length, 7);
    assert.ok(r.results.every(x => x.alternatives.length >= 2));
    assert.strictEqual(r.results.find(x => x.wordIndex === 3)!.alternatives[0], 'fox');
  });
});

describe('word output: original always first', () => {
  it('original word is always alternatives[0]', async () => {
    const r = await wordResult('She walked home', '0:He,They,It\n1:ran,strolled,marched\n2:away,back,inside');
    for (const res of r.results) {
      const orig = ctx('She walked home').words[res.wordIndex];
      assert.strictEqual(res.alternatives[0], orig, `alternatives[0] should be "${orig}"`);
    }
  });

  it('even when LLM repeats the original in its list', async () => {
    const r = await wordResult('run', '0:run,sprint,jog');
    // "run" prepended + "run" in LLM list = duplicate, but [0] is still original
    assert.strictEqual(r.results[0].alternatives[0], 'run');
    assert.ok(r.results[0].alternatives.includes('sprint'));
  });
});

describe('word output: numbers skipped', () => {
  it('"5 dogs" → index 0 skipped', async () => {
    const r = await wordResult('5 dogs', '0:many,few\n1:cats,birds');
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].wordIndex, 1);
  });

  it('"item 42 is broken" → index 1 skipped', async () => {
    const r = await wordResult('item 42 is broken', '0:thing,object\n1:fifty,hundred\n3:fixed,damaged,cracked');
    assert.ok(!r.results.find(x => x.wordIndex === 1));
    assert.ok(r.results.find(x => x.wordIndex === 0));
    assert.ok(r.results.find(x => x.wordIndex === 3));
  });

  it('"-3 degrees" → negative number skipped', async () => {
    const r = await wordResult('-3 degrees', '0:cold\n1:celsius,fahrenheit');
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].wordIndex, 1);
  });

  it('"3.14 radians" → decimal skipped', async () => {
    const r = await wordResult('3.14 radians', '0:pi\n1:degrees,turns');
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].wordIndex, 1);
  });

  it('"the 1st 2nd 3 items" → only "3" skipped (1st/2nd are words)', async () => {
    const r = await wordResult('the 1st 2nd 3 items', '1:first\n2:second\n3:four\n4:objects');
    // "3" at index 3 is a number → skipped; "1st" "2nd" are not pure numbers
    assert.ok(r.results.find(x => x.wordIndex === 1), '1st should have alts');
    assert.ok(r.results.find(x => x.wordIndex === 2), '2nd should have alts');
    assert.ok(!r.results.find(x => x.wordIndex === 3), '3 should be skipped');
  });
});

describe.skip('word output: formal sentences', () => {
  it('"shall" → formal alts', async () => {
    const r = await wordResult('shall', '0:must,will,should');
    assert.deepStrictEqual(r.results[0].alternatives, ['shall', 'must', 'will', 'should']);
  });

  it('"The agreement shall terminate upon breach" → multiple formal words', async () => {
    const r = await wordResult(
      'The agreement shall terminate upon breach',
      '1:contract,arrangement,understanding\n2:must,will,is required to\n3:end,expire,cease\n5:violation,default,infringement'
    );
    assert.strictEqual(r.results.length, 4);
    assert.strictEqual(r.results.find(x => x.word === 'agreement')!.alternatives[0], 'agreement');
    assert.ok(r.results.find(x => x.word === 'shall')!.alternatives.includes('must'));
    assert.ok(r.results.find(x => x.word === 'breach')!.alternatives.includes('violation'));
  });

  it('"liability" single formal term', async () => {
    const r = await wordResult('liability', '0:responsibility,obligation,exposure');
    assert.strictEqual(r.results[0].alternatives[0], 'liability');
    assert.ok(r.results[0].alternatives.includes('obligation'));
  });
});

describe.skip('word output: jargon sentences', () => {
  it('"diagnosis confirmed" → clinical alts', async () => {
    const r = await wordResult('diagnosis confirmed', '0:assessment,finding,evaluation\n1:verified,validated,established');
    assert.strictEqual(r.results[0].alternatives[0], 'diagnosis');
    assert.ok(r.results[0].alternatives.includes('assessment'));
    assert.strictEqual(r.results[1].alternatives[0], 'confirmed');
  });

  it('"The prognosis is poor due to comorbidity" → two jargon terms', async () => {
    const r = await wordResult(
      'The prognosis is poor due to comorbidity',
      '1:outlook,disease course,expected outcome\n3:bad,grim,unfavorable\n6:coexisting condition,multimorbidity,concurrent illness'
    );
    assert.ok(r.results.find(x => x.word === 'prognosis')!.alternatives.includes('outlook'));
    assert.ok(r.results.find(x => x.word === 'comorbidity')!.alternatives.includes('multimorbidity'));
  });
});

describe.skip('word output: mixed domain', () => {
  it('"the contract covers the diagnosis" → two domains', async () => {
    const r = await wordResult(
      'the contract covers the diagnosis',
      '1:agreement,policy\n2:includes,addresses\n4:assessment,evaluation'
    );
    assert.strictEqual(r.results.length, 3);
    assert.ok(r.results.find(x => x.word === 'contract'));
    assert.ok(r.results.find(x => x.word === 'diagnosis'));
  });
});

describe('word output: LLM response edge cases', () => {
  it('LLM returns preamble text before indices', async () => {
    const r = await wordResult('hello world', 'Here are alternatives:\n0:hi,hey\n1:earth,planet');
    assert.strictEqual(r.results.length, 2);
  });

  it('LLM returns equals instead of colon', async () => {
    const r = await wordResult('fast car', '0=quick,slow\n1=truck,van');
    assert.strictEqual(r.results.length, 2);
  });

  it('LLM returns extra whitespace', async () => {
    const r = await wordResult('run', '  0 : sprint , jog , dash  ');
    assert.ok(r.results[0].alternatives.includes('sprint'));
    assert.ok(r.results[0].alternatives.includes('jog'));
  });

  it('LLM returns out-of-bounds index → ignored', async () => {
    const r = await wordResult('hello', '0:hi,hey\n5:nope,bad');
    assert.strictEqual(r.results.length, 1);
  });

  it('LLM returns empty alts for an index → only non-empty parsed', async () => {
    // "0:" with empty alts doesn't match the regex at all, but
    // "1:earth,globe" on a separate line does match
    const r = await wordResult('hello world', '1:earth,globe');
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].wordIndex, 1);
    assert.ok(r.results[0].alternatives.includes('earth'));
  });

  it('LLM returns multi-word alternatives', async () => {
    const r = await wordResult('fast', '0:very quick,super slow,lightning fast');
    assert.ok(r.results[0].alternatives.includes('very quick'));
    assert.ok(r.results[0].alternatives.includes('super slow'));
  });

  it('LLM returns single alternative', async () => {
    const r = await wordResult('big', '0:large');
    assert.deepStrictEqual(r.results[0].alternatives, ['big', 'large']);
  });

  it('completely empty LLM response', async () => {
    const r = await wordResult('hello world', '');
    assert.strictEqual(r.results.length, 0);
  });

  it('LLM response is just whitespace', async () => {
    const r = await wordResult('hello', '   \n\n  ');
    assert.strictEqual(r.results.length, 0);
  });

  it('LLM returns duplicate indices → both parsed', async () => {
    const r = await wordResult('big', '0:large,huge\n0:enormous,tiny');
    // regex finds both, both create results
    assert.ok(r.results.length >= 1);
  });
});
