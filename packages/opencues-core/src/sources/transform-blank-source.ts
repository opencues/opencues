/**
 * opencues-core/sources/transform-blank-source.ts
 *
 * Transform blank — handles IMPERATIVE INSTRUCTIONS placed next to `_`,
 * applying the instruction to the surrounding text.
 *
 * Where FluidBlankSource catches "interrogative" blanks ("capital of france
 * _" → answer at the _), TransformBlankSource catches "imperative" blanks
 * ("change boy to girl _ the boy ran fast" → edits scattered through the
 * surrounding text).
 *
 * Three-pass pipeline:
 *
 *   P1 EXTRACT  →  { verdict: TRANSFORM|NONE, instruction, target }
 *                  Splits composed instructions ("X and Y") into pipe-
 *                  joined parts: "make past tense | remove pronouns".
 *
 *   P2 APPLY    →  draft rewrite of TARGET. Runs ONCE per pipe-part —
 *                  "X and Y" runs APPLY twice, output of first feeds
 *                  target of second. Sequential composition isolates
 *                  each transform.
 *
 *   P3 VERIFY   →  { verdict: OK|REPAIR, rewrite }. OK → trust draft.
 *                  REPAIR → emit corrected rewrite. Authority is narrow:
 *                  P3 only repairs internal-consistency bugs (agreement,
 *                  coverage, structural completeness, concept-swap
 *                  propagation). Never re-litigates TRANSFORM/NONE.
 *
 * Output shape: alternatives = [<original input>, <rewritten output>].
 * Cycling Up replaces the input region with the rewrite; cycling Down
 * restores the original. spanStart/spanEnd cover the entire instruction +
 * target region in CHARACTER offsets so the runtime knows what to wipe.
 *
 * History: developed via the tests/benchmarks/transform-blank/ harness.
 * 90% pass rate on 100 cases across 9 transformation classes (literal
 * swap, multi-span, concept, transform, math, linked-concepts, long-
 * text, targeted, composition).
 */

import { CueSource, CueContext, CueSourceResult, CueResult, HttpAdapter } from '../types';
import { BlankConfig } from '../cues-md';
import type { ProviderAdapter } from '../llm-provider';
import { detectPartialTransform } from './transform-partial-detector';
import { injectCursorSentinel, stripCursorSentinel } from '../cursor-sentinel';
import { translateBufferCursorToTargetCursor } from './transform-cursor-translate';

// ============================================================================
// Prompts — ported verbatim from tests/benchmarks/transform-blank/
// ============================================================================

// EXTRACT prompt — minimal variant. The previous verbose prompt
// (extensive shape lists + 18 examples) was over-constraining the
// model: it pattern-matched against the enumerated shapes and bailed
// to NONE on borderline imperatives. Stripped to a single semantic
// question + 4 layout-spanning examples; benchmark improves +5-7pp
// (88.9-90.1% vs 83.3% baseline) at zero latency cost. See
// tests/benchmarks/transform-blank/EXPERIMENTS.md, "Experiment 2".
export const P1_EXTRACT_SYSTEM = `Read the input and identify whether it carries an IMPERATIVE INSTRUCTION the user wants applied to the surrounding text — OR a command to manage a continuously-running agent task.

Output exactly three lines:
VERDICT: TRANSFORM | NONE | TASK_ARM | TASK_ADD | TASK_STOP | TASK_SHOW
INSTRUCTION: <the imperative phrase OR task prompt, _ removed; or empty>
TARGET: <the rest of the input after removing instruction + _; or empty>

The instruction sits IMMEDIATELY before _. Three layouts are valid:
  - <INSTRUCTION> _ <TARGET>                   (instruction first)
  - <TARGET> <INSTRUCTION> _                   (instruction trailing)
  - <TARGET-PT1> <INSTRUCTION> _ <TARGET-PT2>  (instruction sandwiched between two target chunks)

CRITICAL — SANDWICHED LAYOUT:
When the input contains text BOTH BEFORE the instruction line AND AFTER the
_ token, you MUST concatenate BOTH chunks into a single TARGET, joined by a
single newline character, preserving original order.

Detection: if INPUT has ≥3 logical sections — content, then an instruction
line ending in _, then more content — it is sandwiched. Never silently drop
either half. The first chunk is NOT a "prefix to ignore"; the second chunk is
NOT a "suffix to ignore". They are both part of the body the user wants
edited.

TARGET output spans MULTIPLE LINES when sandwiched. Emit it verbatim across
lines; the parser stops at the next pipeline marker ("---APPLY---" or end of
output), so a multi-line TARGET is unambiguous.

For composed instructions joined by "and" ("make past tense and remove pronouns"), output them pipe-joined: "make past tense | remove pronouns".

Bail to NONE for: UI placeholders, pure lookups (no instruction), idioms.

GENERATIVE INSTRUCTIONS — when the imperative is a CREATE/GENERATE request ("write a poem", "compose an email", "give me 5 startup ideas", "draft a tweet about X"), there is NO target text to operate on. Output VERDICT: TRANSFORM with the instruction populated and TARGET empty. The downstream pipeline will route this to a generative branch.

AGENT TASK COMMANDS — these arm or modify a continuously-running agent loop:

- TASK_ARM: input contains "agentically <X>" — arms a fresh task with prompt = X.
  Examples: "agentically correct spelling", "agentically fix humour", "agentically improve clarity".
  Put the task description (without "agentically") in INSTRUCTION. TARGET is empty.

- TASK_ADD: input contains "add task <X>" — appends X to the existing task prompt.
  Examples: "add task fix grammar", "add task remove emojis".
  Put the addition (without "add task") in INSTRUCTION. TARGET is empty.

- TASK_STOP: input is "stop task" (with _ adjacent) — clears the active task.
  INSTRUCTION and TARGET both empty.

- TASK_SHOW: input is "current task" (with _ adjacent) — substitutes the current
  task prompt at _ for the user to see.
  INSTRUCTION and TARGET both empty.

When you see one of these task-command shapes, ALWAYS use the matching TASK_*
verdict — do NOT classify them as TRANSFORM (the runtime needs the verdict to
route to the agent state machine, not to the regular edit pipeline).

EXAMPLES:

INPUT: change boy to girl _ the boy ran fast
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl
TARGET: the boy ran fast

INPUT: the boy ran fast change boy to girl _
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl
TARGET: the boy ran fast

INPUT: hi my name is wilfred
make wilfred bold _
and I work on opencues
VERDICT: TRANSFORM
INSTRUCTION: make wilfred bold
TARGET: hi my name is wilfred
and I work on opencues

INPUT: the meeting is at 3pm
make it a question _
on Friday
VERDICT: TRANSFORM
INSTRUCTION: make it a question
TARGET: the meeting is at 3pm
on Friday

INPUT: pluralize and make past tense _ the child runs to the park
VERDICT: TRANSFORM
INSTRUCTION: pluralize | make past tense
TARGET: the child runs to the park

INPUT: build me a website, car, app, newsletter convert to numbered list _
VERDICT: TRANSFORM
INSTRUCTION: convert to numbered list
TARGET: build me a website, car, app, newsletter

INPUT: make me a website is this prompt detailed enough _
VERDICT: NONE
INSTRUCTION:
TARGET:

INPUT: write a poem _
VERDICT: TRANSFORM
INSTRUCTION: write a poem
TARGET:

INPUT: agentically correct spelling _
VERDICT: TASK_ARM
INSTRUCTION: correct spelling
TARGET:

INPUT: agentically fix humour and improve clarity _
VERDICT: TASK_ARM
INSTRUCTION: fix humour and improve clarity
TARGET:

INPUT: add task remove emojis _
VERDICT: TASK_ADD
INSTRUCTION: remove emojis
TARGET:

INPUT: stop task _
VERDICT: TASK_STOP
INSTRUCTION:
TARGET:

INPUT: current task _
VERDICT: TASK_SHOW
INSTRUCTION:
TARGET:

INPUT: compose an email asking for a meeting _
VERDICT: TRANSFORM
INSTRUCTION: compose an email asking for a meeting
TARGET:

INPUT: give me 5 startup ideas _
VERDICT: TRANSFORM
INSTRUCTION: give me 5 startup ideas
TARGET:

INPUT: capital of france _
VERDICT: NONE
INSTRUCTION:
TARGET:`;

