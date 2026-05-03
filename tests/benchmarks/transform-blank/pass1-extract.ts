/**
 * 2-PASS pipeline — PASS 1: EXTRACT
 *
 * Identifies the imperative instruction next to `_` and splits the input
 * into:
 *   - INSTRUCTION: the verb-phrase the user wants applied (without _).
 *     Composed instructions ("X and Y") become a pipe-separated list:
 *     "make past tense | remove pronouns" — APPLY runs each in sequence.
 *   - TARGET: the rest of the text the instruction should operate on
 *
 * Returns VERDICT: NONE when no instruction shape is present (lookup,
 * placeholder, idiom, or instruction with no target).
 *
 * Output format — three lines:
 *   VERDICT: TRANSFORM | NONE
 *   INSTRUCTION: <verb phrase, optionally pipe-joined for composed ops>
 *   TARGET: <rest of text>
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You read a sentence containing _ and identify whether it carries an IMPERATIVE INSTRUCTION the user wants applied to the surrounding text.

Imperative instruction shapes: "change X to Y", "replace X with Y", "swap X for Y", "rename X to Y", "make it past tense", "make it formal", "make it british english", "capitalize proper nouns", "pluralize", "he/she swap", "swap genders", "change CATEGORY from X to Y" (e.g. "change pet from dog to cat", "change vehicle from bike to car"), "make it half", "double the numbers", "add 10%", "convert to celsius", "fix the math", "recalculate", CONDITIONAL shapes ("change X to Y BUT not in Z", "X EXCEPT Y", "X ONLY when Z"), CONTEXT-REFERRING shapes ("match the X of the first sentence", "use the same X as the introduction", "apply the case style of the first word", "use the same vocabulary level as Y").

Output exactly three lines, nothing else:
VERDICT: TRANSFORM | NONE
INSTRUCTION: <the imperative phrase, _ removed; or empty when NONE>
TARGET: <the rest of the input text after removing the instruction phrase + _; or empty when NONE>

LAYOUT — the imperative may appear in TWO positions:
  (a) BEFORE _ at the start: "<INSTRUCTION> _ <TARGET>"
      e.g. "change boy to girl _ the boy ran fast"
  (b) BEFORE _ at the end:   "<TARGET> <INSTRUCTION> _"
      e.g. "the boy ran fast change boy to girl _"

In layout (b), TARGET is everything BEFORE the instruction phrase, NOT after the underscore. There is nothing after the underscore in this layout. Detect by looking at where the imperative verb sits relative to the rest of the text: if the verb is in the LAST few words right before the underscore, it's layout (b) and TARGET is the leading text.

COMPOSED INSTRUCTIONS — when the imperative phrase joins TWO transforms with "and" ("make past tense and remove pronouns", "pluralize and make past tense", "make it british english and past tense"), output the two transforms pipe-joined in INSTRUCTION:

INSTRUCTION: make past tense | remove pronouns

The downstream APPLY pass will run each transform in sequence. This is more reliable than asking one APPLY call to juggle both at once. ONLY split when the instruction is genuinely two distinct edits joined by "and" — do NOT split things like "change boy to girl" (one edit), "make it formal and clear" (one register edit), or "double the numbers" (one edit). The test: would the two halves each independently make sense as standalone instructions? If yes, split. If no, keep as one.

NONE rules — bail when ANY of these apply:
- _ is a UI placeholder ("click _ to continue")
- pure lookup, no instruction ("capital of france _")
- instruction-shaped phrase but no target text ("I need to change boy to girl in this story _")
- idiom that LOOKS like an instruction but isn't ("change of plans _ we meet at 3pm")

EXAMPLES:

INPUT: change boy to girl _ the boy ran fast
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl
TARGET: the boy ran fast

INPUT: the boy ran fast change boy to girl _
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl
TARGET: the boy ran fast

INPUT: The boy ran across the road with his big dog. He loved them lots. make all text lower case _
VERDICT: TRANSFORM
INSTRUCTION: make all text lower case
TARGET: The boy ran across the road with his big dog. He loved them lots.

INPUT: The boy ran across the road with his big dog. He loved them lots. full caps all words _
VERDICT: TRANSFORM
INSTRUCTION: full caps all words
TARGET: The boy ran across the road with his big dog. He loved them lots.

INPUT: i bought apple and samsung phones online uppercase the brands _
VERDICT: TRANSFORM
INSTRUCTION: uppercase the brands
TARGET: i bought apple and samsung phones online

INPUT: he/she swap _ he gave the book to John
VERDICT: TRANSFORM
INSTRUCTION: he/she swap
TARGET: he gave the book to John

INPUT: make it british english _ the color of the harbor is gray
VERDICT: TRANSFORM
INSTRUCTION: make it british english
TARGET: the color of the harbor is gray

INPUT: pluralize _ the child found one mouse
VERDICT: TRANSFORM
INSTRUCTION: pluralize
TARGET: the child found one mouse

INPUT: make past tense and remove pronouns _ I run to the store and I buy milk
VERDICT: TRANSFORM
INSTRUCTION: make past tense | remove pronouns
TARGET: I run to the store and I buy milk

INPUT: pluralize and make past tense _ the child runs to the park and finds one mouse
VERDICT: TRANSFORM
INSTRUCTION: pluralize | make past tense
TARGET: the child runs to the park and finds one mouse

INPUT: change boy to girl but not in the second sentence _ The boy ran. The boy met another. They played.
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl but not in the second sentence
TARGET: The boy ran. The boy met another. They played.

INPUT: pluralize except mass nouns _ the child drank water and ate one cookie
VERDICT: TRANSFORM
INSTRUCTION: pluralize except mass nouns
TARGET: the child drank water and ate one cookie

INPUT: match the tense of the first sentence in the rest _ I walked to the store. Then I buy milk.
VERDICT: TRANSFORM
INSTRUCTION: match the tense of the first sentence in the rest
TARGET: I walked to the store. Then I buy milk.

INPUT: use the same vocabulary level as the introduction _ The cat sat. He utilized the supplementary vestibule for ingress.
VERDICT: TRANSFORM
INSTRUCTION: use the same vocabulary level as the introduction
TARGET: The cat sat. He utilized the supplementary vestibule for ingress.

INPUT: capital of france _
VERDICT: NONE
INSTRUCTION:
TARGET:

INPUT: click _ to continue and then submit the form
VERDICT: NONE
INSTRUCTION:
TARGET:

INPUT: change of plans _ we meet at 3pm
VERDICT: NONE
INSTRUCTION:
TARGET:

INPUT: I need to change boy to girl in this story _
VERDICT: NONE
INSTRUCTION:
TARGET:`;

export interface ExtractResult {
  verdict: 'TRANSFORM' | 'NONE';
  instruction: string;
  target: string;
  raw: string;
  latencyMs: number;
}

export async function runExtract(input: string): Promise<ExtractResult> {
  const r = await chat(sysUser(SYSTEM_PROMPT, `INPUT: ${input}`), { maxTokens: 2048 });
  return parseExtractOutput(r.text, r.latencyMs);
}

export function parseExtractOutput(raw: string, latencyMs: number): ExtractResult {
  // Single-line fields use [ \t]* (NOT \s*) for trailing whitespace —
  // \s* matches \n which makes the lazy .*? extend across line breaks
  // and accidentally swallow the next field label. Production bug:
  // model emitted "INSTRUCTION:\nTARGET:\n" (empty fields) and the
  // regex captured "TARGET:" as the instruction value.
  const verdictMatch = raw.match(/^VERDICT:[ \t]*(TRANSFORM|NONE)[ \t]*$/im);
  const instructionMatch = raw.match(/^INSTRUCTION:[ \t]*(.*?)[ \t]*$/im);
  const targetMatch = raw.match(/TARGET:[ \t]*([\s\S]*?)\s*$/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'NONE') as 'TRANSFORM' | 'NONE';
  const instruction = instructionMatch ? instructionMatch[1].trim() : '';
  const target = targetMatch ? targetMatch[1].trim() : '';
  return { verdict, instruction, target, raw, latencyMs };
}
