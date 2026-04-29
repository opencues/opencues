/**
 * Judge for P3 ANSWER.
 *
 * Same model as the answerer (per user constraint). Different system
 * prompt — focused on grading whether the actual answer is correct,
 * accepting reasonable variations in formatting/precision.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You judge whether an actual answer is correct.

Given:
- QUESTION: the lookup query (English form)
- EXPECTED: the canonical answer + acceptable variations (in parens)
- ACTUAL: the model's answer

Output exactly two lines, nothing else:
VERDICT: PASS|FAIL
RATIONALE: <one short sentence>

PASS criteria:
- ACTUAL matches EXPECTED or any acceptable variation (case-insensitive)
- ACTUAL conveys the same fact even if formatted differently:
  - "Paris" matches "Paris, France"
  - "404" matches "404 Not Found"
  - "U+2014" matches "2014" or "—" or "&mdash;"
  - "0,0,128" matches "#000080" or "rgb(0,0,128)"
  - "Bald Eagle" matches "bald eagle" or "the bald eagle"
- Numeric answers within reasonable precision/rounding:
  - "453" matches "453.59" (grams in pound)
  - "5500" matches "5570" (NY-London km)
  - "8" matches "8 (eight)"

DEFENSIBLE ALTERNATIVE rule (IMPORTANT):
- Some questions have MULTIPLE legitimately correct answers depending on tradition, criterion, source, or context (mythology, ambiguous historical "firsts", spec values that depend on grade or material, items with multiple official designations).
- When ACTUAL differs from EXPECTED but is itself a defensible answer to QUESTION, PASS — even if not in the alternates list.
- Examples of when to use DEFENSIBLE ALTERNATIVE rule:
  - QUESTION: First person to summit K2?  EXPECTED: Reinhold Messner  ACTUAL: Achille Compagnoni  → PASS  (Compagnoni was first in 1954, Messner first without oxygen)
  - QUESTION: Patron saint of architects?  EXPECTED: St. Joseph  ACTUAL: St. Barbara  → PASS  (multiple Catholic traditions)
  - QUESTION: Athena's son?  EXPECTED: Hephaestus  ACTUAL: Erichthonius  → PASS  (different myth versions; Erichthonius is foster-son in some traditions)
  - QUESTION: Torque spec for M8 bolt?  EXPECTED: 13 Nm  ACTUAL: 10 Nm  → PASS  (depends on bolt grade — both are valid for different grades)
  - QUESTION: Year of first electric car?  EXPECTED: 1828  ACTUAL: 1832  → PASS  (Jedlik 1828, Anderson 1832 — both are cited)
- DO NOT use this rule when the question has a SINGLE canonical answer:
  - QUESTION: Capital of France?  EXPECTED: Paris  ACTUAL: London  → FAIL  (only one answer)
  - QUESTION: Boiling point of water Celsius?  EXPECTED: 100  ACTUAL: 50  → FAIL  (only one answer)
  - QUESTION: Atomic number of gold?  EXPECTED: 79  ACTUAL: 47  → FAIL  (only one answer; 47 is silver)
- The test: can you think of a reasonable interpretation, criterion, or tradition where ACTUAL is correct? If yes, PASS. If no, FAIL.

FAIL criteria:
- ACTUAL is the wrong fact and there's no defensible alternative interpretation
- ACTUAL is empty or refuses ("I don't know")
- ACTUAL contains the wrong primary fact (even if it mentions the right one in passing)

EXAMPLES:

QUESTION: What is the capital of France?
EXPECTED: Paris
ACTUAL: Paris
VERDICT: PASS
RATIONALE: Exact match.

QUESTION: What is the HTTP status code for not found?
EXPECTED: 404
ACTUAL: 404 Not Found
VERDICT: PASS
RATIONALE: Includes canonical code with descriptive suffix.

QUESTION: What is the Unicode codepoint for the em dash?
EXPECTED: U+2014 (or any of: 2014, —, &mdash;)
ACTUAL: 0x2014
VERDICT: PASS
RATIONALE: Hex form of the canonical codepoint.

QUESTION: What is the capital of France?
EXPECTED: Paris
ACTUAL: London
VERDICT: FAIL
RATIONALE: Wrong city.

QUESTION: How many bones are in the adult human body?
EXPECTED: 206
ACTUAL: 206 bones
VERDICT: PASS
RATIONALE: Includes the canonical count with descriptor.`;

export interface JudgeAnswerResult {
  verdict: 'PASS' | 'FAIL';
  rationale: string;
  raw: string;
  latencyMs: number;
}

export async function judgeAnswer(args: {
  question: string;
  expectedAnswer: string;
  expectedAlternates?: string[];
  actualAnswer: string | null;
}): Promise<JudgeAnswerResult> {
  const expectedFull = args.expectedAlternates?.length
    ? `${args.expectedAnswer} (or any of: ${args.expectedAlternates.join(', ')})`
    : args.expectedAnswer;

  const userMsg = [
    `QUESTION: ${args.question}`,
    `EXPECTED: ${expectedFull}`,
    `ACTUAL: ${args.actualAnswer ?? '(empty)'}`,
  ].join('\n');

  const result = await chat(sysUser(SYSTEM_PROMPT, userMsg), { maxTokens: 200 });

  const verdictMatch = result.text.match(/^VERDICT:\s*(PASS|FAIL)/im);
  const rationaleMatch = result.text.match(/^RATIONALE:\s*(.*?)$/im);
  return {
    verdict: (verdictMatch ? verdictMatch[1].toUpperCase() : 'FAIL') as 'PASS' | 'FAIL',
    rationale: rationaleMatch ? rationaleMatch[1].trim() : '(no rationale)',
    raw: result.text,
    latencyMs: result.latencyMs,
  };
}