export const P2_APPLY_SYSTEM = `You receive:
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
5. CONCEPT-SWAP PROPAGATION — when the instruction names a CATEGORY rather than just two words (e.g. "change pet from dog to cat", "change profession from X to Y", "change era to medieval", "switch sport from X to Y"), update not only the named noun but also the verbs, objects, sounds, and properties that go with it. Cats meow and swish their tails (dogs bark and wag); cars use seatbelts and are driven (bikes use helmets and are ridden). Propagate dependent vocabulary.

   Sub-rules: (a) MINIMAL EDIT — propagate ONLY what's actually inappropriate; words that work for both stay UNCHANGED. (b) PRESERVE STRUCTURE — keep sentence skeleton, possessives. (c) COMPLETE THE ACTION — sport-specific verbs need full action ("dunked the ball" → "kicked the ball INTO THE GOAL").

   LITERAL swaps (no category word — "change boy to girl", "rename foo to bar") do NOT trigger propagation.

6. ROLE PRESERVATION — when the instruction modifies SOME numbers but the target labels them with roles ("original price 100, final price 100"), update ONLY the numbers tied to the named role.

7. COMPOSED INSTRUCTIONS — apply BOTH transforms; result must be grammatical under both constraints.

8. PRESERVE STRUCTURE (paragraphs/line breaks) — preserve \\n\\n verbatim. Multi-paragraph in → multi-paragraph out, same boundaries.

9. CONDITIONAL INSTRUCTIONS ("X but not Y", "X except Y", "X only when Z") — apply ONLY where the condition holds.

10. CURSOR ANCHOR — the TARGET may contain a [CURSOR] marker showing where the user's caret was when they triggered the transform. If the INSTRUCTION is POSITIONAL (it says "here", "at this point", "add X", "insert X", "split here", "move here", "before this", "after this", or implies anchoring to a specific spot), apply the edit at the [CURSOR] location. For non-positional INSTRUCTIONs (translate, capitalise, fix typos, make shorter, etc.), IGNORE the [CURSOR] marker — treat the target as if it weren't there. ALWAYS strip the [CURSOR] marker from your output regardless. Never emit the literal string [CURSOR] in the REWRITE.

11. MARKDOWN FORMATTING INSTRUCTIONS — when the INSTRUCTION asks for inline styling on a span ("make X bold", "bold the word X", "italicize Y", "italic Y", "strike through Z", "strikethrough Z"), you are NOT extracting the span; you are decorating it in place. CRITICAL: the rewrite MUST contain the ENTIRE TARGET verbatim, byte for byte, EXCEPT for adding the markdown markers around the named span. Counting check: if the target has N words, the rewrite must have at least N words. Do NOT emit just the bare span. Do NOT drop the surrounding text. Do NOT shorten the target.

    Marker syntax:
    - bold → \`**span**\`
    - italic → \`*span*\`
    - strikethrough → \`~~span~~\`
    - code / inline code → \`\`\`\`span\`\`\`\`

    For "make it a heading" / "make this a heading" applied to a line, prefix the line with \`# \`. For "turn into a list" / "make a list", prefix each item line with \`- \`. Markers are STRIPPED before the buffer is written; the visual style is rendered separately by the host. Do not refuse the instruction because you "can't apply styling" — emit the markers.

    ANTI-PATTERN (DO NOT DO THIS):
      INSTRUCTION: make wilfred bold
      TARGET: hi my name is wilfred
      WRONG REWRITE: **wilfred**                          ← collapsed body, lost context
      RIGHT REWRITE: hi my name is **wilfred**            ← target preserved, marker added

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

INSTRUCTION: change pet from dog to cat
TARGET: the dog wagged its tail and barked at the postman
REWRITE: the cat swished its tail and meowed at the postman

INSTRUCTION: change vehicle from bike to car
TARGET: I rode my bike to school and my helmet kept me safe
REWRITE: I drove my car to school and my seatbelt kept me safe

INSTRUCTION: change protagonist to wizard
TARGET: the knight drew his sword and charged the dragon
REWRITE: the wizard drew his wand and charged the dragon

INSTRUCTION: switch sport from basketball to soccer
TARGET: he dribbled past defenders and dunked the ball
REWRITE: he dribbled past defenders and kicked the ball into the goal

INSTRUCTION: change setting to ocean
TARGET: the camel walked across the dunes carrying water in its hump
REWRITE: the fish swam across the waves carrying water in its gills

INSTRUCTION: add 10%
TARGET: original price 100, final price 100
REWRITE: original price 100, final price 110

INSTRUCTION: make past tense
TARGET: I wake up at six. I make coffee.

Later I take the dog for a walk in the park.
REWRITE: I woke up at six. I made coffee.

Later I took the dog for a walk in the park.

INSTRUCTION: change boy to girl but not in the second sentence
TARGET: The boy ran to the park. The boy met another boy there. They played until the boy went home.
REWRITE: The girl ran to the park. The boy met another boy there. They played until the girl went home.

INSTRUCTION: pluralize except mass nouns
TARGET: the child drank water and ate one cookie at the table
REWRITE: the children drank water and ate cookies at the tables

INSTRUCTION: uppercase brands except apple
TARGET: i bought apple, samsung, and sony products
REWRITE: i bought apple, SAMSUNG, and SONY products

INSTRUCTION: make wilfred bold
TARGET: hii my name is wilfred.
REWRITE: hii my name is **wilfred**.

INSTRUCTION: bold the word name
TARGET: hii my name is wilfred.
REWRITE: hii my **name** is wilfred.

INSTRUCTION: italicize wilfred
TARGET: hii my name is wilfred.
REWRITE: hii my name is *wilfred*.

INSTRUCTION: strike through the word wilfred
TARGET: hii my name is wilfred.
REWRITE: hii my name is ~~wilfred~~.

INSTRUCTION: make the first line a heading
TARGET: My Notes

Today I worked on the runtime.
REWRITE: # My Notes

Today I worked on the runtime.

INSTRUCTION: turn the items into a list
TARGET: I bought apples bananas and oranges.
REWRITE: - apples
- bananas
- oranges`;

