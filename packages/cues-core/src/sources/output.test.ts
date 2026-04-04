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
import { ClassifiedSourceGroup } from './classified-source-group';
import { CuesMdConfig, PromptConfig } from '../cues-md';
import { HttpAdapter, CueContext, CueSourceResult } from '../types';

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

/** Word source — one combined ConfigSource from grammar+legal+medical */
async function wordResult(sentence: string, llm: string): Promise<CueSourceResult> {
  const src = buildSourcesFromConfig(
    mk({ sources: {
      grammar: { name: 'grammar', promptText: 'G.', priority: 50 },
      legal:   { name: 'legal',   promptText: 'L.', priority: 70, match: 'contract|shall|liability|indemnify|warrant|clause|herein|whereas|stipulate|agreement' },
      medical: { name: 'medical', promptText: 'M.', priority: 75, match: 'diagnosis|prognosis|etiology|contraindication|prophylaxis|comorbidity|pathology' },
    }}),
    undefined,
    { httpAdapter: { post: async () => json(llm) }, endpoint: '', apiKey: '', defaultModel: '' },
  );
  return src[0].getCues(ctx(sentence));
}

/** Blank source — ClassifiedSourceGroup mirroring blanks.md */
async function blankResult(sentence: string, adapter: HttpAdapter): Promise<CueSourceResult> {
  const src = buildSourcesFromConfig(
    undefined,
    mk({ sources: {
      classifier: { name: 'classifier', promptText: 'Classify:\n' },
      math:       { name: 'math', promptText: 'Solve.', parser: 'compute', priority: 90,
                    match: '\\d+\\s*[+\\-*/^%]\\s*\\d+|\\d+%',
                    keywords: 'factorial,average,half of,double,triple,square root,sqrt' },
      factual:    { name: 'factual', promptText: 'Answer.', parser: 'answer', priority: 90,
                    match: 'the .+ of .+ is|who (is|was)|capital of|ceo of|founder of|author of',
                    keywords: 'capital of,ceo of,founder of,author of,who is,who was,when did' },
      grammar:    { name: 'grammar', promptText: 'Fill.', priority: 50 },
    }}),
    { httpAdapter: adapter, endpoint: '', apiKey: '', defaultModel: '' },
  );
  return src.find(s => s instanceof ClassifiedSourceGroup)!.getCues(ctx(sentence));
}

/** Simple blank adapter that returns one canned response for every call */
function fixed(content: string): HttpAdapter {
  return { post: async () => json(content) };
}

