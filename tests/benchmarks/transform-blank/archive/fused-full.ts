/**
 * FUSED-FULL — same CoT scaffolding as fused-extract-apply (VERDICT +
 * INSTRUCTION + TARGET) but the rewrite field emits the WHOLE final
 * buffer instead of just the target's rewrite.
 *
 * Why: the production runtime currently trusts the LLM's TARGET span
 * to bound the splice ("REWRITE replaces TARGET, everything else is
 * preserved verbatim"). When the LLM emits a narrow TARGET but a wide
 * rewrite, the runtime concatenates `originalText[targetEnd:]` after
 * the rewrite — duplicating content the rewrite already covered.
 *
 * Fused-full inverts the contract: the LLM emits the whole final
 * buffer; the runtime recovers the splice region via diff against
 * `originalText`. TARGET stays as inline CoT scaffolding for the
 * reasoning model but becomes a debug-only field at runtime.
 *
 * Output format — four labelled lines (FULL_REWRITE may span many):
 *   VERDICT: TRANSFORM | NONE
 *   INSTRUCTION: <verb phrase>
 *   TARGET: <rest of text>
 *   FULL_REWRITE: <whole final buffer; empty when NONE>
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You read a sentence containing _ and decide whether it carries an IMPERATIVE INSTRUCTION the user wants applied to the surrounding text. If so, you both EXTRACT the instruction/target AND APPLY it in one shot — emitting the entire final buffer the user should see.

Imperative instruction shapes: "change X to Y", "replace X with Y", "swap X for Y", "rename X to Y", "make it past tense", "make it formal", "make it british english", "capitalize proper nouns", "pluralize", "he/she swap", "swap genders", "change CATEGORY from X to Y" (e.g. "change pet from dog to cat"), "make it half", "double the numbers", "add 10%", "convert to celsius", "fix the math", CONDITIONAL ("X but not Y", "X except Y", "X only when Z"), CONTEXT-REFERRING ("match the X of the first sentence").

Output exactly four labelled lines (FULL_REWRITE may span multiple lines):
VERDICT: TRANSFORM | NONE
INSTRUCTION: <imperative phrase, _ removed; or empty when NONE>
TARGET: <rest of text after removing the instruction phrase + _; or empty when NONE>
FULL_REWRITE: <the ENTIRE final text after applying the instruction AND deleting the instruction phrase + _; empty when NONE>

LAYOUT — the imperative may appear in THREE positions:
  (a) BEFORE _ at the start:   "<INSTRUCTION> _ <TARGET>"
  (b) BEFORE _ at the end:     "<TARGET> <INSTRUCTION> _"
  (c) SANDWICHED:              "<TARGET-PT1> <INSTRUCTION> _ <TARGET-PT2>"
      TARGET joins both halves with a single newline, original order.
      FULL_REWRITE preserves the original paragraph break(s) — the
      sandwich's blank LINE where the trigger sat survives as a blank
      line in the output.

COMPOSED INSTRUCTIONS — when the imperative joins TWO distinct transforms with "and" ("make past tense and remove pronouns", "pluralize and make past tense", "make it british english and past tense"), pipe-join the parts in INSTRUCTION (e.g. "make past tense | remove pronouns") AND apply BOTH transforms in FULL_REWRITE so the result is grammatical under both constraints simultaneously. Only split when the two halves independently make sense — do NOT split "change boy to girl" or "double the numbers".

NONE rules — bail when ANY of these apply:
- _ is a UI placeholder ("click _ to continue")
- pure lookup, no instruction ("capital of france _")
- instruction-shaped phrase but no target text ("I need to change boy to girl in this story _")
- idiom that LOOKS like an instruction but isn't ("change of plans _ we meet at 3pm")

APPLY RULES (when VERDICT=TRANSFORM):
1. Apply the instruction to ALL applicable spans.
2. Preserve everything not targeted (other words, punctuation, casing, paragraph breaks \\n\\n).
3. CONCEPT-SWAP PROPAGATION — when the instruction names a CATEGORY (pet, vehicle, profession, era, country, setting, sport, protagonist), propagate dependent vocabulary too (cats meow not bark; cars use seatbelts not helmets). MINIMAL EDIT: only swap words that become wrong in the new category — keep neutral verbs unchanged. PRESERVE STRUCTURE: keep possessives ("my", "his", "its") and sentence skeleton. COMPLETE THE ACTION: "dunked the ball" (basketball) → "kicked the ball into the goal" (soccer).
4. Environment-bound verbs MUST flip when the setting changes (water doesn't burn — it cools/soothes/refreshes).
5. LITERAL vs CATEGORY: "change boy to girl" is LITERAL (only swap those two tokens). "change pet from dog to cat" is CATEGORY (propagate vocabulary).
6. ROLE PRESERVATION — "add 10%" to "original price 100, final price 100" only changes FINAL → 110.
7. CONDITIONAL — apply the transform ONLY where the condition holds ("change boy to girl but not in the second sentence" leaves sentence 2 untouched).
8. PRESERVE PARAGRAPHS — \\n\\n breaks must survive verbatim; do not collapse paragraphs.
9. FULL_REWRITE contains ONLY what the user should see after the transform — instruction phrase + _ deleted, all surrounding context preserved verbatim or transformed per the instruction.

EXAMPLES:

INPUT: change boy to girl _ the boy ran fast
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl
TARGET: the boy ran fast
FULL_REWRITE: the girl ran fast

INPUT: he/she swap _ he gave the book to John
VERDICT: TRANSFORM
INSTRUCTION: he/she swap
TARGET: he gave the book to John
FULL_REWRITE: she gave the book to John

INPUT: make it british english _ the color of the harbor is gray
VERDICT: TRANSFORM
INSTRUCTION: make it british english
TARGET: the color of the harbor is gray
FULL_REWRITE: the colour of the harbour is grey

INPUT: pluralize _ the child found one mouse
VERDICT: TRANSFORM
INSTRUCTION: pluralize
TARGET: the child found one mouse
FULL_REWRITE: the children found mice

INPUT: change pet from dog to cat _ the dog wagged its tail and barked at the postman
VERDICT: TRANSFORM
INSTRUCTION: change pet from dog to cat
TARGET: the dog wagged its tail and barked at the postman
FULL_REWRITE: the cat swished its tail and meowed at the postman

INPUT: the boy ran fast change boy to girl _
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl
TARGET: the boy ran fast
FULL_REWRITE: the girl ran fast

INPUT: i bought apple and samsung phones online uppercase the brands _
VERDICT: TRANSFORM
INSTRUCTION: uppercase the brands
TARGET: i bought apple and samsung phones online
FULL_REWRITE: i bought APPLE and SAMSUNG phones online

INPUT: make past tense and remove pronouns _ I run to the store and I buy milk
VERDICT: TRANSFORM
INSTRUCTION: make past tense | remove pronouns
TARGET: I run to the store and I buy milk
FULL_REWRITE: ran to the store and bought milk

INPUT: pluralize and make past tense _ the child runs to the park and finds one mouse
VERDICT: TRANSFORM
INSTRUCTION: pluralize | make past tense
TARGET: the child runs to the park and finds one mouse
FULL_REWRITE: the children ran to the parks and found mice

INPUT: change boy to girl but not in the second sentence _ The boy ran. The boy met another. They played.
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl but not in the second sentence
TARGET: The boy ran. The boy met another. They played.
FULL_REWRITE: The girl ran. The boy met another. They played.

INPUT: capital of france _
VERDICT: NONE
INSTRUCTION:
TARGET:
FULL_REWRITE:

INPUT: click _ to continue
VERDICT: NONE
INSTRUCTION:
TARGET:
FULL_REWRITE:

INPUT: change of plans _ we meet at 3pm
VERDICT: NONE
INSTRUCTION:
TARGET:
FULL_REWRITE:`;

export interface FusedFullResult {
  verdict: 'TRANSFORM' | 'NONE';
  instruction: string;
  target: string;
  fullRewrite: string;
  raw: string;
  latencyMs: number;
}

/** Same dynamic budget as fused but multiplier 3.0 — output is the
 *  WHOLE final buffer plus INSTRUCTION + TARGET CoT, so we need more
 *  headroom than fused's target-only REWRITE. May 23 2026: FLOOR
 *  2048 → 4096 + CEILING 4096 → 16384 to match the production raise
 *  after the translate-to-japanese truncation bug. Latency + cost
 *  measured FLAT across 2048-8192 (see `budget-translate-probe.ts`);
 *  the extra headroom only matters when the model verbatim-echoes
 *  TARGET + emits dense-script output (Japanese/Chinese/Korean/
 *  Arabic) under reasoning_effort='medium'. */
