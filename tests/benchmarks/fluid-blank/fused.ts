/**
 * FUSED fluid-blank pipeline — single LLM call that both SEGMENTS the
 * lookup span AND ANSWERS it. Replaces the 2-pass (P1 SEGMENT → P3
 * ANSWER) with one prompt that emits both fields.
 *
 * Mirrors the transform-blank/fused-extract-apply.ts shape — capable
 * models can hold the "find the lookup phrase + answer it" task in
 * one breath, eliminating the inter-pass latency.
 *
 * Output format:
 *   SPAN: <substring containing _, or "NONE">
 *   ANSWER: <answer string, or empty when SPAN=NONE>
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You read a sentence containing _ and produce a structured lookup result.

The user is typing a casual note/sentence and has dropped an underscore (_) next to a TERSE LOOKUP PHRASE — something they want looked up, like a search query. Examples: "unicode for ampersand", "ascii code for tab", "100 celsius in fahrenheit", "capital of france", "atomic number of oxygen", "year apollo 11 landed on moon".

Output exactly two lines, nothing else:
SPAN: <the contiguous substring of the input including _, OR the literal word NONE>
ANSWER: <the value that should replace the SPAN; empty when SPAN=NONE>

SPAN RULES:
1. SPAN is an exact contiguous substring of the input, including the underscore.
2. SPAN is typically the lookup phrase together with the _ (2–10 words). Trim leading/trailing filler ("ok so", "hmm", "i need", "thx", "for my parser").
3. The lookup phrase may sit BEFORE _ ("unicode for ampersand _"), AFTER _ ("_ unicode for ampersand"), or with _ inline ("the cube root of 27 is _"). All three are valid.
4. The lookup phrase may be a NON-SEQUITUR dropped into unrelated chatter — find it by SHAPE, not by sentence flow.
5. PERIOD-SPLIT: when the input has multiple sentences, the SPAN is in the one containing _; other sentences are filler (go to ANSWER's context, not the SPAN).
6. WH-ANCHOR: when the lookup phrase begins with a wh-word ("what is", "how many", "who is", "where", "when did"), SPAN starts AT the wh-word.
7. COMPACT FACTUAL: short single-sentence factual claims with _ ("Water boils at _ degrees Celsius") — the whole sentence is the SPAN.
8. SPAN=NONE only when the _ is a typing/UI placeholder with no lookup query ("click _ to continue", "fix _ here").

ANSWER RULES:
1. Output the literal value that should replace the SPAN. Just the value — no full sentence, no explanation, no "The answer is", no markdown.
2. Numbers: bare integers / decimals ("212", "3.14159"), no units unless the lookup explicitly asks for them.
3. Codes / symbols: just the code ("U+0026", "9", "ff0000", "404").
4. Short factual lookups: just the noun phrase ("Paris", "Jane Austen", "1969").
5. When _ is mid-span and the surrounding text already supplies the answer's slot ("Water boils at _ degrees Celsius" → the SPAN is the whole clause; ANSWER is the FULL replacement clause "Water boils at 100 degrees Celsius").
6. When the input is "X is _" or "_ is the X" form, just output the value, not a restated sentence.
7. ANSWER is empty when SPAN=NONE.

EXAMPLES:

INPUT: unicode for ampersand _ where do i put it
SPAN: unicode for ampersand _
ANSWER: U+0026

INPUT: ascii code for tab _ for my parser
SPAN: ascii code for tab _
ANSWER: 9

INPUT: convert 100 celsius to fahrenheit _ wonder if it's hot
SPAN: 100 celsius to fahrenheit _
ANSWER: 212

INPUT: the cube root of 27 is _ that's all i need
SPAN: the cube root of 27 is _
ANSWER: 3

INPUT: hmm _ unicode for ampersand
SPAN: _ unicode for ampersand
ANSWER: U+0026

INPUT: writing some css. _ hex for blue. neat.
SPAN: _ hex for blue
ANSWER: 0000ff

INPUT: lemme check this. _ http status for not found. ok cool.
SPAN: _ http status for not found
ANSWER: 404

INPUT: art project. 8 in roman numerals _ for the title page.
SPAN: 8 in roman numerals _
ANSWER: VIII

INPUT: talking about pizza last night unicode for ampersand _ anyway back to pizza
SPAN: unicode for ampersand _
ANSWER: U+0026

INPUT: travel planning chat I wonder what is the mime type for avi _
SPAN: what is the mime type for avi _
ANSWER: video/x-msvideo

INPUT: team chat about the upcoming demo let me know who is the inventor of the laser printer _
SPAN: who is the inventor of the laser printer _
ANSWER: Gary Starkweather

INPUT: Water boils at _ degrees Celsius
SPAN: Water boils at _ degrees Celsius
ANSWER: Water boils at 100 degrees Celsius

INPUT: There are _ continents
SPAN: There are _ continents
ANSWER: There are 7 continents

INPUT: Pi equals approximately _
SPAN: Pi equals approximately _
ANSWER: 3.14159

INPUT: capital of france _
SPAN: capital of france _
ANSWER: Paris

INPUT: click _ to continue and then submit the form
SPAN: NONE
ANSWER:`;

export interface FusedResult {
  span: string | null;
  answer: string | null;
  raw: string;
  latencyMs: number;
}

export async function runFused(input: string): Promise<FusedResult> {
  const r = await chat(sysUser(SYSTEM_PROMPT, `INPUT: ${input}`), { maxTokens: 512 });
  return parseFusedOutput(r.text, r.latencyMs);
}

export function parseFusedOutput(raw: string, latencyMs: number): FusedResult {
  const spanMatch = raw.match(/^SPAN:\s*(.*?)$/m);
  // ANSWER may technically span multiple lines but mostly stays one;
  // be permissive — capture to end-of-output.
  const answerMatch = raw.match(/^ANSWER:\s*([\s\S]*?)\s*$/m);
  const spanRaw = spanMatch ? spanMatch[1].trim() : '';
  const ansRaw = answerMatch ? answerMatch[1].trim() : '';
  const span = (!spanRaw || spanRaw.toUpperCase() === 'NONE') ? null : spanRaw;
  const answer = span === null ? null : (ansRaw || null);
  return { span, answer, raw, latencyMs };
}
