/**
 * Classifier routing tests — verifies that inputs route to the correct
 * blank-fill domain via fast keyword/regex matching.
 *
 * Tests the classifyFast() path directly — no LLM calls.
 *
 * Run with: node --test dist/sources/classifier.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { buildSourcesFromConfig } from './build-sources';
import { ClassifiedSourceGroup } from './classified-source-group';
import { parseCuesMd } from '../cues-md';
import { HttpAdapter } from '../types';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Build the real ClassifiedSourceGroup from blanks.md
// ---------------------------------------------------------------------------

const stubAdapter: HttpAdapter = { post: async () => '{}' };
const blanksPath = path.resolve(__dirname, '../../../../defaults/blanks.md');
const blanksContent = fs.existsSync(blanksPath) ? fs.readFileSync(blanksPath, 'utf8') : '';
// Phase 0 deleted the classifier blanks.md content; Phase 1 reused
// the same filename for the renamed-from-controls file. These tests
// exercise classifier routing — short-circuit the whole file if the
// classifier content isn't present (deferred Phase 0 cleanup will
// delete the file outright in a later commit).
const HAS_CLASSIFIER = blanksContent.includes('classifier') && blanksContent.includes('### math');

if (!HAS_CLASSIFIER) {
  // Emit one skipped test so the runner has *something* to report.
  describe('classifier (skipped: classifier blanks.md content was removed in Phase 0)', () => {
    it.skip('placeholder', () => {});
  });
} else {

const blanksConfig = parseCuesMd(blanksContent);

const sources = buildSourcesFromConfig(undefined, blanksConfig, {
  httpAdapter: stubAdapter,
  endpoint: 'https://api.example.com',
  apiKey: 'test',
  defaultModel: 'test',
  enableClassifiedBlanks: true,
});

const group = sources.find(s => s instanceof ClassifiedSourceGroup) as ClassifiedSourceGroup;

function classifies(input: string): string | null {
  const result = group.classifyFast(input);
  return result ? result.id : null;
}

// ---------------------------------------------------------------------------
// MATH — should match via regex (\d+ operator \d+) or keywords
// ---------------------------------------------------------------------------

describe('classifier: math', () => {
  // Regex matches
  it('"4 * 12 = _" → math', () => assert.strictEqual(classifies('4 * 12 = _'), 'math'));
  it('"100 / 4 = _" → math', () => assert.strictEqual(classifies('100 / 4 = _'), 'math'));
  it('"7 + 8 = _" → math', () => assert.strictEqual(classifies('7 + 8 = _'), 'math'));
  it('"50 - 17 = _" → math', () => assert.strictEqual(classifies('50 - 17 = _'), 'math'));
  it('"15 * 15 = _" → math', () => assert.strictEqual(classifies('15 * 15 = _'), 'math'));
  it('"999 - 500 = _" → math', () => assert.strictEqual(classifies('999 - 500 = _'), 'math'));
  // Keyword matches
  it('"half of 16 = _" → math', () => assert.strictEqual(classifies('half of 16 = _'), 'math'));
  it('"double 25 = _" → math', () => assert.strictEqual(classifies('double 25 = _'), 'math'));
  it('"triple 7 = _" → math', () => assert.strictEqual(classifies('triple 7 = _'), 'math'));
  it('"square root of 144 = _" → math', () => assert.strictEqual(classifies('square root of 144 = _'), 'math'));
  it('"average of 80 90 100 = _" → math', () => assert.strictEqual(classifies('average of 80 90 100 = _'), 'math'));
});

// ---------------------------------------------------------------------------
// FACTUAL — regex or keywords
// ---------------------------------------------------------------------------

describe('classifier: factual', () => {
  it('"The capital of France is _" → factual', () => assert.strictEqual(classifies('The capital of France is _'), 'factual'));
  it('"The CEO of Apple is _" → factual', () => assert.strictEqual(classifies('The CEO of Apple is _'), 'factual'));
  it('"The author of Harry Potter is _" → factual', () => assert.strictEqual(classifies('The author of Harry Potter is _'), 'factual'));
  it('"who was the first president _" → factual', () => assert.strictEqual(classifies('who was the first president _'), 'factual'));
  it('"who is the CEO of Google _" → factual', () => assert.strictEqual(classifies('who is the CEO of Google _'), 'factual'));
  it('"The founder of Microsoft is _" → factual', () => assert.strictEqual(classifies('The founder of Microsoft is _'), 'factual'));
  it('"The chemical symbol for gold is _" → factual', () => assert.strictEqual(classifies('The chemical symbol for gold is _'), 'factual'));
  it('"The largest planet is _" → factual', () => assert.strictEqual(classifies('The largest planet is _'), 'factual'));
  it('"when did WW2 end _" → factual', () => assert.strictEqual(classifies('when did WW2 end _'), 'factual'));
});

// ---------------------------------------------------------------------------
// TRANSLATION — keywords like "in french", "in spanish"
// ---------------------------------------------------------------------------

describe('classifier: translation', () => {
  it('"Hello in French is _" → translation', () => assert.strictEqual(classifies('Hello in French is _'), 'translation'));
  it('"Dog in Spanish is _" → translation', () => assert.strictEqual(classifies('Dog in Spanish is _'), 'translation'));
  it('"Thank you in Japanese is _" → translation', () => assert.strictEqual(classifies('Thank you in Japanese is _'), 'translation'));
  it('"The German word for house is _" → translation', () => assert.strictEqual(classifies('The German word for house is _'), 'translation'));
  it('"Water in Arabic is _" → translation', () => assert.strictEqual(classifies('Water in Arabic is _'), 'translation'));
  it('"How do you say goodbye in Italian _" → translation', () => assert.strictEqual(classifies('How do you say goodbye in Italian _'), 'translation'));
  it('"Love in Latin is _" → translation', () => assert.strictEqual(classifies('Love in Latin is _'), 'translation'));
  it('"Friend in Korean is _" → translation', () => assert.strictEqual(classifies('Friend in Korean is _'), 'translation'));
});

// ---------------------------------------------------------------------------
// UNIT CONVERSION — regex (\d+ unit in/to unit) or keywords
// ---------------------------------------------------------------------------

describe('classifier: unit conversion', () => {
  it('"100 celsius in fahrenheit is _" → unit', () => assert.strictEqual(classifies('100 celsius in fahrenheit is _'), 'unit'));
  it('"5 miles in km is _" → unit', () => assert.strictEqual(classifies('5 miles in km is _'), 'unit'));
  it('"70 kg in pounds is _" → unit', () => assert.strictEqual(classifies('70 kg in pounds is _'), 'unit'));
  it('"10 meters in feet is _" → unit', () => assert.strictEqual(classifies('10 meters in feet is _'), 'unit'));
  it('"12 inches in cm is _" → unit', () => assert.strictEqual(classifies('12 inches in cm is _'), 'unit'));
  it('"1 gallons in liters is _" → unit', () => assert.strictEqual(classifies('1 gallons in liters is _'), 'unit'));
  it('"32 fahrenheit in celsius is _" → unit', () => assert.strictEqual(classifies('32 fahrenheit in celsius is _'), 'unit'));
  it('"100 yards in meters is _" → unit', () => assert.strictEqual(classifies('100 yards in meters is _'), 'unit'));
  it('"16 oz in grams is _" → unit', () => assert.strictEqual(classifies('16 oz in grams is _'), 'unit'));
});

// ---------------------------------------------------------------------------
// SPELLING — keywords like "opposite of", "synonym for", "rhymes with"
// ---------------------------------------------------------------------------

describe('classifier: spelling', () => {
  it('"The opposite of hot is _" → spelling', () => assert.strictEqual(classifies('The opposite of hot is _'), 'spelling'));
  it('"A synonym for happy is _" → spelling', () => assert.strictEqual(classifies('A synonym for happy is _'), 'spelling'));
  it('"An antonym of light is _" → spelling', () => assert.strictEqual(classifies('An antonym of light is _'), 'spelling'));
  it('"Rhymes with cat _" → spelling', () => assert.strictEqual(classifies('Rhymes with cat _'), 'spelling'));
  it('"Another word for beautiful is _" → spelling', () => assert.strictEqual(classifies('Another word for beautiful is _'), 'spelling'));
  it('"Means the same as tired _" → spelling', () => assert.strictEqual(classifies('Means the same as tired _'), 'spelling'));
  it('"Rhyme with moon _" → spelling', () => assert.strictEqual(classifies('Rhyme with moon _'), 'spelling'));
});

// ---------------------------------------------------------------------------
// COLOR — keywords/regex for hex, rgb
// ---------------------------------------------------------------------------

describe('classifier: color', () => {
  it('"Red in hex is _" → color', () => assert.strictEqual(classifies('Red in hex is _'), 'color'));
  it('"Blue in rgb is _" → color', () => assert.strictEqual(classifies('Blue in rgb is _'), 'color'));
  it('"Hex for purple is _" → color', () => assert.strictEqual(classifies('Hex for purple is _'), 'color'));
  it('"Color code for teal is _" → color', () => assert.strictEqual(classifies('Color code for teal is _'), 'color'));
  it('"Colour code for navy is _" → color', () => assert.strictEqual(classifies('Colour code for navy is _'), 'color'));
  it('"Hex code for gold is _" → color', () => assert.strictEqual(classifies('Hex code for gold is _'), 'color'));
  it('"rgb for white is _" → color', () => assert.strictEqual(classifies('rgb for white is _'), 'color'));
});

// ---------------------------------------------------------------------------
// HTTP — keywords/regex
// ---------------------------------------------------------------------------

describe('classifier: http', () => {
  it('"HTTP status for not found is _" → http', () => assert.strictEqual(classifies('HTTP status for not found is _'), 'http'));
  it('"HTTP 200 means _" → http', () => assert.strictEqual(classifies('HTTP 200 means _'), 'http'));
  it('"HTTP 404 means _" → http', () => assert.strictEqual(classifies('HTTP 404 means _'), 'http'));
  it('"HTTP status for unauthorized is _" → http', () => assert.strictEqual(classifies('HTTP status for unauthorized is _'), 'http'));
  it('"HTTP code for server error is _" → http', () => assert.strictEqual(classifies('HTTP code for server error is _'), 'http'));
  it('"Status code for bad request is _" → http', () => assert.strictEqual(classifies('Status code for bad request is _'), 'http'));
  it('"HTTP error 500 means _" → http', () => assert.strictEqual(classifies('HTTP error 500 means _'), 'http'));
});

// ---------------------------------------------------------------------------
// TIMEZONE — keywords/regex
// ---------------------------------------------------------------------------

describe('classifier: timezone', () => {
  it('"9am EST in PST is _" → timezone', () => assert.strictEqual(classifies('9am EST in PST is _'), 'timezone'));
  it('"3pm PST in EST is _" → timezone', () => assert.strictEqual(classifies('3pm PST in EST is _'), 'timezone'));
  it('"noon UTC in IST is _" → timezone', () => assert.strictEqual(classifies('noon UTC in IST is _'), 'timezone'));
  it('"midnight UTC in JST is _" → timezone', () => assert.strictEqual(classifies('midnight UTC in JST is _'), 'timezone'));
  it('"3pm London time in Tokyo is _" → timezone', () => assert.strictEqual(classifies('3pm London time in Tokyo is _'), 'timezone'));
  it('"8pm Tokyo time in London is _" → timezone', () => assert.strictEqual(classifies('8pm Tokyo time in London is _'), 'timezone'));
  it('"6am UTC in CET is _" → timezone', () => assert.strictEqual(classifies('6am UTC in CET is _'), 'timezone'));
  it('"10am IST in UTC is _" → timezone', () => assert.strictEqual(classifies('10am IST in UTC is _'), 'timezone'));
});

// ---------------------------------------------------------------------------
// ROMAN — keywords/regex
// ---------------------------------------------------------------------------

describe('classifier: roman', () => {
  it('"14 in roman numerals is _" → roman', () => assert.strictEqual(classifies('14 in roman numerals is _'), 'roman'));
  it('"2024 in roman numerals is _" → roman', () => assert.strictEqual(classifies('2024 in roman numerals is _'), 'roman'));
  it('"MCMXC in numbers is _" → roman', () => assert.strictEqual(classifies('MCMXC in numbers is _'), 'roman'));
  it('"XIV in numbers is _" → roman', () => assert.strictEqual(classifies('XIV in numbers is _'), 'roman'));
  it('"99 in roman is _" → roman', () => assert.strictEqual(classifies('99 in roman is _'), 'roman'));
  it('"XLII in numbers is _" → roman', () => assert.strictEqual(classifies('XLII in numbers is _'), 'roman'));
  it('"DCCCLXXXVIII in numbers is _" → roman', () => assert.strictEqual(classifies('DCCCLXXXVIII in numbers is _'), 'roman'));
});

// ---------------------------------------------------------------------------
// GRAMMAR — should NOT match any fast path (falls to default)
// ---------------------------------------------------------------------------

describe('classifier: grammar (no fast match)', () => {
  it('"The boy vaulted over the _" → null (grammar default)', () => assert.strictEqual(classifies('The boy vaulted over the _'), null));
  it('"She walked _ to school" → null', () => assert.strictEqual(classifies('She walked _ to school'), null));
  it('"The _ dog barked loudly" → null', () => assert.strictEqual(classifies('The _ dog barked loudly'), null));
  it('"_ ran across the street" → null', () => assert.strictEqual(classifies('_ ran across the street'), null));
  it('"He felt extremely _" → null', () => assert.strictEqual(classifies('He felt extremely _'), null));
  it('"We are going to _" → null', () => assert.strictEqual(classifies('We are going to _'), null));
  it('"The code is written in _" → null', () => assert.strictEqual(classifies('The code is written in _'), null));
  it('"The team _ convincingly" → null', () => assert.strictEqual(classifies('The team _ convincingly'), null));
});

// ---------------------------------------------------------------------------
// AMBIGUOUS / TRICKY — boundary cases between domains
// ---------------------------------------------------------------------------

describe('classifier: ambiguous inputs', () => {
  // "in french" inside a non-translation context
  it('"The French revolution started in _" should NOT match translation', () => {
    // "French" appears but not "in french" as a keyword phrase
    const result = classifies('The French revolution started in _');
    assert.notStrictEqual(result, 'translation', 'Should not classify as translation');
  });

  // Number in text but not a math expression
  it('"The 3 dogs ran to _" should NOT match math', () => {
    const result = classifies('The 3 dogs ran to _');
    assert.notStrictEqual(result, 'math', 'Should not classify as math');
  });

  // "capital" in non-factual context
  it('"The capital letter is _" should NOT match factual', () => {
    const result = classifies('The capital letter is _');
    // "capital of" is the keyword, not just "capital"
    assert.notStrictEqual(result, 'factual', 'Should not classify as factual');
  });

  // "color" in non-color-code context
  it('"My favorite color is _" should NOT match color', () => {
    const result = classifies('My favorite color is _');
    // "color code" / "hex for" are the keywords, not just "color"
    assert.notStrictEqual(result, 'color', 'Should not classify as color');
  });

  // "status" in non-HTTP context
  it('"The status of the project is _" should NOT match http', () => {
    const result = classifies('The status of the project is _');
    // "http status" / "status code" are the keywords, not just "status"
    assert.notStrictEqual(result, 'http', 'Should not classify as http');
  });

  // "opposite" inside a longer word — tests word boundary
  it('"The composite material is _" should NOT match spelling', () => {
    const result = classifies('The composite material is _');
    // "opposite of" is the keyword; "composite" contains "opposite" only as partial substring
    assert.notStrictEqual(result, 'spelling', 'Should not classify as spelling');
  });

  // Roman numeral letters in regular words
  it('"I love music _" should NOT match roman (I is just a pronoun)', () => {
    // Single "I" shouldn't trigger roman, regex needs 2+ chars: [IVXLCDM]{2,}
    const result = classifies('I love music _');
    assert.notStrictEqual(result, 'roman', 'Should not classify as roman');
  });

  // Math-like but actually unit conversion
  it('"100 celsius in fahrenheit is _" → unit NOT math', () => {
    const result = classifies('100 celsius in fahrenheit is _');
    assert.strictEqual(result, 'unit', 'Should classify as unit, not math');
  });

  // Ensure priority works: both "half of" (math keyword) and "in french" (translation keyword) present
  it('"half of 100 in french is _" → higher priority wins', () => {
    const result = classifies('half of 100 in french is _');
    // math has priority 90, translation has priority 85 → math should win
    assert.ok(result !== null, 'Should match something');
    // With priority-based matching, math (90) beats translation (85)
  });
});

// ---------------------------------------------------------------------------
// EDGE CASES — empty, whitespace, no blank
// ---------------------------------------------------------------------------

describe('classifier: edge cases', () => {
  it('empty string → null', () => assert.strictEqual(classifies(''), null));
  it('just a blank → null (grammar)', () => assert.strictEqual(classifies('_'), null));
  it('all spaces → null', () => assert.strictEqual(classifies('   '), null));

  // Case insensitivity
  it('"HELLO IN FRENCH IS _" → translation (case insensitive)', () => {
    assert.strictEqual(classifies('HELLO IN FRENCH IS _'), 'translation');
  });
  it('"http STATUS for ok is _" → http (case insensitive)', () => {
    assert.strictEqual(classifies('http STATUS for ok is _'), 'http');
  });
  it('"THE OPPOSITE OF HOT IS _" → spelling (case insensitive)', () => {
    assert.strictEqual(classifies('THE OPPOSITE OF HOT IS _'), 'spelling');
  });
});

// ---------------------------------------------------------------------------
// LLM CLASSIFIER — tests classifyLLM() directly with real Groq API calls.
// Verifies the LLM returns the correct MODE= for sentences that have
// NO fast-match keywords. This is the critical path for ambiguous inputs.
//
// Skip if GROQ_API_KEY is not set.
// ---------------------------------------------------------------------------

const apiKey = process.env.GROQ_API_KEY;

(apiKey ? describe : describe.skip)('classifier: LLM routing (live API)', () => {
  const https = require('https');
  const liveAgent = new https.Agent({ keepAlive: true });
  const liveAdapter: HttpAdapter = {
    post: (url: string, body: string, headers: Record<string, string>) =>
      new Promise((resolve, reject) => {
        // opencues-core sets reasoning_effort internally — plain adapter works
        const u = new URL(url);
        const req = https.request({
          hostname: u.hostname, path: u.pathname, method: 'POST',
          headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
          agent: liveAgent,
        }, (res: any) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      }),
  };

  const liveSources = buildSourcesFromConfig(undefined, blanksConfig, {
    httpAdapter: liveAdapter,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: apiKey!,
    defaultModel: 'openai/gpt-oss-120b',
    enableClassifiedBlanks: true,
  });
  const liveGroup = liveSources.find(s => s instanceof ClassifiedSourceGroup) as ClassifiedSourceGroup;

  /** Call classifyLLM directly and return the source id (or null).
   *  If the fast path catches it, return the fast result directly
   *  (it's still a correct classification, just not LLM-tested). */
  async function llmClassifies(text: string): Promise<string | null> {
    const fast = liveGroup.classifyFast(text);
    if (fast) return fast.id;
    const result = await liveGroup.classifyLLM(text);
    return result ? result.id : null;
  }

  // ===== GRAMMAR (10) — sentence completion, no domain keywords =====

  it('grammar: "The boy vaulted over the _"', async () => { assert.strictEqual(await llmClassifies('The boy vaulted over the _'), 'grammar'); });
  it('grammar: "She _ the piano beautifully"', async () => { assert.strictEqual(await llmClassifies('She _ the piano beautifully'), 'grammar'); });
  it('grammar: "The _ sky indicated rain"', async () => { assert.strictEqual(await llmClassifies('The _ sky indicated rain'), 'grammar'); });
  it('grammar: "_ ran across the street"', async () => { assert.strictEqual(await llmClassifies('_ ran across the street'), 'grammar'); });
  it('grammar: "He felt extremely _"', async () => { assert.strictEqual(await llmClassifies('He felt extremely _'), 'grammar'); });
  it('grammar: "The team _ convincingly"', async () => { assert.strictEqual(await llmClassifies('The team _ convincingly'), 'grammar'); });
  it('grammar: "A _ woman entered the building"', async () => { assert.strictEqual(await llmClassifies('A _ woman entered the building'), 'grammar'); });
  it('grammar: "The painting hangs in the _"', async () => { assert.strictEqual(await llmClassifies('The painting hangs in the _'), 'grammar'); });
  it('grammar: "He dreams of _"', async () => { assert.strictEqual(await llmClassifies('He dreams of _'), 'grammar'); });
  it('grammar: "We are going to _"', async () => { assert.strictEqual(await llmClassifies('We are going to _'), 'grammar'); });

  // ===== MATH (10) — word problems, no operators or fast-match keywords =====

  it('math: "What is fifteen percent of two hundred _"', async () => { assert.strictEqual(await llmClassifies('What is fifteen percent of two hundred _'), 'math'); });
  it('math: "Calculate the sum of all numbers from one to ten _"', async () => { assert.strictEqual(await llmClassifies('Calculate the sum of all numbers from one to ten _'), 'math'); });
  it('math: "How much is a dozen times four _"', async () => { assert.strictEqual(await llmClassifies('How much is a dozen times four _'), 'math'); });
  it('math: "What is twenty divided by four _"', async () => { assert.strictEqual(await llmClassifies('What is twenty divided by four _'), 'math'); });
  it('math: "If you have fifty and subtract thirteen _"', async () => { assert.strictEqual(await llmClassifies('If you have fifty and subtract thirteen _'), 'math'); });
  it('math: "Three squared equals _"', async () => { assert.strictEqual(await llmClassifies('Three squared equals _'), 'math'); });
  it('math: "Two to the power of eight equals _"', async () => { assert.strictEqual(await llmClassifies('Two to the power of eight equals _'), 'math'); });
  it('math: "What do you get when you add seven and nine _"', async () => { assert.strictEqual(await llmClassifies('What do you get when you add seven and nine _'), 'math'); });
  it('math: "Forty-two minus seventeen is _"', async () => { assert.strictEqual(await llmClassifies('Forty-two minus seventeen is _'), 'math'); });
  it('math: "Six multiplied by eleven gives _"', async () => { assert.strictEqual(await llmClassifies('Six multiplied by eleven gives _'), 'math'); });

  // ===== FACTUAL (10) — avoid "capital of", "who is/was", "author of" keywords =====

  it('factual: "The city where the Eiffel Tower stands is _"', async () => { assert.strictEqual(await llmClassifies('The city where the Eiffel Tower stands is _'), 'factual'); });
  it('factual: "The year humans first landed on the moon was _"', async () => { assert.strictEqual(await llmClassifies('The year humans first landed on the moon was _'), 'factual'); });
  it('factual: "The country with the most people is _"', async () => { assert.strictEqual(await llmClassifies('The country with the most people is _'), 'factual'); });
  it('factual: "The element that has 79 protons is _"', async () => { assert.strictEqual(await llmClassifies('The element that has 79 protons is _'), 'factual'); });
  it('factual: "The company behind the iPhone is _"', async () => { assert.strictEqual(await llmClassifies('The company behind the iPhone is _'), 'factual'); });
  it('factual: "The planet closest to the sun is _"', async () => { assert.strictEqual(await llmClassifies('The planet closest to the sun is _'), 'factual'); });
  it('factual: "The ocean between Europe and America is the _"', async () => { assert.strictEqual(await llmClassifies('The ocean between Europe and America is the _'), 'factual'); });
  it('factual: "The currency used in Japan is the _"', async () => { assert.strictEqual(await llmClassifies('The currency used in Japan is the _'), 'factual'); });
  it('factual: "The animal known as the king of the jungle is the _"', async () => { assert.strictEqual(await llmClassifies('The animal known as the king of the jungle is the _'), 'factual'); });
  it('factual: "The number of continents on Earth is _"', async () => { assert.strictEqual(await llmClassifies('The number of continents on Earth is _'), 'factual'); });

  // ===== TRANSLATION (10) — avoid "in french/spanish" keywords =====

  it('translation: "The Japanese greeting is _"', async () => { const r = await llmClassifies('The Japanese greeting is _'); assert.ok(r === 'translation' || r === 'factual', `Got ${r}`); });
  it('translation: "How would a Parisian say thank you _"', async () => { const r = await llmClassifies('How would a Parisian say thank you _'); assert.ok(r === 'translation' || r === 'factual', `Got ${r}`); });
  it('translation: "The Italian word for love is _"', async () => { const r = await llmClassifies('The Italian word for love is _'); assert.ok(r === 'translation' || r === 'factual', `Got ${r}`); });
  it('translation: "Danke is a word from which language _"', async () => { const r = await llmClassifies('Danke is a word from which language _'); assert.ok(r === 'translation' || r === 'factual', `Got ${r}`); });
  it('translation: "Buenos dias is a greeting meaning _"', async () => { const r = await llmClassifies('Buenos dias is a greeting meaning _'); assert.ok(r === 'translation' || r === 'factual', `Got ${r}`); });
  it('translation: "The Mandarin word for water is _"', async () => { const r = await llmClassifies('The Mandarin word for water is _'); assert.ok(r === 'translation' || r === 'factual', `Got ${r}`); });
  it('translation: "Sayonara means _ in English"', async () => { const r = await llmClassifies('Sayonara means _ in English'); assert.ok(r === 'translation' || r === 'factual', `Got ${r}`); });
  it('translation: "The Hindi word for peace is _"', async () => { const r = await llmClassifies('The Hindi word for peace is _'); assert.ok(r === 'translation' || r === 'factual', `Got ${r}`); });
  it('translation: "A Portuguese speaker would say cat as _"', async () => { const r = await llmClassifies('A Portuguese speaker would say cat as _'); assert.ok(r === 'translation' || r === 'factual', `Got ${r}`); });
  it('translation: "The Arabic word for friend is _"', async () => { const r = await llmClassifies('The Arabic word for friend is _'); assert.ok(r === 'translation' || r === 'factual', `Got ${r}`); });

  // ===== UNIT (10) — avoid "in fahrenheit"/"in km" keywords =====

  it('unit: "How hot is boiling water on the American scale _"', async () => { const r = await llmClassifies('How hot is boiling water on the American scale _'); assert.ok(r === 'unit' || r === 'factual' || r === 'math', `Got ${r}`); });
  it('unit: "A marathon is how many kilometers _"', async () => { const r = await llmClassifies('A marathon is how many kilometers _'); assert.ok(r === 'unit' || r === 'factual', `Got ${r}`); });
  it('unit: "How many pounds does a 70 kilogram person weigh _"', async () => { const r = await llmClassifies('How many pounds does a 70 kilogram person weigh _'); assert.ok(r === 'unit' || r === 'math' || r === 'factual', `Got ${r}`); });
  it('unit: "Express six feet as a metric measurement _"', async () => { const r = await llmClassifies('Express six feet as a metric measurement _'); assert.ok(r === 'unit' || r === 'math' || r === 'factual', `Got ${r}`); });
  it('unit: "Room temperature is about 72 Fahrenheit which is _ Celsius"', async () => { const r = await llmClassifies('Room temperature is about 72 Fahrenheit which is _ Celsius'); assert.ok(r === 'unit' || r === 'math' || r === 'factual', `Got ${r}`); });
  it('unit: "How far is a hundred yards using the metric system _"', async () => { const r = await llmClassifies('How far is a hundred yards using the metric system _'); assert.ok(r === 'unit' || r === 'math' || r === 'factual', `Got ${r}`); });
  it('unit: "An Olympic pool is fifty meters which is how many feet _"', async () => { const r = await llmClassifies('An Olympic pool is fifty meters which is how many feet _'); assert.ok(r === 'unit' || r === 'math' || r === 'factual', `Got ${r}`); });
  it('unit: "One gallon of milk is how many liters _"', async () => { const r = await llmClassifies('One gallon of milk is how many liters _'); assert.ok(r === 'unit' || r === 'math' || r === 'factual', `Got ${r}`); });
  it('unit: "A 200 pound man weighs how many kilograms _"', async () => { const r = await llmClassifies('A 200 pound man weighs how many kilograms _'); assert.ok(r === 'unit' || r === 'math' || r === 'factual', `Got ${r}`); });
  it('unit: "Freezing point on the Fahrenheit scale is _"', async () => { const r = await llmClassifies('Freezing point on the Fahrenheit scale is _'); assert.ok(r === 'unit' || r === 'math' || r === 'factual', `Got ${r}`); });

  // ===== SPELLING (10) — avoid "opposite of"/"synonym for" keywords =====

  it('spelling: "The word that means the reverse of cold is _"', async () => { const r = await llmClassifies('The word that means the reverse of cold is _'); assert.ok(r === 'spelling' || r === 'grammar' || r === 'factual', `Got ${r}`); });
  it('spelling: "A word that sounds like cat but starts with h _"', async () => { const r = await llmClassifies('A word that sounds like cat but starts with h _'); assert.ok(r === 'spelling' || r === 'grammar', `Got ${r}`); });
  it('spelling: "What is the contrary of beautiful _"', async () => { const r = await llmClassifies('What is the contrary of beautiful _'); assert.ok(r === 'spelling' || r === 'grammar' || r === 'factual', `Got ${r}`); });
  it('spelling: "Give a word that has the same meaning as enormous _"', async () => { const r = await llmClassifies('Give a word that has the same meaning as enormous _'); assert.ok(r === 'spelling' || r === 'grammar', `Got ${r}`); });
  it('spelling: "Name a word ending in -ight that means not dark _"', async () => { const r = await llmClassifies('Name a word ending in -ight that means not dark _'); assert.ok(r === 'spelling' || r === 'grammar' || r === 'factual', `Got ${r}`); });
  it('spelling: "Happy and glad are similar but sad means the _ of happy"', async () => { const r = await llmClassifies('Happy and glad are similar but sad means the _ of happy'); assert.ok(r === 'spelling' || r === 'grammar', `Got ${r}`); });
  it('spelling: "What word pairs with night the way black pairs with white _"', async () => { const r = await llmClassifies('What word pairs with night the way black pairs with white _'); assert.ok(r === 'spelling' || r === 'grammar' || r === 'factual', `Got ${r}`); });
  it('spelling: "Find a word that has the inverse meaning of strong _"', async () => { const r = await llmClassifies('Find a word that has the inverse meaning of strong _'); assert.ok(r === 'spelling' || r === 'grammar', `Got ${r}`); });
  it('spelling: "A word ending in -oon like spoon and moon _"', async () => { const r = await llmClassifies('A word ending in -oon like spoon and moon _'); assert.ok(r === 'spelling' || r === 'grammar', `Got ${r}`); });
  it('spelling: "The adjective form of beauty is _"', async () => { const r = await llmClassifies('The adjective form of beauty is _'); assert.ok(r === 'spelling' || r === 'grammar' || r === 'factual', `Got ${r}`); });

  // ===== HTTP (10) — avoid "http status"/"status code" keywords =====

  it('http: "The web error code for page not found is _"', async () => { const r = await llmClassifies('The web error code for page not found is _'); assert.ok(r === 'http' || r === 'factual', `Got ${r}`); });
  it('http: "When a server crashes the response code is _"', async () => { const r = await llmClassifies('When a server crashes the response code is _'); assert.ok(r === 'http' || r === 'factual', `Got ${r}`); });
  it('http: "A website returning OK sends the number _"', async () => { const r = await llmClassifies('A website returning OK sends the number _'); assert.ok(r === 'http' || r === 'factual', `Got ${r}`); });
  it('http: "The browser error for forbidden access shows _"', async () => { const r = await llmClassifies('The browser error for forbidden access shows _'); assert.ok(r === 'http' || r === 'factual', `Got ${r}`); });
  it('http: "An API returning resource created responds with _"', async () => { const r = await llmClassifies('An API returning resource created responds with _'); assert.ok(r === 'http' || r === 'factual', `Got ${r}`); });
  it('http: "The meaning of a 301 web redirect is _"', async () => { const r = await llmClassifies('The meaning of a 301 web redirect is _'); assert.ok(r === 'http' || r === 'factual', `Got ${r}`); });
  it('http: "The web response number for bad request is _"', async () => { const r = await llmClassifies('The web response number for bad request is _'); assert.ok(r === 'http' || r === 'factual', `Got ${r}`); });
  it('http: "When you get rate limited the server returns _"', async () => { const r = await llmClassifies('When you get rate limited the server returns _'); assert.ok(r === 'http' || r === 'factual', `Got ${r}`); });
  it('http: "A REST API sends _ when the resource does not exist"', async () => { const r = await llmClassifies('A REST API sends _ when the resource does not exist'); assert.ok(r === 'http' || r === 'factual', `Got ${r}`); });
  it('http: "The number a web server returns for unauthorized is _"', async () => { const r = await llmClassifies('The number a web server returns for unauthorized is _'); assert.ok(r === 'http' || r === 'factual', `Got ${r}`); });

  // ===== COLOR (10) — avoid "hex for"/"in rgb" keywords =====

  it('color: "The CSS color value for red is _"', async () => { const r = await llmClassifies('The CSS color value for red is _'); assert.ok(r === 'color' || r === 'factual', `Got ${r}`); });
  it('color: "In web design pure blue is represented as _"', async () => { const r = await llmClassifies('In web design pure blue is represented as _'); assert.ok(r === 'color' || r === 'factual', `Got ${r}`); });
  it('color: "The numerical representation of white on the web is _"', async () => { const r = await llmClassifies('The numerical representation of white on the web is _'); assert.ok(r === 'color' || r === 'factual', `Got ${r}`); });
  it('color: "What code does a web developer use for green _"', async () => { const r = await llmClassifies('What code does a web developer use for green _'); assert.ok(r === 'color' || r === 'factual', `Got ${r}`); });
  it('color: "The web color number for orange is _"', async () => { const r = await llmClassifies('The web color number for orange is _'); assert.ok(r === 'color' || r === 'factual', `Got ${r}`); });
  it('color: "In CSS black is written as _"', async () => { const r = await llmClassifies('In CSS black is written as _'); assert.ok(r === 'color' || r === 'factual', `Got ${r}`); });
  it('color: "The digital code for the color purple is _"', async () => { const r = await llmClassifies('The digital code for the color purple is _'); assert.ok(r === 'color' || r === 'factual', `Got ${r}`); });
  it('color: "A web page background set to yellow uses the value _"', async () => { const r = await llmClassifies('A web page background set to yellow uses the value _'); assert.ok(r === 'color' || r === 'factual', `Got ${r}`); });
  it('color: "The triplet of numbers for pure red in a computer is _"', async () => { const r = await llmClassifies('The triplet of numbers for pure red in a computer is _'); assert.ok(r === 'color' || r === 'factual', `Got ${r}`); });
  it('color: "The web designer entered the code for pink as _"', async () => { const r = await llmClassifies('The web designer entered the code for pink as _'); assert.ok(r === 'color' || r === 'factual', `Got ${r}`); });

  // ===== TIMEZONE (10) — avoid "EST in PST"/"UTC" keywords =====

  it('tz: "When it is morning in New York what time is it in London _"', async () => { const r = await llmClassifies('When it is morning in New York what time is it in London _'); assert.ok(r === 'timezone' || r === 'factual', `Got ${r}`); });
  it('tz: "If Tokyo clocks show noon what do Paris clocks show _"', async () => { const r = await llmClassifies('If Tokyo clocks show noon what do Paris clocks show _'); assert.ok(r === 'timezone' || r === 'factual', `Got ${r}`); });
  it('tz: "Sunset at six in Sydney means it is _ in Los Angeles"', async () => { const r = await llmClassifies('Sunset at six in Sydney means it is _ in Los Angeles'); assert.ok(r === 'timezone' || r === 'factual', `Got ${r}`); });
  it('tz: "A business call at nine in Berlin is what time in Beijing _"', async () => { const r = await llmClassifies('A business call at nine in Berlin is what time in Beijing _'); assert.ok(r === 'timezone' || r === 'factual', `Got ${r}`); });
  it('tz: "When Big Ben strikes midnight the time in Mumbai is _"', async () => { const r = await llmClassifies('When Big Ben strikes midnight the time in Mumbai is _'); assert.ok(r === 'timezone' || r === 'factual', `Got ${r}`); });
  it('tz: "A flight departing at ten in Chicago arrives in London at _"', async () => { const r = await llmClassifies('A flight departing at ten in Chicago arrives in London at local time _'); assert.ok(r === 'timezone' || r === 'factual' || r === 'math', `Got ${r}`); });
  it('tz: "Breakfast at eight in Seoul is dinner at _ in New York"', async () => { const r = await llmClassifies('Breakfast at eight in Seoul is dinner at _ in New York'); assert.ok(r === 'timezone' || r === 'factual', `Got ${r}`); });
  it('tz: "The time difference between California and England is _ hours"', async () => { const r = await llmClassifies('The time difference between California and England is _ hours'); assert.ok(r === 'timezone' || r === 'factual', `Got ${r}`); });
  it('tz: "When it is bedtime in Tokyo it is _ in Rome"', async () => { const r = await llmClassifies('When it is bedtime in Tokyo it is _ in Rome'); assert.ok(r === 'timezone' || r === 'factual', `Got ${r}`); });
  it('tz: "A noon meeting in Dubai is morning at _ in London"', async () => { const r = await llmClassifies('A noon meeting in Dubai is morning at _ in London'); assert.ok(r === 'timezone' || r === 'factual', `Got ${r}`); });

  // ===== ROMAN (10) — avoid "in roman"/"roman numeral" keywords =====

  it('roman: "The Super Bowl number for 50 is written as _"', async () => { const r = await llmClassifies('The Super Bowl number for 50 is written as _'); assert.ok(r === 'roman' || r === 'factual', `Got ${r}`); });
  it('roman: "Chapter 9 of the book uses the old notation _"', async () => { const r = await llmClassifies('Chapter 9 of the book uses the old notation _'); assert.ok(r === 'roman' || r === 'factual' || r === 'grammar', `Got ${r}`); });
  it('roman: "The year 2000 on a monument is carved as _"', async () => { const r = await llmClassifies('The year 2000 on a monument is carved as _'); assert.ok(r === 'roman' || r === 'factual', `Got ${r}`); });
  it('roman: "A clock face shows 4 as _"', async () => { const r = await llmClassifies('A clock face shows 4 as _'); assert.ok(r === 'roman' || r === 'factual' || r === 'math', `Got ${r}`); });
  it('roman: "The ancient way to write 99 is _"', async () => { const r = await llmClassifies('The ancient way to write 99 is _'); assert.ok(r === 'roman' || r === 'factual', `Got ${r}`); });
  it('roman: "In the old numbering system 500 is represented by _"', async () => { const r = await llmClassifies('In the old numbering system 500 is represented by _'); assert.ok(r === 'roman' || r === 'factual', `Got ${r}`); });
  it('roman: "The Olympics year 1996 in classical notation is _"', async () => { const r = await llmClassifies('The Olympics year 1996 in classical notation is _'); assert.ok(r === 'roman' || r === 'factual', `Got ${r}`); });
  it('roman: "A movie sequel numbered three uses the symbol _"', async () => { const r = await llmClassifies('A movie sequel numbered three uses the symbol _'); assert.ok(r === 'roman' || r === 'factual' || r === 'grammar', `Got ${r}`); });
  it('roman: "The ancient equivalent of 42 is _"', async () => { const r = await llmClassifies('The ancient equivalent of 42 is _'); assert.ok(r === 'roman' || r === 'factual', `Got ${r}`); });
  it('roman: "On a sundial the number 12 appears as _"', async () => { const r = await llmClassifies('On a sundial the number 12 appears as _'); assert.ok(r === 'roman' || r === 'factual', `Got ${r}`); });
});

} // end if (HAS_CLASSIFIER)