function budgetForFullOutput(inputChars: number, multiplier: number = 3.0): number {
  const REASONING_HEADROOM = 700;
  const FLOOR = 4096;
  const CEILING = 16384;
  const est = Math.ceil((inputChars * multiplier) / 3) + REASONING_HEADROOM;
  return Math.max(FLOOR, Math.min(CEILING, est));
}

export async function runFusedFull(input: string): Promise<FusedFullResult> {
  const maxTokens = budgetForFullOutput(input.length);
  const r = await chat(sysUser(SYSTEM_PROMPT, `INPUT: ${input}`), { maxTokens });
  return parseFusedFullOutput(r.text, r.latencyMs);
}

export function parseFusedFullOutput(raw: string, latencyMs: number): FusedFullResult {
  const verdictMatch = raw.match(/^VERDICT:[ \t]*(TRANSFORM|NONE)[ \t]*$/im);
  const instructionMatch = raw.match(/^INSTRUCTION:[ \t]*(.*?)[ \t]*$/im);
  const targetMatch = raw.match(/TARGET:[ \t]*([\s\S]*?)(?=^FULL_REWRITE:|\s*$)/im);
  const fullRewriteMatch = raw.match(/FULL_REWRITE:[ \t]*([\s\S]*?)\s*$/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'NONE') as 'TRANSFORM' | 'NONE';
  const instruction = instructionMatch ? instructionMatch[1].trim() : '';
  const target = targetMatch ? targetMatch[1].trim() : '';
  const fullRewrite = fullRewriteMatch ? fullRewriteMatch[1].trim() : '';
  return { verdict, instruction, target, fullRewrite, raw, latencyMs };
}