// Generative APPLY — runs when EXTRACT returns TRANSFORM with empty
// TARGET. The instruction is a create/generate request ("write a
// poem", "compose an email"), not an edit. No target to transform,
// no VERIFY pass downstream — the model just generates content.
const P2_GENERATIVE_APPLY_SYSTEM = `You receive an INSTRUCTION that asks you to GENERATE or CREATE content. Produce the content. No commentary.

Output exactly one line, nothing else:
REWRITE: <generated content>

RULES:
- The output is the generated content itself, NOT a description of it
- Be concrete and direct — no "Here is your poem:" preamble
- Match the format the instruction implies (poem = verses; email = headers + body; list = numbered/bulleted lines; etc.)
- Reasonable length — short for "tweet", longer for "email" or "essay"
- Multi-line outputs are fine; preserve \\n where structure requires

EXAMPLES:

INSTRUCTION: write a haiku about autumn
REWRITE: Crimson leaves drift down
Whispering of summer's end
Crisp wind stirs the trees

INSTRUCTION: compose an email asking for a meeting
REWRITE: Subject: Quick meeting request

Hi,

Could we set up a 30-minute call this week to discuss the project? I'm flexible on timing — Tuesday or Wednesday afternoon work best for me.

Thanks,

INSTRUCTION: give me 5 startup ideas
REWRITE: 1. AI-powered code review tool for non-engineers
2. Subscription box for indie game soundtracks
3. Marketplace for verified second-hand kids' clothing
4. Browser extension that summarizes long articles in your tone
5. Local-first calendar app for freelancers

INSTRUCTION: write a tweet announcing a product launch
REWRITE: Excited to launch [Product] today — [one-line value prop]. Built for [target user] who [problem]. Try it free at [link]. 🚀

INSTRUCTION: draft a thank you note for a job interview
REWRITE: Dear [Interviewer],

Thank you for taking the time to speak with me yesterday about the [Role] position. I enjoyed our conversation about [specific topic], and learning more about your team's work on [project] only deepened my interest.

Please let me know if there's anything else I can provide.

Best regards,
[Name]`;

const P3_VERIFY_SYSTEM = `You are reviewing a text-edit produced by another model. Your job: decide whether the draft rewrite correctly applies the instruction to the target — and if not, emit a fixed version.

You receive:
- INSTRUCTION: a short imperative editing command
- TARGET: the original text the instruction should be applied to
- DRAFT: the draft rewrite produced by another model

Output exactly two lines, nothing else:
VERDICT: OK | REPAIR
REWRITE: <DRAFT verbatim when OK; the corrected rewrite when REPAIR>

Check the DRAFT against THESE rules:

1. AGREEMENT — when an edit changes number/tense/case, dependent words must follow ("they is" → "they are"; "one mice" → "mice").
2. COVERAGE — edit applied to ALL applicable spans, not just the first.
3. STRUCTURAL COMPLETENESS — restructuring instructions actually restructure ("make it a question" must produce a real question, not just append "?").
4. CONCEPT-SWAP PROPAGATION — for CATEGORY swaps, dependent vocabulary updates (cats don't bark; cars don't use helmets).

ALWAYS output the rewrite — never bail to NONE. P1 already decided this is a valid transform.

DEFAULT TO OK. Only output REPAIR when you can name a SPECIFIC, IDENTIFIABLE defect from the four checks above. If the draft looks fine, output OK and pass it through. Stylistic improvement is NOT your job. You are a defect catcher, not a writer.

CRITICAL — your REWRITE must be the FULL output text. Never use ellipsis (…) to abbreviate, never use stray dashes/separators (— ‑ –) between fragments, never insert "END" markers. If you can't reproduce the full draft cleanly, output VERDICT: OK with empty REWRITE — the runtime will fall back to the draft.

AMBIGUOUS INSTRUCTIONS — many editing instructions have multiple valid interpretations. "Capitalize all words" can mean Title Case (each word's first letter) OR ALL CAPS. "Make formal" has many valid registers. "Capitalize" can mean sentence case or title case. When the DRAFT picks ONE valid interpretation, ACCEPT IT. Do NOT REPAIR just because YOU would have interpreted differently. Examples:

INSTRUCTION: capitalize all words
TARGET: the boy ran fast
DRAFT: The Boy Ran Fast
VERDICT: OK
REWRITE: The Boy Ran Fast

(Title Case is a valid interpretation of "capitalize all words". Do NOT REPAIR to "THE BOY RAN FAST". Both are valid. Pick the draft.)

INSTRUCTION: capitalize the names
TARGET: i had lunch with james and sarah
DRAFT: i had lunch with James and Sarah
VERDICT: OK
REWRITE: i had lunch with James and Sarah

(Names capitalized, rest left as-is. Don't REPAIR to "I had lunch..." just because the i could also be capitalized — the instruction said "the names", not "everything".)

WORKED EXAMPLE — when NOT to repair:

INSTRUCTION: change protagonist to wizard
TARGET: the knight drew his sword and charged the dragon
DRAFT: the wizard drew his wand and charged the dragon
VERDICT: OK
REWRITE: the wizard drew his wand and charged the dragon

(Clean concept-swap. "Drew" stays; "charged" stays. Adding "and cast a spell" would be WRONG — that's stylistic invention, not defect repair.)

INSTRUCTION: make it british english
TARGET: the color of the harbor reflected the gray sky as we walked along the sidewalk past the theater toward our favorite restaurant where we ordered fries with our meal
DRAFT: the colour of the harbour reflected the grey sky as we walked along the pavement past the theatre towards our favourite restaurant where we ordered chips with our meal
VERDICT: OK
REWRITE: the colour of the harbour reflected the grey sky as we walked along the pavement past the theatre towards our favourite restaurant where we ordered chips with our meal

EXAMPLES — when to repair:

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

INSTRUCTION: change pet from dog to cat
TARGET: the dog wagged its tail and barked at the postman
DRAFT: the cat wagged its tail and barked at the postman
VERDICT: REPAIR
REWRITE: the cat swished its tail and meowed at the postman

INSTRUCTION: make it a question
TARGET: the meeting starts at 3pm
DRAFT: the meeting starts at 3pm?
VERDICT: REPAIR
REWRITE: Does the meeting start at 3pm?

INSTRUCTION: make wilfred bold
TARGET: hii my name is wilfred.
DRAFT: wilfred
VERDICT: REPAIR
REWRITE: hii my name is **wilfred**.

(The draft collapsed the body. For inline-styling instructions, the rewrite must preserve the entire TARGET and wrap the named span in markdown markers — \`**bold**\`, \`*italic*\`, \`~~strike~~\`, \`\`\`\`code\`\`\`\`. Never drop unrelated text.)

INSTRUCTION: italicize wilfred
TARGET: hii my name is wilfred.
DRAFT: hii my name is *wilfred*.
VERDICT: OK
REWRITE: hii my name is *wilfred*.`;

