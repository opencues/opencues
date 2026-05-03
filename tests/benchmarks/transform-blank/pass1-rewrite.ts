/**
 * 1-PASS REWRITE
 *
 * Single LLM call: read the input, find the imperative instruction next to
 * `_`, apply it to the surrounding text, and emit the full rewritten text
 * (with the instruction phrase + `_` itself wiped).
 *
 * Output format — two lines:
 *   VERDICT: TRANSFORM | NONE
 *   REWRITE: <full rewritten text, or empty when VERDICT=NONE>
 *
 * VERDICT=NONE means "no imperative instruction next to _" — the source
 * should bail and let other blank handlers (fluid-blank, BlankSource) take
 * the slot.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You are an editor. The user typed a sentence containing an underscore (_). Next to the _ is sometimes a SHORT IMPERATIVE INSTRUCTION describing how to edit the rest of the text. Your job: apply the instruction to the rest of the text, and emit the rewritten text WITH the instruction phrase AND the _ removed.

Examples of imperative instructions: "change X to Y", "replace X with Y", "swap X for Y", "rename X to Y", "make it past tense", "make it formal", "make it british english", "capitalize proper nouns", "pluralize", "he/she swap", "swap genders".

Output exactly two lines, nothing else:
VERDICT: TRANSFORM | NONE
REWRITE: <the full rewritten text with instruction + _ removed>

When VERDICT is NONE, leave REWRITE blank.

VERDICT=NONE rules — bail to NONE when ANY of these apply:
- The _ is a UI placeholder, not an instruction marker ("click _ to continue").
- There's no imperative phrase next to _ — just a question or a lookup ("capital of france _").
- An instruction-shaped phrase appears but there's no target text to operate on ("I need to change boy to girl in this story _").
- The "instruction" is actually idiom and not a real edit command ("change of plans _ we meet at 3pm").

When VERDICT=TRANSFORM, the REWRITE should:
- Apply the instruction to ALL applicable spans in the rest of the text (not just the first).
- Preserve everything that wasn't targeted by the instruction (other words, punctuation, casing).
- DELETE the instruction phrase and the _ from the output. The rewritten text contains ONLY what should remain.
- For ambiguous co-reference (e.g. "swap genders" with possessive pronouns), pick one consistent interpretation rather than refusing.

EXAMPLES:

INPUT: change boy to girl _ the boy ran fast
VERDICT: TRANSFORM
REWRITE: the girl ran fast

INPUT: replace cat with dog _ I have a cat named whiskers
VERDICT: TRANSFORM
REWRITE: I have a dog named whiskers

INPUT: change boy to girl _ the boy and the other boy were friends
VERDICT: TRANSFORM
REWRITE: the girl and the other girl were friends

INPUT: he/she swap _ he gave the book to John
VERDICT: TRANSFORM
REWRITE: she gave the book to John

INPUT: make it british english _ the color of the harbor is gray
VERDICT: TRANSFORM
REWRITE: the colour of the harbour is grey

INPUT: make past tense _ I run to the store every day
VERDICT: TRANSFORM
REWRITE: I ran to the store every day

INPUT: capitalize proper nouns _ i visited paris and london last june
VERDICT: TRANSFORM
REWRITE: I visited Paris and London last June

INPUT: pluralize _ the child found one mouse
VERDICT: TRANSFORM
REWRITE: the children found mice

INPUT: rename foo to bar _ function foo() { return foo + 1 }
VERDICT: TRANSFORM
REWRITE: function bar() { return bar + 1 }

INPUT: capital of france _
VERDICT: NONE
REWRITE:

INPUT: click _ to continue and then submit the form
VERDICT: NONE
REWRITE:

INPUT: change of plans _ we meet at 3pm
VERDICT: NONE
REWRITE:

INPUT: I need to change boy to girl in this story _
VERDICT: NONE
REWRITE:`;

export interface RewriteResult {
  verdict: 'TRANSFORM' | 'NONE';
  rewrite: string;
  raw: string;
  latencyMs: number;
}

export async function runRewrite(input: string): Promise<RewriteResult> {
  const r = await chat(sysUser(SYSTEM_PROMPT, `INPUT: ${input}`), { maxTokens: 2048 });
  return parseRewriteOutput(r.text, r.latencyMs);
}

export function parseRewriteOutput(raw: string, latencyMs: number): RewriteResult {
  // VERDICT is single-line (m flag); REWRITE may span multiple lines
  // — drop `m` so `$` is end-of-string, not end-of-line.
  const verdictMatch = raw.match(/^VERDICT:\s*(TRANSFORM|NONE)\s*$/im);
  const rewriteMatch = raw.match(/REWRITE:\s*([\s\S]*?)\s*$/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'NONE') as 'TRANSFORM' | 'NONE';
  const rewrite = rewriteMatch ? rewriteMatch[1].trim() : '';
  return { verdict, rewrite, raw, latencyMs };
}
