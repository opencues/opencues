/**
 * Classifier for the post-P1 pipeline.
 *
 * Takes the SPAN that P1 identified (the lookup phrase + _) and decides
 * which domain handler should answer it: MATH, FACTUAL, TRANSLATION,
 * UNIT, SPELLING, COLOR, HTTP, TIMEZONE, ROMAN, or GRAMMAR.
 *
 * Same prompt as the production classifier in defaults/blanks.md, but
 * receives the cleaned-up SPAN instead of the full noisy input. Should
 * route more accurately since preamble noise is gone.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `Classify the lookup query into one mode: MATH, FACTUAL, TRANSLATION, UNIT, SPELLING, COLOR, HTTP, TIMEZONE, ROMAN, or GRAMMAR.

MATH - Contains calculations, numbers with operators, percentages, or word math:
- "4 * 12 = _" → MATH
- "half of 16 = _" → MATH
- "50 plus 20% tax = _" → MATH
- "average of 80, 90, 100 = _" → MATH

FACTUAL - Asks for specific facts, names, dates, or knowledge:
- "The CEO of Apple is _" → FACTUAL
- "The capital of France is _" → FACTUAL
- "The chemical symbol for gold is _" → FACTUAL
- "capital of france _" → FACTUAL
- "year apollo 11 landed on the moon _" → FACTUAL
- "founder of facebook _" → FACTUAL

TRANSLATION - Translating a word or phrase into another language:
- "Hello in French is _" → TRANSLATION
- "Dog in Spanish is _" → TRANSLATION
- "french word for love _" → TRANSLATION

UNIT - Converting between measurement units:
- "100 celsius in fahrenheit is _" → UNIT
- "5 miles in km is _" → UNIT
- "10 kg in pounds is _" → UNIT
- "350 fahrenheit in celsius _" → UNIT

SPELLING - Word relationships (opposites, synonyms, rhymes):
- "The opposite of hot is _" → SPELLING
- "A synonym for happy is _" → SPELLING
- "Rhymes with cat _" → SPELLING
- "better word for sad _" → SPELLING

COLOR - Color codes and color space conversions:
- "Red in hex is _" → COLOR
- "Hex for blue is _" → COLOR
- "#FF0000 in rgb is _" → COLOR
- "rgb for navy blue _" → COLOR

HTTP - HTTP status codes and meanings:
- "HTTP status for not found is _" → HTTP
- "HTTP 200 means _" → HTTP
- "http status for unauthorized _" → HTTP

TIMEZONE - Time zone conversions:
- "3pm London in Tokyo is _" → TIMEZONE
- "9am EST in PST is _" → TIMEZONE

ROMAN - Roman numeral conversions:
- "14 in roman numerals is _" → ROMAN
- "MCMXC in numbers is _" → ROMAN

GRAMMAR - Needs word alternatives or sentence completion (default fallback):
- "The nervous boy _ quickly" → GRAMMAR
- "The _ dog barked loudly" → GRAMMAR
- "_ ran across the street" → GRAMMAR

Output ONLY one line: MODE=<one of the above>`;

export type Mode = 'MATH' | 'FACTUAL' | 'TRANSLATION' | 'UNIT' | 'SPELLING' | 'COLOR' | 'HTTP' | 'TIMEZONE' | 'ROMAN' | 'GRAMMAR';

export interface ClassifyResult {
  mode: Mode;
  raw: string;
  latencyMs: number;
}

const MODE_NAMES: Mode[] = ['MATH', 'FACTUAL', 'TRANSLATION', 'UNIT', 'SPELLING', 'COLOR', 'HTTP', 'TIMEZONE', 'ROMAN', 'GRAMMAR'];

export async function classify(span: string): Promise<ClassifyResult> {
  const result = await chat(sysUser(SYSTEM_PROMPT, `Lookup: ${span}`), {
    maxTokens: 50,
    temperature: 0,
  });
  const upper = result.text.toUpperCase();
  const matched = MODE_NAMES.find(m => upper.includes(`MODE=${m}`));
  return {
    mode: matched ?? 'FACTUAL', // safe default
    raw: result.text,
    latencyMs: result.latencyMs,
  };
}