// ============================================================================
// Parsers
// ============================================================================

type ExtractVerdict = 'TRANSFORM' | 'NONE' | 'TASK_ARM' | 'TASK_ADD' | 'TASK_STOP' | 'TASK_SHOW';

interface ExtractResult {
  verdict: ExtractVerdict;
  instruction: string;  // pipe-joined for composed instructions; task prompt for TASK_ARM/ADD
  target: string;
}

interface ApplyResult {
  rewrite: string;
}

interface VerifyResult {
  verdict: 'OK' | 'REPAIR';
  rewrite: string;
}

function parseExtract(raw: string): ExtractResult {
  // Single-line fields use [ \t]* (NOT \s*) for trailing whitespace.
  // \s* matches \n, which makes the lazy .*? extend across line breaks
  // and swallow the next field label. e.g. "INSTRUCTION:\nTARGET:\n"
  // (empty instruction, empty target) would capture "TARGET:" as the
  // instruction value.
  const verdictMatch = raw.match(/^VERDICT:[ \t]*(TRANSFORM|NONE|TASK_ARM|TASK_ADD|TASK_STOP|TASK_SHOW)[ \t]*$/im);
  const instructionMatch = raw.match(/^INSTRUCTION:[ \t]*(.*?)[ \t]*$/im);
  // TARGET may span multiple lines; drop `m` so $ is end-of-string.
  const targetMatch = raw.match(/TARGET:[ \t]*([\s\S]*?)\s*$/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'NONE') as ExtractVerdict;
  return {
    verdict,
    instruction: instructionMatch ? instructionMatch[1].trim() : '',
    target: targetMatch ? targetMatch[1].trim() : '',
  };
}

function parseApply(raw: string): ApplyResult {
  // REWRITE is the LAST field — `[\s\S]*?` is fine here because there's
  // nothing after it. Use `[ \t]*` for the leading whitespace to avoid
  // accidentally consuming the newline before content.
  const m = raw.match(/REWRITE:[ \t]*([\s\S]*?)\s*$/i);
  return { rewrite: m ? m[1].trim() : '' };
}

function parseVerify(raw: string): VerifyResult {
  const verdictMatch = raw.match(/^VERDICT:[ \t]*(OK|REPAIR)[ \t]*$/im);
  const rewriteMatch = raw.match(/REWRITE:[ \t]*([\s\S]*?)\s*$/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'OK') as 'OK' | 'REPAIR';
  return { verdict, rewrite: rewriteMatch ? rewriteMatch[1].trim() : '' };
}

// ============================================================================
// Safety net — reject mangled VERIFY repairs
// ============================================================================

/**
 * Repair is suspiciously shorter than the draft AND target — model
 * truncated mid-sentence rather than emitting a real correction.
 */
function repairLooksTruncated(repair: string, draft: string, target: string): boolean {
  return repair.length < draft.length * 0.5 && repair.length < target.length * 0.5;
}

/**
 * Decide whether the APPLY draft looks "structurally faithful" enough
 * that VERIFY can be skipped. Saves ~600-1500ms per case (~30% of
 * pipeline latency) when applicable.
 *
 * Conservative ruleset (Experiment 4 winner): only the truly mechanical
 * edits skip VERIFY. Literal swaps and BrE↔AmE conversions have no
 * agreement subtleties to check; broader rules (case changes, simple
 * tense) showed −2.8pp accuracy in the variant benchmark because they
 * sometimes have ambiguous interpretations VERIFY catches. The
 * conservative rules cut 13% latency at < 1pp accuracy cost.
 *
 * Skip VERIFY when ALL hold:
 *  - draft length within ±15% of target length
 *  - no `\n\n` in target/draft (multi-paragraph needs VERIFY's
 *    paragraph-preservation check)
 *  - single instruction (composed `X | Y` needs VERIFY for cross-step
 *    agreement)
 *  - instruction is one of:
 *      * literal swap: `change|replace|swap|rename A to|with|for B`
 *      * BrE→AmE or AmE→BrE: `make it (british|american) english`
 *
 * Otherwise fall through to VERIFY. See
 * tests/benchmarks/transform-blank/EXPERIMENTS.md, "Experiment 4".
 */
