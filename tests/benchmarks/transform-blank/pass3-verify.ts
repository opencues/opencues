/**
 * 3-PASS pipeline — PASS 3: VERIFY
 *
 * Given (instruction, target, draft_rewrite), check whether the draft
 * actually carries out the instruction *consistently*. Either:
 *   - VERDICT: OK     — draft is good, pass it through unchanged
 *   - VERDICT: REPAIR — draft has issues, emit a corrected rewrite
 *
 * Three internal-consistency checks the prompt nudges the model toward:
 *   1. AGREEMENT — number/tense/case agreement in dependent words
 *      (e.g. "they is" → "they are"; "one mice" → "mice")
 *   2. COVERAGE — every applicable span got hit, not just the first
 *      (e.g. "boy → girl" applied to ALL boys, not one)
 *   3. STRUCTURAL COMPLETENESS — instructions like "make it a question"
 *      actually restructure the sentence, not just append punctuation
 *
 * Authority is narrow: P3 NEVER bails back to NONE. P1 already decided
 * whether to fire — P3 only repairs the rewrite when needed.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You are reviewing a text-edit produced by another model. Your job: decide whether the draft rewrite correctly applies the instruction to the target — and if not, emit a fixed version.

You receive:
- INSTRUCTION: a short imperative editing command
- TARGET: the original text the instruction should be applied to
- DRAFT: the draft rewrite produced by another model

Output exactly two lines, nothing else:
VERDICT: OK | REPAIR
REWRITE: <DRAFT verbatim when OK; the corrected rewrite when REPAIR>

Check the DRAFT against THREE consistency rules:

1. AGREEMENT — when the edit changes a noun/pronoun's number, tense, or case, do dependent words follow?
   - "he → they" requires "is → are", "his → their", "him → them"
   - "one mouse → mice" requires dropping "one" (you can't have "one mice")
   - past-tense edits should affect ALL verbs, not just one

2. COVERAGE — was the edit applied to ALL applicable spans, not just the first?
   - "change boy to girl" applied to "the boy and the boy" must produce "the girl and the girl", never "the girl and the boy"

3. STRUCTURAL COMPLETENESS — instructions that imply restructuring must restructure
   - "make it a question" on "the meeting starts at 3pm" must produce "Does the meeting start at 3pm?" or "When does the meeting start?", NOT "the meeting starts at 3pm?"
   - "make it passive" must reorder subject/object, not just swap verbs
   - "make it formal" / "make it casual" must change vocabulary AND register, not only one word

ALWAYS output the rewrite — never bail to NONE, never refuse. If you have doubts, lean toward REPAIR with your best correction. P1 already decided this is a valid transform; you cannot revisit that.

EXAMPLES:

INSTRUCTION: change boy to girl
TARGET: the boy ran fast
DRAFT: the girl ran fast
VERDICT: OK
REWRITE: the girl ran fast

INSTRUCTION: change boy to girl
TARGET: the boy and the other boy were friends
DRAFT: the girl and the other boy were friends
VERDICT: REPAIR
REWRITE: the girl and the other girl were friends

INSTRUCTION: pluralize
TARGET: the child found one mouse
DRAFT: the children found one mice
VERDICT: REPAIR
REWRITE: the children found mice

INSTRUCTION: singular to plural pronouns
TARGET: he is going to his house
DRAFT: they is going to their house
VERDICT: REPAIR
REWRITE: they are going to their house

INSTRUCTION: make it a question
TARGET: the meeting starts at 3pm
DRAFT: the meeting starts at 3pm?
VERDICT: REPAIR
REWRITE: Does the meeting start at 3pm?

INSTRUCTION: make past tense
TARGET: I run to the store every day
DRAFT: I ran to the store every day
VERDICT: OK
REWRITE: I ran to the store every day

INSTRUCTION: make it british english
TARGET: the color of the harbor is gray
DRAFT: the colour of the harbour is grey
VERDICT: OK
REWRITE: the colour of the harbour is grey`;

export interface VerifyResult {
  verdict: 'OK' | 'REPAIR';
  rewrite: string;
  raw: string;
  latencyMs: number;
}

export async function runVerify(instruction: string, target: string, draft: string): Promise<VerifyResult> {
  const r = await chat(
    sysUser(SYSTEM_PROMPT, `INSTRUCTION: ${instruction}\nTARGET: ${target}\nDRAFT: ${draft}`),
    { maxTokens: 2048 },
  );
  return parseVerifyOutput(r.text, r.latencyMs);
}

export function parseVerifyOutput(raw: string, latencyMs: number): VerifyResult {
  const verdictMatch = raw.match(/^VERDICT:\s*(OK|REPAIR)\s*$/im);
  const rewriteMatch = raw.match(/^REWRITE:\s*(.*?)\s*$/im);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'OK') as 'OK' | 'REPAIR';
  const rewrite = rewriteMatch ? rewriteMatch[1].trim() : '';
  return { verdict, rewrite, raw, latencyMs };
}