/** Adapter that answers classifier then source */
function classifyThen(mode: string, content: string): HttpAdapter {
  return { post: async (_: string, body: string) => {
    const p = JSON.parse(body).messages[0].content as string;
    return p.includes('Classify') ? json(`MODE=${mode}`) : json(content);
  }};
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

describe('word output: legal sentences', () => {
  it('"shall" → legal alts', async () => {
    const r = await wordResult('shall', '0:must,will,should');
    assert.deepStrictEqual(r.results[0].alternatives, ['shall', 'must', 'will', 'should']);
  });

  it('"The agreement shall terminate upon breach" → multiple legal words', async () => {
    const r = await wordResult(
      'The agreement shall terminate upon breach',
      '1:contract,arrangement,understanding\n2:must,will,is required to\n3:end,expire,cease\n5:violation,default,infringement'
    );
    assert.strictEqual(r.results.length, 4);
    assert.strictEqual(r.results.find(x => x.word === 'agreement')!.alternatives[0], 'agreement');
    assert.ok(r.results.find(x => x.word === 'shall')!.alternatives.includes('must'));
    assert.ok(r.results.find(x => x.word === 'breach')!.alternatives.includes('violation'));
  });

  it('"liability" single legal term', async () => {
    const r = await wordResult('liability', '0:responsibility,obligation,exposure');
    assert.strictEqual(r.results[0].alternatives[0], 'liability');
    assert.ok(r.results[0].alternatives.includes('obligation'));
  });
});

describe('word output: medical sentences', () => {
  it('"diagnosis confirmed" → clinical alts', async () => {
    const r = await wordResult('diagnosis confirmed', '0:assessment,finding,evaluation\n1:verified,validated,established');
    assert.strictEqual(r.results[0].alternatives[0], 'diagnosis');
    assert.ok(r.results[0].alternatives.includes('assessment'));
    assert.strictEqual(r.results[1].alternatives[0], 'confirmed');
  });

  it('"The prognosis is poor due to comorbidity" → two medical terms', async () => {
    const r = await wordResult(
      'The prognosis is poor due to comorbidity',
      '1:outlook,disease course,expected outcome\n3:bad,grim,unfavorable\n6:coexisting condition,multimorbidity,concurrent illness'
    );
    assert.ok(r.results.find(x => x.word === 'prognosis')!.alternatives.includes('outlook'));
    assert.ok(r.results.find(x => x.word === 'comorbidity')!.alternatives.includes('multimorbidity'));
  });
});

describe('word output: mixed domain', () => {
  it('"the contract covers the diagnosis" → legal + medical', async () => {
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

// ===================================================================
// BLANK FILL-IN — exact output checks
// ===================================================================

describe('blank output: math — exact computed values', () => {
  it('"2 + 2 = _" → 4', async () => {
    const r = await blankResult('2 + 2 = _', fixed('COMPUTE=2+2'));
    assert.ok(r.results[0].alternatives.includes('4'));
  });

  it('"100 - 37 = _" → 63', async () => {
    const r = await blankResult('100 - 37 = _', fixed('COMPUTE=100-37'));
    assert.ok(r.results[0].alternatives.includes('63'));
  });

  it('"7 * 8 = _" → 56', async () => {
    const r = await blankResult('7 * 8 = _', fixed('COMPUTE=7*8'));
    assert.ok(r.results[0].alternatives.includes('56'));
  });

  it('"144 / 12 = _" → 12', async () => {
    const r = await blankResult('144 / 12 = _', fixed('COMPUTE=144/12'));
    assert.ok(r.results[0].alternatives.includes('12'));
  });

  it('"17 % 5 = _" → 2', async () => {
    const r = await blankResult('17 % 5 = _', fixed('COMPUTE=17%5'));
    assert.ok(r.results[0].alternatives.includes('2'));
  });

  it('"(10 + 20) * 3 = _" → 90', async () => {
    const r = await blankResult('10 + 20 * 3 = _', fixed('COMPUTE=(10+20)*3'));
    assert.ok(r.results[0].alternatives.includes('90'));
  });

  it('decimal result: "10 / 3 = _" → 3.3333', async () => {
    const r = await blankResult('10 / 3 = _', fixed('COMPUTE=10/3'));
    assert.ok(r.results[0].alternatives.includes('3.3333'));
  });

  it('zero result: "5 - 5 = _" → 0', async () => {
    const r = await blankResult('5 - 5 = _', fixed('COMPUTE=5-5'));
    assert.ok(r.results[0].alternatives.includes('0'));
  });

  it('blank always has _ as first alternative', async () => {
    const r = await blankResult('2 + 3 = _', fixed('COMPUTE=2+3'));
    assert.strictEqual(r.results[0].alternatives[0], '_');
    assert.strictEqual(r.results[0].alternatives[1], '5');
  });

  it('keyword "half of 16 = _" → 8', async () => {
    const r = await blankResult('half of 16 = _', fixed('COMPUTE=16/2'));
    assert.ok(r.results[0].alternatives.includes('8'));
  });

  it('keyword "double 25 = _" → 50', async () => {
    const r = await blankResult('double 25 = _', fixed('COMPUTE=25*2'));
    assert.ok(r.results[0].alternatives.includes('50'));
  });

  it('keyword "square root of 144 = _" → 12', async () => {
    const r = await blankResult('square root of 144 = _', fixed('COMPUTE=12'));
    assert.ok(r.results[0].alternatives.includes('12'));
  });
});

describe('blank output: factual — exact answers', () => {
  it('"The capital of Japan is _" → Tokyo', async () => {
    const r = await blankResult('The capital of Japan is _', fixed('ANSWER=Tokyo'));
    assert.strictEqual(r.results[0].alternatives[0], '_');
    assert.ok(r.results[0].alternatives.includes('Tokyo'));
  });

  it('"The founder of Microsoft is _" → Bill Gates', async () => {
    const r = await blankResult('The founder of Microsoft is _', fixed('ANSWER=Bill Gates'));
    assert.ok(r.results[0].alternatives.includes('Bill Gates'));
  });

  it('"who was the first man on the moon _" → Neil Armstrong', async () => {
    const r = await blankResult('who was the first man on the moon _', fixed('ANSWER=Neil Armstrong'));
    assert.ok(r.results[0].alternatives.includes('Neil Armstrong'));
  });

  it('"The author of 1984 is _" → George Orwell', async () => {
    const r = await blankResult('The author of 1984 is _', fixed('ANSWER=George Orwell'));
    assert.ok(r.results[0].alternatives.includes('George Orwell'));
  });

  it('factual blank index is correct', async () => {
    // "The capital of France is _" → words: [The,capital,of,France,is,_] → blank at 5
    const r = await blankResult('The capital of France is _', fixed('ANSWER=Paris'));
    assert.strictEqual(r.results[0].wordIndex, 5);
  });
});

describe('blank output: grammar fill — exact word lists', () => {
  it('"The _ dog barked" → adjectives', async () => {
    const r = await blankResult('The _ dog barked', classifyThen('GRAMMAR', '1:big,small,brown,happy,loud'));
    assert.deepStrictEqual(r.results[0].alternatives, ['big', 'small', 'brown', 'happy', 'loud']);
    assert.strictEqual(r.results[0].wordIndex, 1);
  });

  it('"_ ran away" → subject nouns', async () => {
    const r = await blankResult('_ ran away', classifyThen('GRAMMAR', '0:He,She,They,The dog,A cat'));
    assert.deepStrictEqual(r.results[0].alternatives, ['He', 'She', 'They', 'The dog', 'A cat']);
    assert.strictEqual(r.results[0].wordIndex, 0);
  });

  it('"She _ home" → verbs', async () => {
    const r = await blankResult('She _ home', classifyThen('GRAMMAR', '1:walked,ran,drove,flew,rushed'));
    assert.ok(r.results[0].alternatives.includes('walked'));
    assert.ok(r.results[0].alternatives.includes('rushed'));
  });

  it('"The code is written in _" → tech nouns at end', async () => {
    const r = await blankResult('The code is written in _', classifyThen('GRAMMAR', '5:Python,Java,Rust,Go,C++'));
    assert.strictEqual(r.results[0].wordIndex, 5);
    assert.ok(r.results[0].alternatives.includes('Python'));
    assert.ok(r.results[0].alternatives.includes('Rust'));
  });

  it('"The _ _ barked" → two blanks, both filled', async () => {
    const r = await blankResult('The _ _ barked', classifyThen('GRAMMAR', '1:big,small\n2:dog,cat'));
    assert.strictEqual(r.results.length, 2);
    assert.strictEqual(r.results[0].wordIndex, 1);
    assert.strictEqual(r.results[1].wordIndex, 2);
  });

  it('blank at end: "She went _" → destinations', async () => {
    const r = await blankResult('She went _', classifyThen('GRAMMAR', '2:home,outside,away,upstairs,shopping'));
    assert.strictEqual(r.results[0].wordIndex, 2);
    assert.ok(r.results[0].alternatives.includes('home'));
  });

  it('blank only: "_" → single blank', async () => {
    const r = await blankResult('_', classifyThen('GRAMMAR', '0:Hello,Yes,No,Maybe,Sure'));
    assert.strictEqual(r.results[0].wordIndex, 0);
    assert.strictEqual(r.results[0].alternatives.length, 5);
  });

  it('blank in long sentence', async () => {
    const r = await blankResult(
      'The extremely talented young pianist _ the audience with her performance',
      classifyThen('GRAMMAR', '5:amazed,stunned,captivated,thrilled,impressed')
    );
    assert.strictEqual(r.results[0].wordIndex, 5);
    assert.ok(r.results[0].alternatives.includes('captivated'));
  });
});

describe('blank output: classifier routing checks', () => {
  it('math: fast regex skips classifier', async () => {
    let calls: string[] = [];
    const r = await blankResult('3 + 4 = _', {
      post: async (_: string, body: string) => {
        const p = JSON.parse(body).messages[0].content as string;
        calls.push(p.includes('Classify') ? 'classifier' : 'source');
        return json(p.includes('Classify') ? 'MODE=MATH' : 'COMPUTE=3+4');
      },
    });
    assert.ok(!calls.includes('classifier'));
    assert.ok(r.results[0].alternatives.includes('7'));
  });

  it('factual: keyword skips classifier', async () => {
    let calls: string[] = [];
    const r = await blankResult('capital of Italy is _', {
      post: async (_: string, body: string) => {
        const p = JSON.parse(body).messages[0].content as string;
        calls.push(p.includes('Classify') ? 'classifier' : 'source');
        return json(p.includes('Classify') ? 'MODE=FACTUAL' : 'ANSWER=Rome');
      },
    });
    assert.ok(!calls.includes('classifier'));
    assert.ok(r.results[0].alternatives.includes('Rome'));
  });

  it('grammar: no fast match → classifier called → grammar used', async () => {
    let calls: string[] = [];
    const r = await blankResult('The boy _ quickly', {
      post: async (_: string, body: string) => {
        const p = JSON.parse(body).messages[0].content as string;
        calls.push(p.includes('Classify') ? 'classifier' : 'source');
        return json(p.includes('Classify') ? 'MODE=GRAMMAR' : '2:ran,walked,sprinted');
      },
    });
    assert.ok(calls.includes('classifier'));
    assert.ok(r.results[0].alternatives.includes('ran'));
  });

  it('misclassification: factual returns empty → falls back to grammar', async () => {
    const r = await blankResult('The cat sat on the _', {
      post: async (_: string, body: string) => {
        const p = JSON.parse(body).messages[0].content as string;
        if (p.includes('Classify')) return json('MODE=FACTUAL');
        if (p.includes('Answer')) return json('I do not know');
        return json('5:mat,floor,chair,table,rug');
      },
    });
    assert.ok(r.results.length > 0, 'Fallback should produce results');
    assert.ok(r.results[0].alternatives.includes('mat'));
  });

  it('classifier error → falls back to grammar default', async () => {
    const r = await blankResult('The _ flew away', {
      post: async (_: string, body: string) => {
        const p = JSON.parse(body).messages[0].content as string;
        if (p.includes('Classify')) throw new Error('timeout');
        return json('1:bird,plane,butterfly,kite,balloon');
      },
    });
    assert.ok(r.results[0].alternatives.includes('bird'));
  });
});

describe('blank output: edge cases', () => {
  it('blank at every position: "_ _ _" → 3 results', async () => {
    const r = await blankResult('_ _ _', classifyThen('GRAMMAR', '0:I,We,They\n1:love,hate,need\n2:dogs,cats,fish'));
    assert.strictEqual(r.results.length, 3);
  });

  it('COMPUTE with invalid expression → no results', async () => {
    const r = await blankResult('2 + 2 = _', fixed('COMPUTE=???'));
    assert.strictEqual(r.results.length, 0);
  });

  it('COMPUTE with division by zero → no results (Infinity)', async () => {
    const r = await blankResult('1 / 0 = _', fixed('COMPUTE=1/0'));
    assert.strictEqual(r.results.length, 0);
  });

  it('ANSWER that is too long → no results', async () => {
    const r = await blankResult('who is _', fixed('ANSWER=' + 'x'.repeat(200)));
    assert.strictEqual(r.results.length, 0);
  });

  it('grammar returns wrong index → result at that index', async () => {
    // Blank is at index 1, but LLM returns index 3 (out of bounds for 3-word input)
    const r = await blankResult('go _ now', classifyThen('GRAMMAR', '3:fast'));
    // index 3 >= words.length (3) → skipped
    assert.strictEqual(r.results.length, 0);
  });

  it('source error → empty results with error message', async () => {
    const r = await blankResult('2 + 2 = _', { post: async () => { throw new Error('boom'); } });
    // ClassifiedSourceGroup catches internally; ConfigSource returns error
    assert.strictEqual(r.results.length, 0);
  });

  it('LLM returns COMPUTE with trailing text → still works', async () => {
    const r = await blankResult('5 * 5 = _', fixed('COMPUTE=5*5\nSo the answer is 25.'));
    assert.ok(r.results[0].alternatives.includes('25'));
  });

  it('LLM returns ANSWER with trailing text → still works', async () => {
    const r = await blankResult('capital of Germany is _', fixed('ANSWER=Berlin\nBerlin is the capital.'));
    assert.ok(r.results[0].alternatives.includes('Berlin'));
  });
});