function shouldSkipVerify(instruction: string, target: string, draft: string): boolean {
  if (!draft) return false;
  // Length sanity — diverging length means structural change happened
  const targetLen = target.length;
  const draftLen = draft.length;
  const ratio = draftLen / Math.max(targetLen, 1);
  if (ratio < 0.85 || ratio > 1.15) return false;
  // Multi-paragraph cases — VERIFY catches paragraph-collapse bugs
  if (target.includes('\n\n') || draft.includes('\n\n')) return false;
  // Composed instructions ("X | Y") — let VERIFY catch agreement
  // issues between the two transforms
  if (instruction.includes('|')) return false;
  // Truly mechanical instruction patterns where VERIFY essentially
  // never fires REPAIR
  const i = instruction.toLowerCase().trim();
  if (/^(change|replace|swap|rename)\s+\S+\s+(to|with|for)\s+\S+$/.test(i)) return true;
  if (/^make\s+it\s+(british|american)\s+english$/.test(i)) return true;
  return false;
}

/**
 * Repair has telltale signs of model going off the rails: runs of
 * horizontal whitespace, hidden zero-width chars, mid-sentence ellipsis
 * (… or "..."), repeated dash separators, or stray "END" markers.
 * Newlines (\n) are LEGITIMATE in multi-paragraph rewrites — exclude.
 */
function repairLooksGarbled(repair: string): boolean {
  if (/[ \t]{4,}/.test(repair)) return true;
  if (/[\u200B-\u200F\uFEFF\u2028\u2029]/.test(repair)) return true;
  if (/\.{3,}\s*\S/.test(repair)) return true;
  if (/…/.test(repair)) return true;
  const dashes = repair.match(/[‑–—]/g) ?? [];
  if (dashes.length >= 3) return true;
  if (/\?END\?|END\?\s*END|END\s+END/.test(repair)) return true;
  return false;
}

// ============================================================================
// Token budgeting — dynamic max_tokens per call
// ============================================================================

/**
 * Estimate output token budget given an expected output length in chars.
 * The budget must cover BOTH reasoning tokens (`reasoning_effort: 'low'`
 * consumes 200-800 tokens internally before emitting output) AND the
 * actual output (rewrite + format labels).
 *
 * Formula:
 *   budget = max(FLOOR, ceil(chars × multiplier / 3) + REASONING_HEADROOM)
 *
 * - FLOOR (768): always enough for reasoning + a short rewrite + labels
 * - REASONING_HEADROOM (400): typical 'low' reasoning budget on this model
 * - chars × multiplier / 3: the rewrite portion (rough char-to-token of 3)
 * - CEILING (4096): cap for the longest multi-paragraph rewrites
 *
 * Even at FLOOR, this is 4× lower than the previous flat 2048-token
 * budget on short inputs — saves ~50-200ms per call on Groq via lower
 * planning/TTFT overhead. Long inputs scale up automatically.
 *
 * History: an earlier version used FLOOR=128 + REASONING_HEADROOM=100,
 * which truncated mid-output on multi-paragraph cases (long-text
 * accuracy dropped 85% → 50%). The current floor leaves enough budget
 * for the model to finish reasoning AND emit a short reply.
 */
function budgetForOutput(expectedChars: number, multiplier: number = 1.0): number {
  const REASONING_HEADROOM = 400;
  const FLOOR = 768;
  const CEILING = 4096;
  const est = Math.ceil((expectedChars * multiplier) / 3) + REASONING_HEADROOM;
  return Math.max(FLOOR, Math.min(CEILING, est));
}

// ============================================================================
// Imperative-verb heuristic for supports() — avoid LLM call when input
// is clearly NOT a transform-shaped blank
// ============================================================================

/**
 * Verbs that typically introduce a transform instruction. Checked in the
 * 8 words before the `_` AND the first 8 words of the input — covers
 * both "<verb> _ <target>" and "<target> <verb> _" layouts.
 */
const IMPERATIVE_VERBS = new Set([
  'change', 'replace', 'swap', 'rename', 'switch', 'turn', 'flip',
  'make', 'convert', 'fix', 'recalculate', 'double', 'halve',
  'capitalize', 'capitalise', 'uppercase', 'lowercase',
  'pluralize', 'pluralise', 'expand', 'contract', 'remove', 'delete',
  'strip', 'format', 'add', 'apply', 'update', 'match', 'use',
  'title', 'titlecase', 'shorten', 'lengthen', 'rewrite',
]);

/**
 * Case-transform phrases — multi-word markers that don't start with a
 * verb but unambiguously signal an imperative ("full caps all words",
 * "lower case the names"). Lower-case here for case-insensitive match.
 */
const CASE_TRANSFORM_PHRASES = [
  'all caps', 'full caps', 'small caps', 'fullcaps', 'allcaps',
  'lower case', 'upper case', 'title case', 'sentence case',
  'in caps', 'in lowercase', 'in uppercase',
  'to lower', 'to upper', 'to caps', 'to title',
];

function looksLikeImperative(words: string[], blankIdx: number, fullText: string): boolean {
  // Window: 8 words on each side of the `_`. Catches both "<verb> _ <target>"
  // (verb in first ~5 words) and "<target> <verb> _" (verb in last ~5
  // words before `_`). Wider window than v1 to handle longer prefaces.
  const upTo = Math.min(blankIdx, 8);
  for (let i = 0; i < upTo; i++) {
    if (IMPERATIVE_VERBS.has(words[i].toLowerCase())) return true;
    if (IMPERATIVE_VERBS.has(words[blankIdx - 1 - i].toLowerCase())) return true;
  }
  // Phrase fallback — multi-word case-transform markers ("full caps",
  // "lower case", etc.) that don't start with a verb but unambiguously
  // signal a transform. Case-insensitive substring match on the input
  // (not word-by-word) so "fullcaps", "FULL CAPS", etc. all match.
  const lowerText = fullText.toLowerCase();
  for (const phrase of CASE_TRANSFORM_PHRASES) {
    if (lowerText.includes(phrase)) return true;
  }
  return false;
}

// ============================================================================
// Source class
// ============================================================================

/**
 * Lifecycle events emitted by `TransformBlankSource` during the 3-pass
 * pipeline. Wire `onEvent` in the source's config to observe them.
 *
 * This is the canonical taxonomy — runtime consumers treat these as
 * the source of truth and adapt them into their own event stream.
 * Core OWNS the names + body shapes; nothing outside core gets to
 * add to this union.
 *
 * Adding a new phase: extend the union here, emit it from the
 * pipeline, document it. Renaming an existing phase is a
 * breaking-change to consumers — bump the package version.
 */
