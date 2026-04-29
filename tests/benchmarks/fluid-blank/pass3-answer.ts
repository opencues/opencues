/**
 * Pass 3: ANSWER
 *
 * Takes P1's output {span, context} and produces the canonical short
 * answer that substitutes for the span when it gets wiped. Terse —
 * single value/number/name/code/phrase. Uses CONTEXT only for
 * disambiguation when SPAN is incomplete on its own.
 *
 * In 2-pass mode (P1 → P3), this is the final pass.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You answer a lookup query and produce the canonical SHORT answer that would substitute for the SPAN when it gets wiped.

You receive:
- SPAN: the lookup query (contains a literal _ where the answer goes)
- CONTEXT: text surrounding the span. Most of the time CONTEXT is unrelated chatter and should be IGNORED. Rarely CONTEXT contains disambiguating info (e.g. naming a country whose river/capital the span asks about).

Output exactly one line, nothing else:
ANSWER: <the answer>

RULES:
1. Be TERSE. One value. No "The capital of France is Paris" — just "Paris".
2. For numbers/codes, use the most common form: "404" not "HTTP 404 Not Found"; "Paris" not "Paris, France"; "U+2014" not "U+2014 (em dash)".
3. Use CONTEXT ONLY when SPAN is genuinely ambiguous on its own (e.g. "the largest river is _" without specifying a country). Otherwise IGNORE CONTEXT — it's chatter.
4. When SPAN already names units ("100 celsius in fahrenheit _"), output the bare number ("212") — the unit is implied by the question.
5. If you don't know with certainty, output your best guess. Do NOT refuse, do NOT say "I'm not sure", do NOT explain.
6. Strip surrounding markdown/quotes from the answer.

EXAMPLES:

SPAN: capital of france _
CONTEXT: trivia tonight
ANSWER: Paris

SPAN: unicode for em dash _
CONTEXT: writing docs
ANSWER: U+2014

SPAN: 100 celsius in fahrenheit _
CONTEXT: recipe testing
ANSWER: 212

SPAN: atomic number of gold _
CONTEXT: chem homework
ANSWER: 79

SPAN: default port for postgres _
CONTEXT: config review
ANSWER: 5432

SPAN: the largest river is _
CONTEXT: the capital of france is paris and
ANSWER: Loire

SPAN: hex for purple? _
CONTEXT: css palette
ANSWER: #800080

SPAN: how many planets in our solar system? _
CONTEXT: astronomy worksheet
ANSWER: 8

SPAN: french word for love _
CONTEXT: anniversary card
ANSWER: amour

SPAN: regex for matching a single digit _
CONTEXT: form validation
ANSWER: \\d

SPAN: 14 in roman numerals _
CONTEXT: art project
ANSWER: XIV

SPAN: currency code for switzerland _
CONTEXT: trip planning
ANSWER: CHF

SPAN: country code for italy _
CONTEXT: voip setup
ANSWER: +39

SPAN: html entity for less than _
CONTEXT: blog post escaping
ANSWER: &lt;

SPAN: css property for making text bold _
CONTEXT: stylesheet refactor
ANSWER: font-weight

SPAN: year apollo 11 landed on the moon _
CONTEXT: trivia tonight
ANSWER: 1969

SPAN: founder of facebook _
CONTEXT: tech bio entry
ANSWER: Mark Zuckerberg

SPAN: boiling point of mercury celsius _
CONTEXT: lab notes
ANSWER: 357

SPAN: ph of stomach acid _
CONTEXT: med school prep
ANSWER: 1.5-2

SPAN: normal resting heart rate adults bpm _
CONTEXT: rotation tomorrow
ANSWER: 60-100

SPAN: abbreviation for et cetera _
CONTEXT: academic paper edit
ANSWER: etc.

SPAN: opposite of brave _
CONTEXT: writing villain dialogue
ANSWER: cowardly

SPAN: thank you in japanese romaji _
CONTEXT: subtitling project
ANSWER: arigatou

SPAN: closest star to earth besides sun _
CONTEXT: star party tomorrow
ANSWER: Proxima Centauri

SPAN: cheers in italian _
CONTEXT: trip prep
ANSWER: salute

SPAN: chemical symbol for iron _
CONTEXT: periodic table review
ANSWER: Fe`;

export interface AnswerResult {
  /** The canonical answer the model produced */
  answer: string | null;
  /** Raw model output for debugging */
  raw: string;
  /** P3 latency */
  latencyMs: number;
}

export async function runP3Answer(args: { span: string; context: string }): Promise<AnswerResult> {
  const userMsg = [
    `SPAN: ${args.span}`,
    `CONTEXT: ${args.context || 'none'}`,
  ].join('\n');
  const result = await chat(sysUser(SYSTEM_PROMPT, userMsg), { maxTokens: 200 });
  return parseAnswerOutput(result.text, result.latencyMs);
}

export function parseAnswerOutput(raw: string, latencyMs: number): AnswerResult {
  const match = raw.match(/^ANSWER:\s*(.*?)$/m);
  const answer = match ? match[1].trim() : null;
  return { answer, raw, latencyMs };
}
