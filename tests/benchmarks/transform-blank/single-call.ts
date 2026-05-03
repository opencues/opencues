/**
 * SINGLE-CALL pipeline — combines extract+apply+verify into one prompt.
 *
 * Theory: 3 LLM calls average ~1s end-to-end. One call should be ~350ms.
 * Tradeoff: the model has to juggle "is this a transform?" + "apply
 * the transform" + "check consistency" all at once, which is what the
 * 3-pass design specifically broke apart to avoid.
 *
 * Output format — two lines:
 *   VERDICT: TRANSFORM | NONE
 *   REWRITE: <full rewritten text, or empty when VERDICT=NONE>
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You read a sentence containing _ and rewrite the surrounding text per any imperative instruction next to the _. Output the FINAL rewritten text in one shot.

The instruction may sit BEFORE _ (the start of the input) OR right BEFORE _ at the end (the user typed text first then added the instruction). Examples of imperative instructions: "change X to Y", "replace X with Y", "make past tense", "make it british english", "capitalize proper nouns", "pluralize", "uppercase the brands", "make all text lower case", "full caps all words".

Output exactly two lines, nothing else:
VERDICT: TRANSFORM | NONE
REWRITE: <the FULL rewritten text with instruction phrase + _ removed; empty when NONE>

VERDICT=NONE rules — bail when ANY of these apply:
- _ is a UI placeholder ("click _ to continue")
- pure lookup, no instruction ("capital of france _")
- instruction-shaped phrase but no target text
- idiom not actually an instruction ("change of plans _ we meet at 3pm")

When VERDICT=TRANSFORM:
- Apply the instruction to ALL applicable spans, not just the first
- Preserve everything else verbatim (other words, punctuation, paragraph breaks \\n\\n)
- For category swaps (pet, vehicle, profession, etc.) propagate dependent vocabulary (cats meow not bark; cars use seatbelts not helmets)
- For composed instructions ("X and Y") apply both
- For conditional ("X but not Y") apply only where the condition holds
- DELETE the instruction phrase + _ from the output

EXAMPLES:

INPUT: change boy to girl _ the boy ran fast
VERDICT: TRANSFORM
REWRITE: the girl ran fast

INPUT: change boy to girl _ the boy and the other boy were friends
VERDICT: TRANSFORM
REWRITE: the girl and the other girl were friends

INPUT: he/she swap _ he gave the book to John
VERDICT: TRANSFORM
REWRITE: she gave the book to John

INPUT: make it british english _ the color of the harbor is gray
VERDICT: TRANSFORM
REWRITE: the colour of the harbour is grey

INPUT: pluralize _ the child found one mouse
VERDICT: TRANSFORM
REWRITE: the children found mice

INPUT: change pet from dog to cat _ the dog wagged its tail and barked at the postman
VERDICT: TRANSFORM
REWRITE: the cat swished its tail and meowed at the postman

INPUT: the boy ran fast change boy to girl _
VERDICT: TRANSFORM
REWRITE: the girl ran fast

INPUT: The boy ran across the road. full caps all words _
VERDICT: TRANSFORM
REWRITE: THE BOY RAN ACROSS THE ROAD.

INPUT: i bought apple and samsung phones online uppercase the brands _
VERDICT: TRANSFORM
REWRITE: i bought APPLE and SAMSUNG phones online

INPUT: capital of france _
VERDICT: NONE
REWRITE:

INPUT: click _ to continue
VERDICT: NONE
REWRITE:`;

export interface SingleCallResult {
  verdict: 'TRANSFORM' | 'NONE';
  rewrite: string;
  raw: string;
  latencyMs: number;
}

export async function runSingleCall(input: string): Promise<SingleCallResult> {
  const r = await chat(sysUser(SYSTEM_PROMPT, `INPUT: ${input}`), { maxTokens: 2048 });
  return parseSingleCallOutput(r.text, r.latencyMs);
}

export function parseSingleCallOutput(raw: string, latencyMs: number): SingleCallResult {
  const verdictMatch = raw.match(/^VERDICT:\s*(TRANSFORM|NONE)\s*$/im);
  const rewriteMatch = raw.match(/REWRITE:\s*([\s\S]*?)\s*$/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'NONE') as 'TRANSFORM' | 'NONE';
  const rewrite = rewriteMatch ? rewriteMatch[1].trim() : '';
  return { verdict, rewrite, raw, latencyMs };
}
