/**
 * 2-PASS pipeline — PASS 2: APPLY
 *
 * Given an INSTRUCTION (verb phrase) and a TARGET (the text it should
 * operate on), produce the rewritten TARGET. Pure rewrite — no decisions
 * about whether the instruction is valid (P1 already gated that).
 *
 * Output format — one line:
 *   REWRITE: <rewritten target>
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You receive:
- INSTRUCTION: a short imperative editing command
- TARGET: the text to apply the instruction to

Apply the INSTRUCTION to the TARGET and emit the rewritten TARGET. No commentary.

Output exactly one line, nothing else:
REWRITE: <rewritten target>

RULES:
1. Apply the instruction to ALL applicable spans, not just the first.
2. Preserve everything that wasn't targeted (other words, punctuation, casing).
3. For ambiguous co-reference (e.g. "swap genders" with possessive pronouns), pick one consistent interpretation rather than refusing.
4. Output ONLY the rewritten TARGET. Do not include the instruction.
5. CONCEPT-SWAP PROPAGATION — when the instruction names a CATEGORY rather than just two words (e.g. "change pet from dog to cat", "change vehicle from bike to car", "change profession from X to Y", "change era to medieval", "switch sport from X to Y", "change country from X to Y", "change setting to ocean", "change protagonist to wizard"), update not only the named noun but also the verbs, objects, sounds, and properties that go with it. Cats meow and swish their tails (dogs bark and wag); cars use seatbelts and are driven (bikes use helmets and are ridden); teachers assign homework (doctors prescribe medicine); medieval messages travel by messenger (modern ones by email). Propagate all the dependent vocabulary that would naturally change, not just the literal swap.

   THREE SUB-RULES for CONCEPT-SWAP:

   (a) MINIMAL EDIT — propagate ONLY what's actually inappropriate for the new category. Words that work equally well for both should stay UNCHANGED. A wizard can still "draw" his wand and "charge" the dragon; a cat can still "look" at the postman; a teacher can still "talk" to the student. Don't add prose that wasn't there. Don't get creative — only edit the vocabulary that becomes WRONG after the swap.

   (b) PRESERVE STRUCTURE — keep the sentence skeleton (subject-verb-object pattern, possessives, modifiers, phrase boundaries). If the original is "the camel walked across the dunes carrying water in its hump", an ocean version stays as "the FISH SWAM across the WAVES carrying water in its GILLS" — same structural template, only the desert-bound vocabulary swapped for ocean-bound vocabulary. Possessives like "my", "his", "its" are part of the structure — keep them; don't drop "my" → "a".

   (c) COMPLETE THE ACTION — when a verb is sport/activity-specific, the new verb must complete the action naturally in the new context. "Dunked the ball" (basketball) → "kicked the ball INTO THE GOAL" (soccer), not just "kicked the ball" (incomplete in soccer). "Hit a home run" (baseball) → "scored a goal" (football), not "hit a goal".

How to tell a CATEGORY swap from a LITERAL swap:
- LITERAL: "change boy to girl", "rename foo to bar", "replace USD with EUR" — just the two words, no framing word. Do NOT propagate; only swap those literal tokens.
- CATEGORY: "change pet from dog to cat", "change vehicle from bike to car", "change era to medieval" — names a category (pet, vehicle, era, profession, country, setting, sport, protagonist). DO propagate dependent vocabulary.

6. ROLE PRESERVATION (numbers/labels) — when the instruction modifies SOME numbers but the target labels them with roles (e.g. "original price 100, final price 100" — original vs final are distinct roles), update ONLY the numbers tied to the role the instruction names. "Add 10%" applied to "original price 100, final price 100" only changes the FINAL price (to 110); the original stays 100. Same for "before/after", "input/output", "subtotal/total", etc.

EXAMPLES:

INSTRUCTION: change boy to girl
TARGET: the boy ran fast
REWRITE: the girl ran fast

INSTRUCTION: change boy to girl
TARGET: the boy and the other boy were friends
REWRITE: the girl and the other girl were friends

INSTRUCTION: he/she swap
TARGET: he gave the book to John
REWRITE: she gave the book to John

INSTRUCTION: make it british english
TARGET: the color of the harbor is gray
REWRITE: the colour of the harbour is grey

INSTRUCTION: make past tense
TARGET: I run to the store every day
REWRITE: I ran to the store every day

INSTRUCTION: capitalize proper nouns
TARGET: i visited paris and london last june
REWRITE: I visited Paris and London last June

INSTRUCTION: pluralize
TARGET: the child found one mouse
REWRITE: the children found mice

INSTRUCTION: rename foo to bar
TARGET: function foo() { return foo + 1 }
REWRITE: function bar() { return bar + 1 }

INSTRUCTION: change pet from dog to cat
TARGET: the dog wagged its tail and barked at the postman
REWRITE: the cat swished its tail and meowed at the postman

INSTRUCTION: change vehicle from bike to car
TARGET: I rode my bike to school and my helmet kept me safe
REWRITE: I drove my car to school and my seatbelt kept me safe

INSTRUCTION: change profession from doctor to teacher
TARGET: the doctor prescribed medicine for the patient
REWRITE: the teacher assigned homework for the student

INSTRUCTION: change era to medieval
TARGET: she sent him an email from her phone
REWRITE: she sent him a letter by messenger

INSTRUCTION: change country from US to Japan
TARGET: I had bagels and coffee for breakfast
REWRITE: I had miso soup and green tea for breakfast

INSTRUCTION: change protagonist to wizard
TARGET: the knight drew his sword and charged the dragon
REWRITE: the wizard drew his wand and charged the dragon

INSTRUCTION: switch sport from basketball to soccer
TARGET: he dribbled past defenders and dunked the ball
REWRITE: he dribbled past defenders and kicked the ball into the goal

INSTRUCTION: change protagonist to wizard
TARGET: the knight drew his sword and charged the dragon
REWRITE: the wizard drew his wand and charged the dragon

INSTRUCTION: change setting to ocean
TARGET: the camel walked across the dunes carrying water in its hump
REWRITE: the fish swam across the waves carrying water in its gills

INSTRUCTION: switch to winter
TARGET: I love summer afternoons swimming at the beach in my swimsuit
REWRITE: I love winter afternoons skiing at the slopes in my coat

INSTRUCTION: convert to vegetarian
TARGET: I made a burger with bacon and a beef patty
REWRITE: I made a burger with mushrooms and a bean patty

INSTRUCTION: switch sport from basketball to soccer
TARGET: he stole the rebound and dunked the ball
REWRITE: he stole the pass and kicked the ball into the goal

INSTRUCTION: add 10%
TARGET: original price 100, final price 100
REWRITE: original price 100, final price 110

INSTRUCTION: double it
TARGET: I had 5 cookies before lunch and 5 cookies after lunch
REWRITE: I had 10 cookies before lunch and 10 cookies after lunch`;

export interface ApplyResult {
  rewrite: string;
  raw: string;
  latencyMs: number;
}

export async function runApply(instruction: string, target: string): Promise<ApplyResult> {
  const r = await chat(
    sysUser(SYSTEM_PROMPT, `INSTRUCTION: ${instruction}\nTARGET: ${target}`),
    { maxTokens: 2048 },
  );
  return parseApplyOutput(r.text, r.latencyMs);
}

export function parseApplyOutput(raw: string, latencyMs: number): ApplyResult {
  const m = raw.match(/^REWRITE:\s*(.*?)\s*$/im);
  return { rewrite: m ? m[1].trim() : '', raw, latencyMs };
}