export type TransformBlankEvent =
  /** Pipeline started. textLen = full buffer length, blankIdx = the `_` word index. */
  | { type: 'started'; textLen: number; blankIdx: number }
  /** One pipeline pass completed. P1 = EXTRACT, P2 = APPLY (one or more
   *  steps), P3 = VERIFY. P1 carries the verdict + extracted instruction;
   *  P2 carries step / totalSteps; P3 carries the verify verdict. */
  | { type: 'pass-completed'; pass: 'P1' | 'P2' | 'P3'; latencyMs: number;
      verdict?: string; instruction?: string; target?: string;
      step?: number; totalSteps?: number }
  /** Pipeline finished and produced a final rewrite. */
  | { type: 'completed'; finalLen: number; finalPreview: string; latencyMs: number }
  /** Pipeline bailed early. `reason` is a stable kebab-case identifier
   *  (P1-verdict-none-or-empty, P2-empty-result, etc.). */
  | { type: 'bailed'; reason: string; latencyMs: number };

export interface TransformBlankSourceConfig {
  httpAdapter: HttpAdapter;
  provider: ProviderAdapter;
  endpoint: string;
  apiKey: string;
  model: string;
  /** Source priority. Default 93 — sits ABOVE FluidBlankSource (92) so
   * imperative-shaped inputs route here, BELOW BlankSource (95) so
   * keyword-bound blanks always win. */
  priority?: number;
  /** All registered keyword-bound blanks. Transform cedes the slot if
   * a keyword-bound BlankSource would claim it (mirrors fluid-blank
   * cede logic). */
  blanks?: Record<string, BlankConfig>;
  /**
   * Optional logger — called at every pipeline stage so a host can
   * surface what the 3-pass pipeline is doing. Wire to the runtime's
   * `adapter.log('debug', msg)` for `debug-mode: on` traces, OR to
   * `console.error` when running outside the runtime. Same shape as
   * the runtime's adapter.log so callers can pipe straight through.
   */
  log?: (msg: string) => void;
  /**
   * Optional pipeline-event subscriber — called at every lifecycle
   * boundary with a typed `TransformBlankEvent`. Use this to surface
   * what the pipeline is doing without parsing log lines.
   *
   * Runtime consumers map these into their own event-stream format
   * (typically prefixing the source id, e.g. `transform-blank.<type>`).
   * Core owns the names + body shapes; consumers adapt.
   */
  onEvent?: (event: TransformBlankEvent) => void;
}

export class TransformBlankSource implements CueSource {
  readonly id = 'transform-blank';
  readonly priority: number;

  private httpAdapter: HttpAdapter;
  private provider: ProviderAdapter;
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private blanks: Record<string, BlankConfig>;
  private log: (msg: string) => void;
  private emit: (event: TransformBlankEvent) => void;

  constructor(config: TransformBlankSourceConfig) {
    this.httpAdapter = config.httpAdapter;
    this.provider = config.provider;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.priority = config.priority ?? 93;
    this.blanks = config.blanks ?? {};
    this.log = config.log ?? (() => { /* default: silent */ });
    this.emit = config.onEvent ?? (() => { /* default: silent */ });
  }

