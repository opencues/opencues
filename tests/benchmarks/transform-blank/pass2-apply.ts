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

7. COMPOSED INSTRUCTIONS ("X and Y") — when the instruction joins two transforms with "and" ("make past tense and remove pronouns", "pluralize and make past tense", "make it british english and past tense"), apply BOTH transforms to the rewrite. Both must be visible in the output AND the result must be grammatical under BOTH constraints simultaneously.

8. PRESERVE STRUCTURE (paragraphs, line breaks) — if the TARGET contains paragraph breaks (\n\n) or line breaks (\n), preserve them VERBATIM in the rewrite. Multi-paragraph inputs must produce multi-paragraph outputs with the same paragraph boundaries. Do NOT collapse paragraphs into a single block. Do NOT add new paragraph breaks that weren't there.

9. CONDITIONAL INSTRUCTIONS ("X but not Y", "X except Y", "X only when Z") — when the instruction includes an exception or scope-restriction clause, apply the transform ONLY where the condition holds. Examples:
   - "change boy to girl but not in the second sentence" → only change boys outside the second sentence
   - "uppercase brands except apple" → uppercase all brands EXCEPT the literal word "apple"
   - "make past tense except in dialogue" → leave quoted speech unchanged, change everything else
   - "change he to she only when referring to the doctor" → only swap pronouns whose referent is the doctor

   Common compose mistakes to AVOID:
   - "make past tense and remove pronouns": dropping "I" but leaving the next verb in present ("walk home" instead of "walked home"); using "before went to bed" (wrong — should be "before going to bed" because "before" takes a gerund, not a finite verb).
   - "pluralize and make past tense": pluralizing nouns but forgetting verb agreement ("the children runs" — wrong); pluralizing the named noun but missing dependent ones ("one mouse" → "one mice" — should drop "one"). Verbs after the pluralized noun must agree (singular present "runs" → past plural "ran"); quantifiers must drop or update ("one" doesn't survive pluralization).
   - "make it british english and past tense": doing only the BrE swap and leaving present-tense verbs.

   Apply BOTH transforms in one pass — don't think of it as two sequential edits where one might forget the other.

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

INSTRUCTION: change setting to ocean
TARGET: The camel walked across the dunes. The sand burned its hooves. In the distance, the camel saw an oasis where it could rest and drink before continuing its journey.
REWRITE: The fish swam across the waves. The water cooled its scales. In the distance, the fish saw a coral reef where it could rest and drink before continuing its journey.

CRITICAL — when an environment-bound VERB appears in the target ("burned" only makes sense for sand/sun/fire, not water), you MUST flip the verb's meaning, not preserve it. Water does NOT burn — it cools, soothes, refreshes. Snow does NOT melt skin — it numbs. Asphalt does NOT freeze — but ice does. Pick the verb that matches the new environment's actual physical effect, even if it means using a different verb than the source. Don't be lazy — preserving "burned" because the model "wants to keep it" is wrong.

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
REWRITE: I had 10 cookies before lunch and 10 cookies after lunch

INSTRUCTION: make past tense and remove pronouns
TARGET: I run to the store and I buy milk then I walk home and I pet my dog before I go to bed
REWRITE: ran to the store and bought milk then walked home and pet the dog before going to bed

INSTRUCTION: pluralize and make past tense
TARGET: the child runs to the park and finds one mouse hiding under a leaf then chases it across the grass
REWRITE: the children ran to the parks and found mice hiding under leaves then chased them across the grass

INSTRUCTION: make it british english and past tense
TARGET: I drive my car to the harbor and watch the gray waves roll in while I drink coffee from a paper cup
REWRITE: I drove my car to the harbour and watched the grey waves roll in while I drank coffee from a paper cup

INSTRUCTION: make past tense
TARGET: I wake up at six. I make coffee.

Later I take the dog for a walk in the park.
REWRITE: I woke up at six. I made coffee.

Later I took the dog for a walk in the park.

(Note the \n\n paragraph break is preserved verbatim.)

INSTRUCTION: change protagonist to wizard
TARGET: The knight rode his horse through the forest. He carried his sword at his side.

At the edge of the woods, he saw the dragon.
REWRITE: The wizard rode his horse through the forest. He carried his staff at his side.

At the edge of the woods, he saw the dragon.

(Horse is preserved — wizards can ride horses. Sword → staff because wizards don't carry swords. Paragraph break preserved.)

INSTRUCTION: change boy to girl but not in the second sentence
TARGET: The boy ran to the park. The boy met another boy there. They played until the boy went home.
REWRITE: The girl ran to the park. The boy met another boy there. They played until the girl went home.

(Sentences 1 and 3 changed; sentence 2 left untouched per the "but not in the second sentence" exception.)

INSTRUCTION: pluralize except mass nouns
TARGET: the child drank water and ate one cookie at the table
REWRITE: the children drank water and ate cookies at the tables

(Water is a mass noun — stays singular. "child" → "children", "cookie" → "cookies", "table" → "tables".)

INSTRUCTION: uppercase brands except apple
TARGET: i bought apple, samsung, and sony products
REWRITE: i bought apple, SAMSUNG, and SONY products

(Apple stays lowercase per the "except apple" exception. Samsung and Sony uppercase.)`;

export interface ApplyResult {
  rewrite: string;
  raw: string;
  latencyMs: number;
}

export async function runApply(instruction: string, target: string): Promise<ApplyResult> {
  // Dynamic max_tokens. Floor 768 ensures reasoning headroom; +400 token
  // overhead covers reasoning_effort: 'low' (200-800 tokens internal).
  const maxTokens = Math.max(768, Math.min(4096, Math.ceil((target.length * 1.5) / 3) + 400));
  const r = await chat(
    sysUser(SYSTEM_PROMPT, `INSTRUCTION: ${instruction}\nTARGET: ${target}`),
    { maxTokens },
  );
  return parseApplyOutput(r.text, r.latencyMs);
}

export function parseApplyOutput(raw: string, latencyMs: number): ApplyResult {
  // REWRITE may span multiple lines. Use `[ \t]*` (NOT `\s*`) for the
  // leading whitespace so we don't accidentally consume a leading
  // newline before content; the trailing `\s*$` is fine since this is
  // the last field.
  const m = raw.match(/REWRITE:[ \t]*([\s\S]*?)\s*$/i);
  return { rewrite: m ? m[1].trim() : '', raw, latencyMs };
}
