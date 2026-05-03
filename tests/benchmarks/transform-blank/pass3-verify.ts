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

4. CONCEPT-SWAP PROPAGATION — when the instruction names a CATEGORY (pet, vehicle, profession, era, country, setting, sport, protagonist, etc. — e.g. "change pet from dog to cat"), the draft must update not just the named noun but ALL dependent vocabulary that goes with it: verbs, sounds, objects, properties.
   - "change pet from dog to cat" on "the dog wagged its tail and barked" — draft "the cat wagged its tail and barked" is BROKEN (cats don't wag or bark). Repair to "the cat swished its tail and meowed".
   - "change vehicle from bike to car" on "I rode my bike and my helmet kept me safe" — draft "I rode my car and my helmet kept me safe" is BROKEN (you drive cars, you wear seatbelts). Repair to "I drove my car and my seatbelt kept me safe".
   - LITERAL swap instructions (no category word — "change boy to girl", "rename foo to bar") do NOT trigger propagation. Only swap the literal tokens for those.

ALWAYS output the rewrite — never bail to NONE, never refuse. P1 already decided this is a valid transform; you cannot revisit that.

DEFAULT TO OK. Only output REPAIR when you can name a SPECIFIC, IDENTIFIABLE defect from the four checks above (a wrong agreement, a missed span, an incomplete restructure, an unpropagated category swap). If the draft looks fine — even if you could rephrase it more elegantly — output OK and pass it through. Stylistic improvement is NOT your job. You are a defect catcher, not a writer.

Examples of when to REPAIR:
- Draft says "they is going" → REPAIR (agreement broken)
- Draft kept "one mice" → REPAIR (quantifier doesn't match new noun)
- Draft only changed first occurrence of "boy" → REPAIR (incomplete coverage)
- Draft has "the cat barked" after a dog→cat swap → REPAIR (cats don't bark)

Examples of when to STAY OK:
- Draft is a valid rewrite that follows the instruction → OK (don't second-guess)
- Draft made a creative-but-correct word choice → OK (your taste is irrelevant)
- Draft preserved a verb that works for both old and new categories ("the wizard charged the dragon" after knight→wizard) → OK (the verb still fits)

CRITICAL — when a draft already exactly matches a clean, structurally-faithful rewrite, output OK and pass it through verbatim. Do NOT add prose, do NOT swap "charged" for "cast a spell at" just because wizards cast spells, do NOT replace "drew his wand" with "raised his wand". The draft is fine. Your job is to catch BROKEN edits, not to rewrite working ones.

WORKED EXAMPLES — when NOT to repair:

INSTRUCTION: change protagonist to wizard
TARGET: the knight drew his sword and charged the dragon
DRAFT: the wizard drew his wand and charged the dragon
VERDICT: OK
REWRITE: the wizard drew his wand and charged the dragon

(The draft is already a clean concept-swap: knight→wizard, sword→wand, "drew" stays because wizards can draw their wands, "charged" stays because wizards can charge things. Adding "and cast a spell at" would be WRONG — that's stylistic invention, not defect repair.)

INSTRUCTION: make it british english
TARGET: the color of the harbor reflected the gray sky as we walked along the sidewalk past the theater toward our favorite restaurant where we ordered fries with our meal
DRAFT: the colour of the harbour reflected the grey sky as we walked along the pavement past the theatre towards our favourite restaurant where we ordered chips with our meal
VERDICT: OK
REWRITE: the colour of the harbour reflected the grey sky as we walked along the pavement past the theatre towards our favourite restaurant where we ordered chips with our meal

(All seven AmE→BrE substitutions were made: color→colour, harbor→harbour, gray→grey, sidewalk→pavement, theater→theatre, favorite→favourite, fries→chips. Long input length is NOT a reason to repair — count the substitutions, not the words. If they're all there, OK.)

INSTRUCTION: recalculate the totals
TARGET: Item A: 3 widgets at $4 each = $12. Item B: 2 gadgets at $5 each = $10. Subtotal: $22. Tax (10%): $2.20. Total: $24.20.
DRAFT: Item A: 3 widgets at $4 each = $12. Item B: 2 gadgets at $5 each = $10. Subtotal: $22. Tax (10%): $2.20. Total: $24.20.
VERDICT: OK
REWRITE: Item A: 3 widgets at $4 each = $12. Item B: 2 gadgets at $5 each = $10. Subtotal: $22. Tax (10%): $2.20. Total: $24.20.

(The math is already correct: 3×4=12, 2×5=10, 12+10=22, 22×10%=2.20, 22+2.20=24.20. The instruction said "recalculate" but recalculating yields the same numbers. OK — pass through. Do NOT abbreviate "2 gadgets at $5 each" to "2 gadgets ... = $10" or use any other shortening — that's truncation, not repair.)

CRITICAL — your REWRITE must be the FULL output text. Never use ellipsis (…) to abbreviate, never use stray dashes/separators (— ‑ –) between fragments, never insert "END" markers. If you can't reproduce the full draft cleanly, output VERDICT: OK and an empty REWRITE — the runtime will fall back to the draft.

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
REWRITE: the colour of the harbour is grey

INSTRUCTION: change pet from dog to cat
TARGET: the dog wagged its tail and barked at the postman
DRAFT: the cat wagged its tail and barked at the postman
VERDICT: REPAIR
REWRITE: the cat swished its tail and meowed at the postman

INSTRUCTION: change vehicle from bike to car
TARGET: I rode my bike to school and my helmet kept me safe
DRAFT: I rode my car to school and my helmet kept me safe
VERDICT: REPAIR
REWRITE: I drove my car to school and my seatbelt kept me safe

INSTRUCTION: change profession from doctor to teacher
TARGET: the doctor prescribed medicine for the patient
DRAFT: the teacher prescribed medicine for the patient
VERDICT: REPAIR
REWRITE: the teacher assigned homework for the student`;

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
  // VERDICT is single-line (m flag); REWRITE may span multiple lines
  // — drop `m` so `$` is end-of-string.
  const verdictMatch = raw.match(/^VERDICT:\s*(OK|REPAIR)\s*$/im);
  const rewriteMatch = raw.match(/REWRITE:\s*([\s\S]*?)\s*$/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'OK') as 'OK' | 'REPAIR';
  const rewrite = rewriteMatch ? rewriteMatch[1].trim() : '';
  return { verdict, rewrite, raw, latencyMs };
}