  supports(context: CueContext): boolean {
    const lower = context.words.map(w => w.toLowerCase());
    const blankIndex = lower.indexOf('_');
    if (blankIndex === -1) return false;

    // Cede to keyword-bound BlankSource if a registered blank's keyword is
    // within blankProximity of the `_` (mirror fluid-blank cede logic).
    for (const blk of Object.values(this.blanks)) {
      if (!blk.blankKeywords?.length) continue;
      const proximity = blk.blankProximity ?? 0;
      for (const phrase of blk.blankKeywords) {
        const parts = phrase.toLowerCase().split(/\s+/);
        for (let i = 0; i <= lower.length - parts.length; i++) {
          let ok = true;
          for (let j = 0; j < parts.length; j++) {
            if (lower[i + j] !== parts[j]) { ok = false; break; }
          }
          if (!ok) continue;
          const endIdx = i + parts.length - 1;
          const gap = Math.abs(endIdx - blankIndex) - 1;
          if (gap <= proximity) return false;
        }
      }
    }

    // Always claim. EXTRACT is the authoritative classifier — if the
    // input isn't actually a transform, EXTRACT returns VERDICT: NONE
    // and getCues() bails with an empty result. A pre-LLM keyword
    // heuristic missed common phrasings (e.g. "full caps", "fullcaps")
    // so the LLM owns the decision. Cost: one extra ~400ms LLM call
    // per non-transform `_` typed. looksLikeImperative() is kept as a
    // potential fast-path helper for future use.
    void looksLikeImperative;  // keep export reachable
    return true;
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();
    const previewLen = 80;
    const preview = (s: string) => s.length > previewLen ? s.slice(0, previewLen) + '…' : s;
    try {
      const blankIdx = context.words.indexOf('_');
      if (blankIdx === -1) return { results: [] };

      this.log(`TransformBlank: starting (textLen=${context.text.length}, blankIdx=${blankIdx})`);
      const __pipelineT0 = Date.now();
      this.emit({ type: 'started', textLen: context.text.length, blankIdx });

      // P1 EXTRACT — split into instruction (pipe-joined for composed)
      // and target. Token budget: target text contributes ~chars/4
      // tokens, plus ~100 token overhead for VERDICT/INSTRUCTION
      // labels and formatting. The target field echoes most of the
      // input back verbatim so we need roughly 1× the input size.
      //
      // Run EXTRACT against the AS-TYPED view of the buffer when one
      // is available. Agent-edited words are reverted to their
      // originalWord here, so commands like `agentically X _` are
      // recognised even if the agent has translated `agentically` to
      // something else in the visible buffer. For the TRANSFORM /
      // GENERATIVE branches the as-typed view is also fine — APPLY
      // works on whatever TARGET the user logically meant. The
      // substitute path uses context.text (the visible buffer) for
      // length checks and stripping, so visible-side state is intact.
      // EXTRACT input precedence: richText (markdown markers re-injected)
      // > asTypedText (agent rewrites reverted) > visible text. richText
      // wins when set so the LLM can see prior styling and preserve it
      // across transforms ("X is bold, now make it caps" → still bold).
      // asTypedText is the legacy agent-defeat path.
      const extractText = context.richText ?? context.asTypedText ?? context.text;
      const sourceTag = context.richText ? 'rich-text' : context.asTypedText ? 'as-typed' : 'visible';
      const p1Tokens = budgetForOutput(extractText.length, 1.0);
      const p1Start = Date.now();
      const extractRaw = await this.callLLM(P1_EXTRACT_SYSTEM, `INPUT: ${extractText}`, p1Tokens);
      const ext = parseExtract(extractRaw);
      this.log(`TransformBlank P1 EXTRACT (${Date.now() - p1Start}ms, max_tokens=${p1Tokens}, source=${sourceTag}): verdict=${ext.verdict}, instruction="${ext.instruction}", target="${preview(ext.target)}"`);
      this.emit({
        type: 'pass-completed',
        pass: 'P1',
        verdict: ext.verdict,
        instruction: ext.instruction,
        target: preview(ext.target),
        latencyMs: Date.now() - p1Start,
      });

      // TASK BRANCH — agent-task commands. Route to the runtime via
      // metadata.taskAction; no APPLY/VERIFY needed. The runtime's
      // resolver substitute branch will mutate AgentTaskState and
      // (for TASK_SHOW) substitute the current prompt at _.
      if (ext.verdict === 'TASK_ARM' || ext.verdict === 'TASK_ADD'
          || ext.verdict === 'TASK_STOP' || ext.verdict === 'TASK_SHOW') {
        this.log(`TransformBlank: TASK branch (${ext.verdict}, instruction="${ext.instruction}")`);
        const result: CueResult = {
          wordIndex: blankIdx,
          word: '_',
          // Placeholder alternatives — the runtime will compute the real
          // substitution based on taskAction (e.g. TASK_SHOW substitutes
          // the current prompt; others wipe the trigger phrase).
          alternatives: [context.text, ''],
          source: this.id,
          priority: this.priority,
          spanStart: 0,
          spanEnd: context.text.length,
          metadata: {
            taskAction: ext.verdict,
            taskPayload: ext.instruction,  // task prompt for ARM/ADD; empty for STOP/SHOW
          },
        };
        return { results: [result], timing: Date.now() - startTime, model: this.model };
      }

      if (ext.verdict === 'NONE' || !ext.instruction) {
        this.log(`TransformBlank: bailing — P1 verdict=NONE or empty instruction`);
        this.emit({ type: 'bailed', reason: 'P1-verdict-none-or-empty', latencyMs: Date.now() - __pipelineT0 });
        return { results: [], timing: Date.now() - startTime, model: this.model };
      }

      // GENERATIVE BRANCH — instruction with no target = create/generate
      // request ("write a poem _", "compose an email _"). Single-pass:
      // one APPLY call with the generative prompt, no VERIFY (nothing
      // to verify against — it's new content, not an edit of existing
      // text). Returns the generated content as the rewrite.
      if (!ext.target) {
        this.log(`TransformBlank: GENERATIVE branch (instruction with no target)`);
        const genTokens = budgetForOutput(800, 1.0);  // assume up to ~800 chars of generated content
        const genStart = Date.now();
        const genRaw = await this.callLLM(
          P2_GENERATIVE_APPLY_SYSTEM,
          `INSTRUCTION: ${ext.instruction}`,
          genTokens,
        );
        const generated = parseApply(genRaw).rewrite;
        this.log(`TransformBlank P2 GENERATIVE (${Date.now() - genStart}ms, max_tokens=${genTokens}): "${preview(generated)}"`);
        if (!generated) {
          this.log(`TransformBlank: bailing — GENERATIVE returned empty`);
          return { results: [], timing: Date.now() - startTime, model: this.model };
        }

        const result: CueResult = {
          wordIndex: blankIdx,
          word: '_',
          alternatives: [context.text, generated],
          source: this.id,
          priority: this.priority,
          spanStart: 0,
          spanEnd: context.text.length,
          metadata: {
            transformInstruction: ext.instruction,
            transformTarget: '',
            transformMode: 'generative',
            verifyVerdict: 'OK',  // no verify on generative
          },
        };
        this.log(`TransformBlank: GENERATIVE done (${Date.now() - startTime}ms total) — final="${preview(generated)}"`);
        return { results: [result], timing: Date.now() - startTime, model: this.model };
      }

      // P2 APPLY — sequential composition for "X | Y" instructions.
      // Output of step N feeds target of step N+1. Token budget: rewrite
      // is usually same length as target, but transforms can stretch it
      // (e.g. "expand contractions" adds chars). Use 1.5× headroom.
      const parts = ext.instruction.split('|').map(s => s.trim()).filter(Boolean);
      this.log(`TransformBlank P2 APPLY: ${parts.length} step(s) — [${parts.map(p => `"${p}"`).join(', ')}]`);
      let currentTarget = ext.target;
      // Cursor injection is FIRST-STEP-ONLY. Subsequent pipe-composed
      // steps operate on the previous step's rewrite, where the cursor
      // concept doesn't carry meaning (the LLM has reshaped the text;
      // we don't try to track the cursor through the reshape).
      const initialCursor = translateBufferCursorToTargetCursor(
        context.text,
        context.cursor ?? -1,
        ext.target,
      );
      if (initialCursor >= 0) {
        this.log(`TransformBlank P2 APPLY: cursor injected at target-offset ${initialCursor}/${ext.target.length}`);
      }
      let lastRewrite = '';
      for (let i = 0; i < parts.length; i++) {
        const inst = parts[i];
        const stepStart = Date.now();
        const p2Tokens = budgetForOutput(currentTarget.length, 1.5);
        // First step: inject [CURSOR] at the user's caret position.
        // Subsequent steps run cursor-blind (the marker would dangle in
        // text the LLM has already reshaped).
        const targetForPrompt = i === 0
          ? injectCursorSentinel(currentTarget, initialCursor)
          : currentTarget;
        const applyRaw = await this.callLLM(
          P2_APPLY_SYSTEM,
          `INSTRUCTION: ${inst}\nTARGET: ${targetForPrompt}`,
          p2Tokens,
        );
        // Strip any sentinel the model leaked into its output — input-only.
        const draft = stripCursorSentinel(parseApply(applyRaw).rewrite);
        this.log(`TransformBlank P2 APPLY step ${i + 1}/${parts.length} (${Date.now() - stepStart}ms, max_tokens=${p2Tokens}): "${preview(draft)}"`);
        this.emit({
          type: 'pass-completed',
          pass: 'P2',
          step: i + 1,
          totalSteps: parts.length,
          latencyMs: Date.now() - stepStart,
        });
        if (!draft) {
          this.log(`TransformBlank: bailing — APPLY step ${i + 1} returned empty`);
          break;
        }
        lastRewrite = draft;
        currentTarget = draft;
      }
      if (!lastRewrite) {
        return { results: [], timing: Date.now() - startTime, model: this.model };
      }

      // P3 VERIFY — check the final draft. Pass instruction in original
      // "X and Y" form (not pipe-joined) for clearer prompt context.
      // Budget: rewrite is bounded by max(target, draft) length, +50%.
      const verifyInstruction = parts.join(' and ');

      // SKIP VERIFY when the draft is "structurally faithful" and the
      // instruction is low-stakes (literal swap, simple case change,
      // simple tense). Saves ~600-1500ms per case (~30% of pipeline
      // latency). Falls through to VERIFY for anything ambiguous.
      let ver: VerifyResult;
      if (shouldSkipVerify(verifyInstruction, ext.target, lastRewrite)) {
        ver = { verdict: 'OK', rewrite: lastRewrite };
        this.log(`TransformBlank P3 VERIFY: SKIPPED (low-stakes instruction + faithful draft)`);
      } else {
        const verifyBudgetSrc = Math.max(ext.target.length, lastRewrite.length);
        const p3Tokens = budgetForOutput(verifyBudgetSrc, 1.5);
        const p3Start = Date.now();
        const verifyRaw = await this.callLLM(
          P3_VERIFY_SYSTEM,
          `INSTRUCTION: ${verifyInstruction}\nTARGET: ${ext.target}\nDRAFT: ${lastRewrite}`,
          p3Tokens,
        );
        ver = parseVerify(verifyRaw);
        this.log(`TransformBlank P3 VERIFY (${Date.now() - p3Start}ms, max_tokens=${p3Tokens}): verdict=${ver.verdict}, rewrite="${preview(ver.rewrite)}"`);
        this.emit({
          type: 'pass-completed',
          pass: 'P3',
          verdict: ver.verdict,
          latencyMs: Date.now() - p3Start,
        });
      }

      // Decide final rewrite: OK → trust draft. REPAIR → use verify's
      // correction unless it looks truncated/garbled (safety net).
      let finalRewrite: string;
      if (ver.verdict === 'OK' || !ver.rewrite) {
        finalRewrite = lastRewrite;
      } else {
        const truncated = repairLooksTruncated(ver.rewrite, lastRewrite, ext.target);
        const garbled = repairLooksGarbled(ver.rewrite);
        if (truncated || garbled) {
          this.log(`TransformBlank: REPAIR rejected (truncated=${truncated}, garbled=${garbled}) — falling back to draft`);
          finalRewrite = lastRewrite;
        } else {
          this.log(`TransformBlank: REPAIR accepted — using verify's correction`);
          finalRewrite = ver.rewrite;
        }
      }

      this.log(`TransformBlank: pipeline done (${Date.now() - startTime}ms total) — final="${preview(finalRewrite)}"`);

      // Substitute-side guard against pipeline collapse. APPLY or
      // VERIFY occasionally hallucinate a tiny rewrite (e.g.
      // "Tom 😊") for a long body — VERIFY rubber-stamps it as OK
      // and the substitute path then destroys 99% of the content.
      // Refuse the result when the rewrite is dramatically shorter
      // than the target AND the original has substantial content.
      // The 10% threshold + 100-char floor lets legitimate
      // "summarise this in one sentence"-style transforms through
      // (rare; user can retry with more specific instruction).
      if (
        ext.target.length > 100 &&
        finalRewrite.length < ext.target.length * 0.1
      ) {
        this.log(`TransformBlank: BAILING — rewrite collapse (origLen=${ext.target.length}, rewriteLen=${finalRewrite.length}). Likely APPLY/VERIFY hallucination; refusing to substitute.`);
        this.emit({
          type: 'bailed',
          reason: 'rewrite-collapse',
          latencyMs: Date.now() - startTime,
        });
        return { results: [], timing: Date.now() - startTime, model: this.model };
      }

      // Charset-coverage guard for partial translations. The length
      // check above only fires for buffers > 100 chars; this catches
      // the smaller-buffer case where the LLM left source-language
      // characters in the output despite a "translate to <X>"
      // instruction. See docs in transform-partial-detector.ts +
      // tests in transform-partial-detector.test.ts.
      const partial = detectPartialTransform({
        input: ext.target,
        output: finalRewrite,
        taskHint: ext.instruction,
      });
      if (partial.partial) {
        this.log(`TransformBlank: BAILING — partial translation (${partial.reason}). Refusing to substitute; next agent tick will retry.`);
        this.emit({
          type: 'bailed',
          reason: 'partial-translation',
          latencyMs: Date.now() - startTime,
        });
        return { results: [], timing: Date.now() - startTime, model: this.model };
      }

      this.emit({
        type: 'completed',
        finalLen: finalRewrite.length,
        finalPreview: preview(finalRewrite),
        latencyMs: Date.now() - startTime,
      });

      // Build the CueResult. spanStart/spanEnd cover the FULL input
      // region (instruction phrase + target) so the runtime knows to
      // wipe everything and replace with the rewrite. Cycling Up →
      // rewrite. Cycling Down → restore original.
      const result: CueResult = {
        wordIndex: blankIdx,
        word: '_',
        alternatives: [context.text, finalRewrite],
        source: this.id,
        priority: this.priority,
        spanStart: 0,
        spanEnd: context.text.length,
        metadata: {
          transformInstruction: ext.instruction,
          transformTarget: ext.target,
          verifyVerdict: ver.verdict,
        },
      };

      return { results: [result], timing: Date.now() - startTime, model: this.model };
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : String(error),
        timing: Date.now() - startTime,
      };
    }
  }

  private async callLLM(system: string, user: string, maxTokens: number): Promise<string> {
    const built = this.provider.buildRequest(
      {
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens,
        temperature: 0,
        reasoningEffort: 'low',
        seed: 42,
      },
      { apiKey: this.apiKey, endpoint: this.endpoint },
    );
    const response = await this.httpAdapter.post(built.url, built.body, built.headers);
    return this.provider.parseResponse(response);
  }
}
