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
import { useStrictJson, buildJsonResponseFormat, describeLLMCall, dispatchChat, getProvider, type ProviderAdapter } from '../llm-provider';
import { classifyLlmError, findSpanCharRange, type FluidBlankErrorReason } from './fluid-blank-source';
import { VariantCache } from '../variant-cache';
import { detectModelOverride, applySubscriptionPreference, stripModelOverride, type ModelOverride } from '../model-aliases';
import { detectPartialTransform } from './transform-partial-detector';
import { injectCursorSentinel, stripCursorSentinel } from '../cursor-sentinel';
import { translateBufferCursorToTargetCursor } from './transform-cursor-translate';
import {
  renderIdentityContextCatalogForTransform,
  postProcessContext,
  type Identity,
  type ContextMode,
} from '../identity-context';
import {
  renderBlankContextCatalogForTransform,
  mergeCatalogs,
  type BlankContextSnapshot,
  type BlankContextMode,
} from '../blank-context';

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

Bail to NONE for: UI placeholders, pure lookups (no instruction), idioms, and FluidBlank META-TRIGGERS (bare "_", "answer _", "this _", "answer this _", "fill _", "fill in _", "the answer _", "what is the answer _", "what is the question _", "what is the label _") — these are short generic answer-requests where the form-field context (only FluidBlank sees it) carries the question, NOT transform instructions.

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
TARGET:

INPUT: answer this _
VERDICT: NONE
INSTRUCTION:
TARGET:

INPUT: answer _
VERDICT: NONE
INSTRUCTION:
TARGET:

INPUT: fill in _
VERDICT: NONE
INSTRUCTION:
TARGET:

INPUT: what is the answer _
VERDICT: NONE
INSTRUCTION:
TARGET:`;

// P1.5 — DEICTIC RESOLVER
// =============================================================================
// Conditional sub-step between EXTRACT and APPLY. Fires only when the
// instruction contains a deictic reference ("this line", "this word",
// "here", "that", "it", etc.) that needs resolving against the cursor
// position. Most instructions are explicit and skip P1.5 entirely.
//
// Goal: rewrite the instruction so APPLY receives an UNAMBIGUOUS edit
// command. Deictic words get replaced with explicit quoted spans drawn
// from the target around the [CURSOR] marker. Positional cues like
// "here" / "at this point" are LEFT ALONE — APPLY handles those via the
// [CURSOR] marker itself.
//
// Implemented as a separate LLM call (not deterministic string mungery)
// because real user phrasings vary widely: "make those better",
// "shorten it", "fix this bit", "the third bullet", "the one with the
// typo" — many require the same kind of reasoning EXTRACT does to find
// the referent.
//
// Conditional trigger lives in `needsDeicticResolution` below.

/** Returns true when the instruction contains a deictic that P1.5 should
 *  try to resolve. Permissive — false positives only cost one extra LLM
 *  call (P1.5 passes the instruction through unchanged). False negatives
 *  bypass P1.5 entirely, so we err toward triggering. */
export function needsDeicticResolution(instruction: string): boolean {
  return /\b(this|that|these|those|it|them|there)\b/i.test(instruction);
}

export const P1_5_RESOLVE_DEICTICS_SYSTEM = `You receive an editing INSTRUCTION (a short imperative the user typed), a TARGET (the text to edit), and a [CURSOR] marker inside the TARGET showing where the user's caret was.

The INSTRUCTION may contain DEICTIC references — words like "this line", "this word", "this paragraph", "this sentence", "that", "these", "those", "it", "them" — that point at specific spans in the TARGET. Your job is to rewrite the INSTRUCTION with those references RESOLVED into explicit, quoted spans, so a downstream editor reads the instruction unambiguously.

Output exactly one line, nothing else:
RESOLVED: <rewritten instruction>

RULES:
1. Preserve the verb and intent. ONLY resolve deictic references — do NOT perform the edit.
2. Use the [CURSOR] location to find what each deictic refers to:
   - "this line" / "the line" → \`the line "<line text containing cursor>"\`
   - "this word" / "the word" → \`the word "<word containing cursor>"\`
   - "this sentence" → \`the sentence "<sentence containing cursor>"\`
   - "this paragraph" → \`the paragraph "<paragraph containing cursor>"\`
   - "it" / "this" / "that" (standalone) → resolve to the smallest containing span (word > sentence > paragraph) based on what the verb implies
   - "these"/"those" + plural noun → resolve to the relevant set, listed as a quoted comma-joined string
3. Words like "here", "at this point", "right here" are POSITIONAL anchors — leave them UNCHANGED. The downstream APPLY pass uses the [CURSOR] marker for those.
4. IDIOMATIC "it" in "make it X" / "make it Y" patterns is NOT deictic — it's a fixed English construction meaning "transform the whole thing". Examples: "make it british english", "make it past tense", "make it shorter", "make it a question", "make it formal", "make it caps". In these patterns, OUTPUT THE INSTRUCTION UNCHANGED. The "it" refers to the entire target, not a specific span.
5. If the instruction contains NO resolvable deictic references, output it UNCHANGED.
6. Do NOT include [CURSOR] in your output.
7. Do NOT add extra commentary or explanations — only the rewritten instruction.

EXAMPLES:

INSTRUCTION: make this line bold
TARGET: hi
Dear Karen,[CURSOR]
best regards
RESOLVED: make the line "Dear Karen," bold

INSTRUCTION: capitalize this word
TARGET: hello wil[CURSOR]fred world
RESOLVED: capitalize the word "wilfred"

INSTRUCTION: make this paragraph italic
TARGET: title

The meeting starts at 3pm sharp.[CURSOR] We will cover budget and roadmap.

footer
RESOLVED: make the paragraph "The meeting starts at 3pm sharp. We will cover budget and roadmap." italic

INSTRUCTION: rephrase this sentence
TARGET: I went to the store yesterday. I bought[CURSOR] some apples. They were red.
RESOLVED: rephrase the sentence "I bought some apples."

INSTRUCTION: shorten it
TARGET: Dear hiring manager, I am writing to express my strong[CURSOR] interest in the role of Senior Engineer at your company.
RESOLVED: shorten the sentence "Dear hiring manager, I am writing to express my strong interest in the role of Senior Engineer at your company."

INSTRUCTION: bold the word wilfred
TARGET: hi my name is wilfred
RESOLVED: bold the word wilfred

INSTRUCTION: add a comma here
TARGET: apples bananas[CURSOR] and oranges
RESOLVED: add a comma here

INSTRUCTION: insert a paragraph break here
TARGET: hello world[CURSOR] and goodbye world
RESOLVED: insert a paragraph break here

INSTRUCTION: capitalize all words
TARGET: the quick[CURSOR] brown fox
RESOLVED: capitalize all words

INSTRUCTION: fix this typo
TARGET: helo wrl[CURSOR]d and bye
RESOLVED: fix the typo in the word "wrld"

INSTRUCTION: make it british english
TARGET: the color of the harbor is gray[CURSOR]
RESOLVED: make it british english

INSTRUCTION: make it past tense
TARGET: I run to the store[CURSOR] every day
RESOLVED: make it past tense

INSTRUCTION: make it shorter
TARGET: A long sentence with extra words[CURSOR] that goes on
RESOLVED: make it shorter

INSTRUCTION: make it a question
TARGET: The meeting is at 3pm.[CURSOR]
RESOLVED: make it a question`;

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

10. CURSOR ANCHOR — the TARGET may contain a [CURSOR] marker showing where the user's caret was when they triggered the transform. If the INSTRUCTION is POSITIONAL — it uses any of these positional cues — apply the edit AT the [CURSOR] location:

    - "here", "at this point", "right here", "in this spot"
    - "add X", "insert X", "put X"
    - "split here", "break here", "move here"
    - "before this", "after this", "this line", "this paragraph", "this sentence", "this word"
    - "new line here", "line break here", "paragraph break here", "new paragraph here"
    - "next line", "previous line" (relative to [CURSOR])

    For positional break/insert instructions specifically:
    - "add a line break here" / "new line here" → insert "\\n" at [CURSOR]
    - "add a paragraph break here" / "new paragraph here" → insert "\\n\\n" at [CURSOR]
    - "split this paragraph here" → insert "\\n\\n" at [CURSOR]
    - "insert <text> here" → insert <text> at [CURSOR]

    The REST OF THE TARGET — both halves around the [CURSOR] — must be preserved verbatim. Do NOT shorten, summarise, or rewrite the surrounding text; only the [CURSOR] position changes.

    For non-positional INSTRUCTIONs (translate, capitalise, fix typos, make shorter, rephrase, summarise, etc.), IGNORE the [CURSOR] marker — treat the target as if it weren't there.

    ALWAYS strip the [CURSOR] marker from your output regardless. Never emit the literal string [CURSOR] in the REWRITE.

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

12. ADDITION / INSERTION instructions — when the INSTRUCTION uses verbs like "add", "insert", "append", "prepend", "include", "fill", "fill in", "set", "put", "write" (as in "write X for the Y"), "type", "enter", or colloquial variants ("stick X in", "throw X in", "chuck in X", "pop in X", "slip in X", "drop X in" / "drop X before Y" / "drop X after Y"), the action is to ADD content to the TARGET, not transform it. Emit the rewritten target containing the new content.

    Verb-disambiguation note — "drop" is ambiguous: "drop X" alone means DELETE X (rule applies elsewhere); but "drop X in", "drop X into", "drop X before/after Y", or "drop X here" means INSERT X. The preposition decides.

    Handle these patterns:

    (a) FILL PLACEHOLDER — when the TARGET contains bracketed/templated placeholders (e.g. \`[Your Name]\`, \`[Manager's Name]\`, \`[Manager's Name]\`, \`[Company]\`, \`[Date]\`, \`[Position]\`, \`[Your Position]\`, \`[Last Day]\`, \`[Your Address]\`, \`[xxx]\`, \`xxx\`, etc.) AND the INSTRUCTION supplies a value that semantically matches one of them (e.g. "add my name Wilfred", "add company CS Limited", "add last day 31st June 2026", "add position Engineer", "set manager Karen"), FIND the matching placeholder and REPLACE it with the value. Keep every OTHER placeholder and the surrounding text VERBATIM. Match by keyword overlap: "name" → \`[Your Name]\`, "manager" / "manager's name" / "boss" → \`[Manager's Name]\`, "position" / "role" / "title" → \`[Your Position]\` / \`[Your Role]\`, "company" / "employer" → \`[Company]\`, "last day" / "end date" / "leaving date" → \`[Last Working Day]\` / \`[Date]\`, "address" → \`[Your Address]\`. If the instruction itself names the field unambiguously (e.g. "add my name Wilfred"), the value to insert is the trailing tokens (everything after the field-name).

    (b) ANCHORED INSERT — "add X after Y" / "add X before Y" / "add X to the Y line" / "add X after the dear line" → find Y in the target, insert X at the right position relative to it.

    (c) CURSOR INSERT — "add X" with a [CURSOR] in the target and no clear placeholder match → insert X at [CURSOR]. Surrounding text preserved verbatim.

    (d) APPEND — "add X" with no anchor, no placeholder match, no useful cursor info → append X to the end of the target on a new line.

    (e) AUTO STYLING — "add bolding where appropriate" / "make bold the bits necessary" / "italicise key terms" / "highlight important words" → identify spans the reader's eye should land on (proper nouns, names, dates, titles, key phrases) and wrap them in the requested markdown markers (\`**...**\` for bold, \`*...*\` for italic). PICK reasonable spans — do not refuse on the grounds that "appropriate" is subjective. Aim for 2-5 emphasised spans per paragraph at most.

    NEVER return an empty REWRITE for an "add X" instruction. If no placeholder matches and no cursor anchor is available, fall back to APPEND. The user expects something to happen.

    EXAMPLES:
      INSTRUCTION: add my name Wilfred
      TARGET: Dear [Manager's Name],\\n\\nI am writing from [Your Address]. Sincerely,\\n[Your Name]
      REWRITE: Dear [Manager's Name],\\n\\nI am writing from [Your Address]. Sincerely,\\nWilfred

      INSTRUCTION: add company CS Limited
      TARGET: Dear Karen,\\n\\nI am writing on behalf of [Company]. Regards.
      REWRITE: Dear Karen,\\n\\nI am writing on behalf of CS Limited. Regards.

      INSTRUCTION: add last working day 31st June 2026
      TARGET: My last working day will be [Last Working Day]. Thank you.
      REWRITE: My last working day will be 31st June 2026. Thank you.

      INSTRUCTION: add position Senior Engineer
      TARGET: I am writing to resign from my role as [Your Position] at the company.
      REWRITE: I am writing to resign from my role as Senior Engineer at the company.

      INSTRUCTION: add a joke after dear line
      TARGET: Dear Karen,\\n\\nI hope you are well.
      REWRITE: Dear Karen,\\n\\n(Why did the manager bring a ladder to work? To reach new heights.)\\n\\nI hope you are well.

      INSTRUCTION: add bolding where appropriate
      TARGET: Dear Karen,\\n\\nI am writing to formally resign from my position as Senior Engineer at CS Limited. My last day will be 31st June 2026.\\n\\nBest regards,\\nWilfred
      REWRITE: Dear **Karen**,\\n\\nI am writing to formally resign from my position as **Senior Engineer** at **CS Limited**. My last day will be **31st June 2026**.\\n\\nBest regards,\\n**Wilfred**

      INSTRUCTION: make bold the bits necessary
      TARGET: This document contains private information about Acme Corp and is confidential.
      REWRITE: This document contains **private information** about **Acme Corp** and is **confidential**.

      INSTRUCTION: drop "Best regards" before the name
      TARGET: Body text.\\n\\nWilfred
      REWRITE: Body text.\\n\\nBest regards\\nWilfred

      INSTRUCTION: chuck in the date 2026-06-30
      TARGET: The deadline is [Date].
      REWRITE: The deadline is 2026-06-30.

      INSTRUCTION: stick my name Wilfred in
      TARGET: Sincerely,\\n[Your Name]
      REWRITE: Sincerely,\\nWilfred

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
- oranges

INSTRUCTION: add a line break here
TARGET: hi my name is wilfred[CURSOR] and I work on opencues
REWRITE: hi my name is wilfred
 and I work on opencues

INSTRUCTION: new line here
TARGET: first sentence.[CURSOR] second sentence.
REWRITE: first sentence.
 second sentence.

INSTRUCTION: add a paragraph break here
TARGET: hi my name is wilfred[CURSOR] and I work on opencues
REWRITE: hi my name is wilfred

and I work on opencues

INSTRUCTION: split this paragraph here
TARGET: The meeting starts at 3pm.[CURSOR] We will cover budget and roadmap.
REWRITE: The meeting starts at 3pm.

We will cover budget and roadmap.

INSTRUCTION: insert a comma here
TARGET: I bought apples bananas[CURSOR] and oranges
REWRITE: I bought apples bananas, and oranges

INSTRUCTION: add "TODO" on this line
TARGET: review the PR[CURSOR] before lunch
REWRITE: review the PR TODO before lunch

INSTRUCTION: bold this word
TARGET: hii my name is[CURSOR]wilfred
REWRITE: hii my name is **wilfred**`;

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
// FUSED system prompt — replaces P1 EXTRACT + P2 APPLY with one LLM call
// ============================================================================
//
// Single-call replacement that emits VERDICT + INSTRUCTION + TARGET + REWRITE
// in one shot. Used on capable-generalist providers (cerebras, gemini, claude,
// openai) where the model can hold the full decompose+rewrite task in one
// breath. Groq's gpt-oss-120b collapses to ~18% in single-call mode (it can't
// juggle), so groq stays on the 3-pass pipeline — see `pickTransformBlankMode`
// in this file. Benchmark evidence: tests/benchmarks/transform-blank/
// EXPERIMENTS.md § Experiments 6-8.
//
// Verdict types match the 3-pass extract — TRANSFORM/NONE/TASK_*/GENERATIVE
// (the GENERATIVE branch is signalled by VERDICT=TRANSFORM with empty TARGET).
// For TRANSFORM cases the model produces the rewritten target in REWRITE in
// the same call; downstream code uses REWRITE directly, skipping APPLY +
// VERIFY entirely (verify net-hurts on every non-groq provider per
// Experiment 6).
const FUSED_SYSTEM = `Read the input and produce a structured edit result.

The input is a sentence with an underscore (_) signalling either an IMPERATIVE INSTRUCTION the user wants applied to surrounding text, OR a command to manage a continuously-running agent task, OR a lookup placeholder (none of those).

Output exactly five labelled lines (REWRITE may span multiple lines):
VERDICT: TRANSFORM | NONE | TASK_ARM | TASK_ADD | TASK_STOP | TASK_SHOW
INSTRUCTION: <the imperative phrase OR task prompt, _ removed; or empty>
TARGET: <the rest of the input after removing instruction + _; or empty>
SPAN: <the verbatim substring of INPUT that constitutes the transform region: INSTRUCTION + _ + TARGET, in input order. When the user typed UNRELATED prior content before the imperative (e.g. "hii world. uppercase the brands _ i bought apple"), SPAN starts at the first character of INSTRUCTION-or-TARGET (whichever is leftmost) — NOT at the start of the input. When the whole input IS INSTRUCTION + _ + TARGET, SPAN equals the whole input. Empty when VERDICT is NONE.>
REWRITE: <the REPLACEMENT for SPAN: the post-transform TARGET with INSTRUCTION + _ stripped. Contains ONLY the slice that replaces SPAN — NEVER repeat any text from before SPAN (prior content is preserved by the runtime, not by you). Empty when VERDICT is NONE / TASK_*>

LAYOUTS — the instruction sits IMMEDIATELY before _. Three valid:
  - <INSTRUCTION> _ <TARGET>
  - <TARGET> <INSTRUCTION> _
  - <TARGET-PT1> <INSTRUCTION> _ <TARGET-PT2>  (SANDWICHED — both halves form TARGET, joined by single newline in original order. FULL_REWRITE preserves the original paragraph break(s) — the sandwich's blank LINE where the trigger sat survives as a blank line in the output.)

COMPOSED INSTRUCTIONS (two distinct edits joined by "and") — pipe-join in INSTRUCTION, apply BOTH in FULL_REWRITE simultaneously: "make past tense and remove pronouns" → INSTRUCTION: make past tense | remove pronouns. Don't split single edits ("change boy to girl", "make it formal").

NONE rules — bail when ANY apply:
- _ is a UI placeholder ("click _ to continue")
- pure lookup, no instruction ("capital of france _")
- instruction-shaped phrase but no target ("I need to change boy to girl in this story _")
- idiom that looks like an instruction but isn't ("change of plans _ we meet at 3pm")
- META-TRIGGER for FluidBlank to answer using ambient context — bail to NONE when the ENTIRE input is a short generic answer-request with no real content to transform. Patterns: bare "_", "answer _", "this _", "answer this _", "fill _", "fill in _", "the answer _", "what is the answer _", "what is the question _", "what is the label _". These have no TARGET text — the user is signalling that the surrounding FORM FIELD (which only FluidBlank sees) carries the question. Don't fabricate a conversational response.

GENERATIVE — when the imperative asks to CREATE/GENERATE ("write a poem", "compose an email", "give me 5 startup ideas"), VERDICT=TRANSFORM, TARGET is empty, FULL_REWRITE contains the generated content.

AGENT TASK COMMANDS — FULL_REWRITE empty for all of these:
- TASK_ARM: input has "agentically <X>" → INSTRUCTION = X (without "agentically").
- TASK_ADD: input has "add task <X>" → INSTRUCTION = X.
- TASK_STOP: input is "stop task _" → INSTRUCTION empty.
- TASK_SHOW: input is "current task _" → INSTRUCTION empty.

APPLY RULES when VERDICT=TRANSFORM with non-empty TARGET:
1. Apply the instruction to ALL applicable spans, not just the first.
2. Preserve everything not targeted (other words, punctuation, casing, paragraph breaks \\n\\n).
3. CONCEPT-SWAP PROPAGATION — when the instruction names a CATEGORY (pet, vehicle, profession, era, setting, sport), propagate dependent vocabulary: cats meow not bark; cars use seatbelts not helmets. MINIMAL EDIT — only change words that become wrong; keep neutral verbs.
4. ENVIRONMENT-BOUND VERBS flip when the setting changes (water doesn't burn — it cools).
5. LITERAL swaps ("change boy to girl") swap only those tokens; CATEGORY swaps ("change pet from dog to cat") propagate.
6. ROLE PRESERVATION — "add 10%" to "original price 100, final price 100" only changes FINAL → 110.
7. CONDITIONAL — apply ONLY where the condition holds ("change boy to girl but not in second sentence").
8. PRESERVE PARAGRAPHS — \\n\\n breaks survive verbatim.
9. REWRITE contains ONLY the slice that replaces SPAN — the post-transform TARGET, with INSTRUCTION + _ already deleted. NEVER repeat any text from BEFORE SPAN in the input; the runtime preserves prior content verbatim and splices REWRITE into SPAN's range.
10. SPAN must be a verbatim contiguous substring of INPUT covering both INSTRUCTION and TARGET and the _ between/after them. The PRIOR-CONTENT exclusion only applies when there is a clear sentence-or-topic boundary (period, newline, semicolon) between prior content and the imperative — e.g. "draft email. uppercase the brands _ apple" → SPAN starts at "uppercase". WITHOUT such a boundary, all preceding content IS the target and is part of SPAN — e.g. "i bought apple uppercase the brands _" → SPAN is the WHOLE input. Default to SPAN-equals-whole-input when in doubt; the prior-content carve-out is the EXCEPTION, not the rule.

EXAMPLES:

INPUT: change boy to girl _ the boy ran fast
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl
TARGET: the boy ran fast
SPAN: change boy to girl _ the boy ran fast
REWRITE: the girl ran fast

INPUT: he/she swap _ he gave the book to John
VERDICT: TRANSFORM
INSTRUCTION: he/she swap
TARGET: he gave the book to John
SPAN: he/she swap _ he gave the book to John
REWRITE: she gave the book to John

INPUT: make it british english _ the color of the harbor is gray
VERDICT: TRANSFORM
INSTRUCTION: make it british english
TARGET: the color of the harbor is gray
SPAN: make it british english _ the color of the harbor is gray
REWRITE: the colour of the harbour is grey

INPUT: pluralize _ the child found one mouse
VERDICT: TRANSFORM
INSTRUCTION: pluralize
TARGET: the child found one mouse
SPAN: pluralize _ the child found one mouse
REWRITE: the children found mice

INPUT: change pet from dog to cat _ the dog wagged its tail and barked at the postman
VERDICT: TRANSFORM
INSTRUCTION: change pet from dog to cat
TARGET: the dog wagged its tail and barked at the postman
SPAN: change pet from dog to cat _ the dog wagged its tail and barked at the postman
REWRITE: the cat swished its tail and meowed at the postman

INPUT: i bought apple and samsung phones online uppercase the brands _
VERDICT: TRANSFORM
INSTRUCTION: uppercase the brands
TARGET: i bought apple and samsung phones online
SPAN: i bought apple and samsung phones online uppercase the brands _
REWRITE: i bought APPLE and SAMSUNG phones online

INPUT: pluralize and make past tense _ the child runs to the park
VERDICT: TRANSFORM
INSTRUCTION: pluralize | make past tense
TARGET: the child runs to the park
SPAN: pluralize and make past tense _ the child runs to the park
REWRITE: the children ran to the parks

INPUT: write a poem about the sea _
VERDICT: TRANSFORM
INSTRUCTION: write a poem about the sea
TARGET:
SPAN: write a poem about the sea _
REWRITE: Waves whisper to the shore, / endless rhythm, salt-bright air, / the sea holds every story.

INPUT: hii world. uppercase the brands _ i bought apple and samsung phones
VERDICT: TRANSFORM
INSTRUCTION: uppercase the brands
TARGET: i bought apple and samsung phones
SPAN: uppercase the brands _ i bought apple and samsung phones
REWRITE: i bought APPLE and SAMSUNG phones

INPUT: hi my name is wilfred make it caps _
VERDICT: TRANSFORM
INSTRUCTION: make it caps
TARGET: hi my name is wilfred
SPAN: hi my name is wilfred make it caps _
REWRITE: HI MY NAME IS WILFRED

INPUT: hi my name is **wilfred** make it caps _
VERDICT: TRANSFORM
INSTRUCTION: make it caps
TARGET: hi my name is **wilfred**
SPAN: hi my name is **wilfred** make it caps _
REWRITE: HI MY NAME IS **WILFRED**

INPUT: meeting at 3pm. translate hello world to french _
VERDICT: TRANSFORM
INSTRUCTION: translate hello world to french
TARGET:
SPAN: translate hello world to french _
REWRITE: bonjour le monde

INPUT: notes for monday. make this a question _ the meeting is at 3pm
VERDICT: TRANSFORM
INSTRUCTION: make this a question
TARGET: the meeting is at 3pm
SPAN: make this a question _ the meeting is at 3pm
REWRITE: is the meeting at 3pm?

INPUT: agentically correct spelling _
VERDICT: TASK_ARM
INSTRUCTION: correct spelling
TARGET:
SPAN: agentically correct spelling _
REWRITE:

INPUT: capital of france _
VERDICT: NONE
INSTRUCTION:
TARGET:
SPAN:
REWRITE:

INPUT: click _ to continue
VERDICT: NONE
INSTRUCTION:
TARGET:
SPAN:
REWRITE:

INPUT: answer this _
VERDICT: NONE
INSTRUCTION:
TARGET:
SPAN:
REWRITE:

INPUT: answer _
VERDICT: NONE
INSTRUCTION:
TARGET:
SPAN:
REWRITE:

INPUT: fill in _
VERDICT: NONE
INSTRUCTION:
TARGET:
SPAN:
REWRITE:

INPUT: what is the answer _
VERDICT: NONE
INSTRUCTION:
TARGET:
SPAN:
REWRITE:`;

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

interface FusedResult {
  verdict: ExtractVerdict;
  instruction: string;
  target: string;
  /** Verbatim substring of the input the LLM claims its REWRITE
   *  replaces (INSTRUCTION + _ + TARGET in input order). Used by
   *  the runtime to derive the splice range — anything BEFORE
   *  SPAN's start in the buffer is preserved verbatim. Empty
   *  on NONE / TASK_* verdicts (no slice to splice). */
  span: string;
  rewrite: string;
}

/**
 * Parser for the fused-mode output (`FUSED_SYSTEM` prompt). Same shape as
 * parseExtract but with extra SPAN + REWRITE fields. SPAN is single-line
 * (lives between TARGET and REWRITE). REWRITE is multi-line-tolerant
 * (poems, translations, long-form generation) and is the last field.
 */
function parseFused(raw: string): FusedResult {
  const verdictMatch = raw.match(/^VERDICT:[ \t]*(TRANSFORM|NONE|TASK_ARM|TASK_ADD|TASK_STOP|TASK_SHOW)[ \t]*$/im);
  const instructionMatch = raw.match(/^INSTRUCTION:[ \t]*(.*?)[ \t]*$/im);
  // TARGET may span multiple lines but stops at the SPAN: / FULL_REWRITE: /
  // REWRITE: label via lookahead. (FULL_REWRITE accepted for back-compat
  // with the pre-June-2026 whole-buffer prompt — a model that hasn't
  // learnt the new SPAN+slice shape will fall through to whole-buffer
  // via the empty-SPAN path below.)
  const targetMatch = raw.match(/TARGET:[ \t]*([\s\S]*?)(?=^SPAN:|^(?:FULL_)?REWRITE:|\s*$)/im);
  // SPAN is a single-line verbatim substring of input.
  const spanMatch = raw.match(/^SPAN:[ \t]*(.*?)[ \t]*$/im);
  // REWRITE is the last field — capture to end of output. Accept
  // FULL_REWRITE: too for the pre-June-2026 whole-buffer prompt shape
  // (back-compat with models that haven't learnt the new contract).
  const rewriteMatch = raw.match(/(?:FULL_)?REWRITE:[ \t]*([\s\S]*?)\s*$/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'NONE') as ExtractVerdict;
  return {
    verdict,
    instruction: instructionMatch ? instructionMatch[1].trim() : '',
    target: targetMatch ? targetMatch[1].trim() : '',
    span: spanMatch ? spanMatch[1].trim() : '',
    rewrite: rewriteMatch ? rewriteMatch[1].trim() : '',
  };
}

// ============================================================================
// Structured-output schemas — strict mode for groq gpt-oss
// ============================================================================
//
// When the resolved provider is groq AND the model is gpt-oss-{20b,120b},
// the call sets `response_format: { type: 'json_schema', strict: true }`
// with these schemas. Constrained decoding guarantees the output matches.
// Other providers (or other models on groq) keep the label-based prompt
// + regex parsing path.

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['TRANSFORM', 'NONE', 'TASK_ARM', 'TASK_ADD', 'TASK_STOP', 'TASK_SHOW'],
    },
    instruction: { type: 'string' },
    target: { type: 'string' },
  },
  required: ['verdict', 'instruction', 'target'],
  additionalProperties: false,
} as const;

const RESOLVE_SCHEMA = {
  type: 'object',
  properties: { resolved: { type: 'string' } },
  required: ['resolved'],
  additionalProperties: false,
} as const;

const APPLY_SCHEMA = {
  type: 'object',
  properties: { rewrite: { type: 'string' } },
  required: ['rewrite'],
  additionalProperties: false,
} as const;

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['OK', 'REPAIR'] },
    rewrite: { type: 'string' },
  },
  required: ['verdict', 'rewrite'],
  additionalProperties: false,
} as const;

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
  if (m) return { rewrite: m[1].trim() };

  // Tolerance: some long-output cases (multi-paragraph add-X, joke
  // insertions, etc.) come back WITHOUT the REWRITE: prefix — the model
  // emits the full rewrite directly. Treat the whole output as the
  // rewrite, but only if it doesn't look like a refusal or commentary.
  const trimmed = raw.trim();
  if (!trimmed) return { rewrite: '' };
  // Heuristic: refusals / commentary tend to start with "I can't",
  // "Sorry", "As an AI", "Here is", "Output:", or have markdown
  // headers. Real rewrites typically start with target content.
  if (/^(i (can\u2019t|cannot|can't)|sorry|as an ai|here is|here'?s|note:|output:)/i.test(trimmed)) {
    return { rewrite: '' };
  }
  return { rewrite: trimmed };
}

function parseVerify(raw: string): VerifyResult {
  const verdictMatch = raw.match(/^VERDICT:[ \t]*(OK|REPAIR)[ \t]*$/im);
  const rewriteMatch = raw.match(/REWRITE:[ \t]*([\s\S]*?)\s*$/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'OK') as 'OK' | 'REPAIR';
  return { verdict, rewrite: rewriteMatch ? rewriteMatch[1].trim() : '' };
}

// ── JSON variants (strict mode on groq gpt-oss) ────────────────────────────
//
// In strict mode the model returns valid JSON conforming to the schema —
// no preamble, no markdown fences, no missing fields. These parsers are
// the JSON equivalents of the regex parsers above. Failure modes (rare
// in strict mode but possible at API level) fall back to empty results
// rather than throwing.

function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw.trim());
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseExtractJson(raw: string): ExtractResult {
  const obj = safeJsonParse(raw);
  if (!obj) return { verdict: 'NONE', instruction: '', target: '' };
  const verdict = typeof obj.verdict === 'string' ? (obj.verdict as ExtractVerdict) : 'NONE';
  return {
    verdict,
    instruction: typeof obj.instruction === 'string' ? obj.instruction.trim() : '',
    target: typeof obj.target === 'string' ? obj.target.trim() : '',
  };
}

function parseResolveJson(raw: string): string {
  const obj = safeJsonParse(raw);
  if (!obj || typeof obj.resolved !== 'string') return '';
  return obj.resolved.trim();
}

function parseApplyJson(raw: string): ApplyResult {
  const obj = safeJsonParse(raw);
  if (!obj || typeof obj.rewrite !== 'string') return { rewrite: '' };
  return { rewrite: obj.rewrite.trim() };
}

function parseVerifyJson(raw: string): VerifyResult {
  const obj = safeJsonParse(raw);
  if (!obj) return { verdict: 'OK', rewrite: '' };
  const verdict = (obj.verdict === 'REPAIR' ? 'REPAIR' : 'OK') as 'OK' | 'REPAIR';
  return {
    verdict,
    rewrite: typeof obj.rewrite === 'string' ? obj.rewrite.trim() : '',
  };
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
  // REASONING_HEADROOM was 400; empirically `reasoning_effort: 'low'`
  // on this model uses 500-800 tokens of reasoning before emitting
  // the first output token. At 400 a ~700-char APPLY target ran out
  // of budget mid-reasoning, never emitted the REWRITE: prefix, and
  // production saw an empty output → FluidBlank cascade. Bumped to
  // 700 to match observed model behaviour. Formula stays dynamic —
  // larger targets still scale up linearly with chars × multiplier.
  // See /tmp/probe-700.ts (5/5 at max_tokens=2048) and the
  // 2026-05 resignation-letter failure in /tmp/opencues.log.
  const REASONING_HEADROOM = 700;
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
  | { type: 'started'; textLen: number; blankIdx: number; llm: string; mode: string; modelOverride?: { provider: string; model: string; token: string } }
  /** One pipeline pass completed. P1 = EXTRACT, P2 = APPLY (one or more
   *  steps), P3 = VERIFY. P1 carries the verdict + extracted instruction;
   *  P2 carries step / totalSteps; P3 carries the verify verdict. */
  | { type: 'pass-completed'; pass: 'P1' | 'P2' | 'P3'; latencyMs: number;
      verdict?: string; instruction?: string; target?: string;
      step?: number; totalSteps?: number;
      /** EXTRACT/FUSED input precedence — 'rich-text' when markdown
       *  markers were re-injected from MarkdownRender's cache,
       *  'as-typed' when the agent-revert path applied, 'visible'
       *  otherwise. Only set on P1 (the input-bearing pass). Used by
       *  agentic tests to assert the right input path was exercised. */
      source?: 'rich-text' | 'as-typed' | 'visible' }
  /** Pipeline bailed early. `reason` is a stable kebab-case identifier
   *  (P1-verdict-none-or-empty, P2-empty-result, etc.). */
  | { type: 'bailed'; reason: string; latencyMs: number };

// NOTE: `transform-blank.completed` is fired by the RESOLVER from its
// substitute branch (resolver.ts isTransformBlank path), AFTER setText
// commits the new buffer. It is NOT emitted from this source. This
// keeps the public event semantically tied to "user-visible buffer is
// now the final rewrite" — observers (tests / statusline) never catch
// a loading-animation intermediate state between source-return and
// resolver-substitute. The event body shape is
// `{ finalLen, finalPreview, latencyMs }` — the latency rides through
// the CueResult's `metadata.pipelineLatencyMs`.

export interface TransformBlankSourceConfig {
  httpAdapter: HttpAdapter;
  provider: ProviderAdapter;
  endpoint: string;
  apiKey: string;
  model: string;
  /**
   * Optional full apiKey map keyed by provider id. When present, the
   * source can dispatch a single in-flight call through a non-default
   * provider when a `with <model>` override token is detected in the
   * buffer. Mirrors `FluidBlankSourceConfig.apiKeys`; see
   * model-aliases.ts for resolution rules and the trust contract.
   */
  apiKeys?: Readonly<Record<string, string | undefined>>;
  /** Per-feature max-tokens override (`transform-blank-max-tokens:`).
   *  When set, ALL passes (3-pass EXTRACT/APPLY/VERIFY + FUSED) use
   *  it as the max instead of the per-pass bench-tuned defaults.
   *  Useful for very-long-buffer rewrites that exceed the defaults. */
  maxTokens?: number;
  /** Per-feature temperature override (`transform-blank-temperature:`).
   *  Falls back to 0 (deterministic rewrites) when absent. */
  temperature?: number;
  /** OPENCUES.md `max-thinking` toggle (default on). Threaded into the
   *  dispatch ctx so model-thinking.ts resolves the reasoning ceiling vs
   *  reduced level for every pass (EXTRACT/APPLY/VERIFY/REPAIR/FUSED). */
  maxThinking?: boolean;
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
  /**
   * Pipeline mode:
   *   - `'3-pass'` — EXTRACT → APPLY → VERIFY. Maximum accuracy on groq's
   *     gpt-oss-120b (~91% on the benchmark suite). The default for groq.
   *   - `'fused'` — single LLM call emits VERDICT + INSTRUCTION + TARGET +
   *     REWRITE together. ~1.8-3× lower latency on capable generalist
   *     models (cerebras, gemini, claude, openai). The default for those.
   *   - `'auto'` (or omitted) — picks per provider via
   *     `pickTransformBlankMode()`: groq → 3-pass; everyone else → fused.
   *
   * Set via the `transform-blank-mode:` OPENCUES.md frontmatter; passed
   * through build-sources to here. Benchmark evidence:
   * `tests/benchmarks/transform-blank/EXPERIMENTS.md § 6-8`.
   */
  mode?: TransformBlankMode;
  /**
   * When set, user-actionable HTTP failures (401, 404, 429, 400, network,
   * model-not-found, insufficient-credits) emit an inline `_` → error
   * substitute instead of silently failing. Wire the same formatter
   * FluidBlank uses (`nativeHostFormatLLMError` from boot-common.ts) so
   * every blank-triggered LLM source produces the same visible error
   * surface — the user always knows WHY their `_` didn't fire. Omit to
   * preserve silent-fail behaviour (legacy default for back-compat with
   * tests + chrome).
   */
  formatErrorAsSubstitute?: (reason: FluidBlankErrorReason, err?: Error) => string;
}

export type TransformBlankMode = 'auto' | '3-pass' | 'fused';

/**
 * Resolve the auto-route mode based on provider. Capable generalists
 * (cerebras, gemini, claude, openai) handle the full decompose+rewrite
 * task in one call cleanly; groq's gpt-oss-120b collapses on the wide
 * single-call task (~18% on benchmark), so groq stays multi-pass.
 *
 * Override via `transform-blank-mode: fused|3-pass` to force a mode
 * regardless of provider — useful for A/B testing or for a future
 * provider that's known to need the other shape.
 */
export function pickTransformBlankMode(
  providerId: string,
  configMode: TransformBlankMode | string | undefined,
): '3-pass' | 'fused' {
  if (configMode === '3-pass' || configMode === 'fused') return configMode;
  // 'auto' or unset: groq → 3-pass; everyone else → fused.
  return providerId === 'groq' ? '3-pass' : 'fused';
}

export class TransformBlankSource implements CueSource {
  readonly id = 'transform-blank';
  readonly priority: number;
  /** Transform-blank rewrites the buffer with a single LLM answer —
   *  no cycling. Universal-compatible. */
  readonly isCycleable = false;

  private httpAdapter: HttpAdapter;
  private provider: ProviderAdapter;
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private apiKeys: Readonly<Record<string, string | undefined>>;
  /**
   * Per-call model-alias override resolved at the top of getCues and
   * cleared in the finally block. Read by callLLM so the multiple
   * downstream pass invocations (3-pass EXTRACT/APPLY/VERIFY/REPAIR +
   * FUSED) all route through the same override without each having to
   * thread the parameter. Safe because getCues is awaited as a single
   * promise per resolve generation (the resolver aborts the old before
   * the next one starts; sibling-abort and HTTP-level abort honour the
   * signal). Not async-context-tracked — concurrent calls on the same
   * instance would race, but that doesn't happen under normal resolver
   * orchestration.
   */
  private _currentOverride: { provider: ProviderAdapter; model: string; apiKey: string } | null = null;
  /**
   * Per-input variant cache. Value is `{rewrite, span}` because the
   * runtime needs both to replay the splice on a cache hit: the
   * rewrite fills SPAN, found via `findSpanCharRange` against the
   * (still-identical) buffer text.
   *
   * State machine, LRU, cycling, FIFO eviction — all live in the
   * shared `VariantCache` primitive (`@opencues/core/variant-cache.ts`).
   * FluidBlank + ConfigIntent use the same primitive with simpler
   * value types.
   */
  private static _variantCache = new VariantCache<{ rewrite: string; span: string }>();
  private maxTokensOverride: number | undefined;
  private temperatureOverride: number | undefined;
  private maxThinking: boolean;
  private blanks: Record<string, BlankConfig>;
  private log: (msg: string) => void;
  private emit: (event: TransformBlankEvent) => void;
  private mode: '3-pass' | 'fused';
  private formatErrorAsSubstitute: ((reason: FluidBlankErrorReason, err?: Error) => string) | undefined;

  constructor(config: TransformBlankSourceConfig) {
    this.httpAdapter = config.httpAdapter;
    this.provider = config.provider;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiKeys = config.apiKeys ?? {};
    this.maxTokensOverride = config.maxTokens;
    this.temperatureOverride = config.temperature;
    this.maxThinking = config.maxThinking ?? true;
    this.priority = config.priority ?? 93;
    this.blanks = config.blanks ?? {};
    this.log = config.log ?? (() => { /* default: silent */ });
    this.emit = config.onEvent ?? (() => { /* default: silent */ });
    this.formatErrorAsSubstitute = config.formatErrorAsSubstitute;
    // Resolve mode once at construction — provider doesn't change during
    // the source's lifetime, and runtime callers can rebuild the source
    // if the user flips `llm-provider:` mid-session.
    this.mode = pickTransformBlankMode(this.provider.id, config.mode);
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

  /**
   * Build the IDENTITY.md catalog block to append to APPLY / GENERATIVE /
   * FUSED prompts. Returns empty string + undefined ctx when
   * `identity-context-mode: off` (or the runtime didn't populate
   * identity context for any reason). Off mode is the structural no-op —
   * APPLY prompts revert to their pre-Phase-2 shape verbatim.
   */
  private buildUserCatalogBlock(context: CueContext): {
    block: string;
    ctx: Identity | undefined;
  } {
    const uc = context.identityContext;
    if (!uc) return { block: '', ctx: undefined };
    const ctx: Identity = { fields: uc.fields, catalog: uc.catalog };
    const mode: ContextMode = uc.mode;
    const block = renderIdentityContextCatalogForTransform(ctx, mode);
    if (block) {
      this.log(`TransformBlank: identity-context: injected (mode=${mode}, ${ctx.fields.length} field${ctx.fields.length === 1 ? '' : 's'})`);
    }
    return { block, ctx };
  }

  /**
   * Render the ambient blank-context block (stocks/weather/crypto/…
   * live-data snapshots) for inclusion in EXTRACT/APPLY/FUSED prompts.
   * Mirrors `buildUserCatalogBlock` for identity-context. Returns empty
   * block + undefined snapshot when `blank-context-mode: off` or no
   * blanks declare `as-context`.
   *
   * The two catalogs travel side-by-side: identity-context fields
   * describe the SENDER (the user composing); blank-context fields
   * describe AMBIENT live data the rewrite may reference. Both go
   * through the same post-processor with `preserveUnknown: true`.
   */
  private buildBlankCatalogBlock(context: CueContext): {
    block: string;
    snapshot: BlankContextSnapshot | undefined;
  } {
    const bc = context.blankContext;
    if (!bc) return { block: '', snapshot: undefined };
    const snapshot: BlankContextSnapshot = { fields: bc.fields, catalog: bc.catalog };
    const mode: BlankContextMode = bc.mode;
    const block = renderBlankContextCatalogForTransform(snapshot, mode);
    if (block) {
      this.log(`TransformBlank: blank-context: injected (mode=${mode}, ${snapshot.fields.length} slot${snapshot.fields.length === 1 ? '' : 's'})`);
    }
    return { block, snapshot };
  }

  /**
   * Resolve sender-data sentinels emitted by the LLM into their real
   * values. Always passes `preserveUnknown: true` so LLM-emitted
   * placeholders for non-user entities (`[Recipient Name]`,
   * `[Your Position]` when no `position` field exists, `[Date]`)
   * survive untouched. No-op when sentinels is absent or its
   * catalog is empty.
   */
  private resolveSentinels(
    rewrite: string,
    originalBody: string,
    ctx: Identity | undefined,
    blankSnapshot?: BlankContextSnapshot | undefined,
  ): string {
    const hasIdentity = ctx && ctx.catalog.size > 0;
    const hasBlank = blankSnapshot && blankSnapshot.catalog.size > 0;
    if (!hasIdentity && !hasBlank) return rewrite;
    const catalog = hasIdentity && hasBlank
      ? mergeCatalogs(ctx!.catalog, blankSnapshot!.catalog)
      : hasIdentity
        ? ctx!.catalog
        : blankSnapshot!.catalog;
    const pp = postProcessContext(rewrite, {
      catalog,
      originalBody,
      preserveUnknown: true,
    });
    if (pp.report.resolved.length || pp.report.tolerantMatches.length) {
      this.log(`TransformBlank: context post-processed (resolved=${pp.report.resolved.length}, tolerant=${pp.report.tolerantMatches.length}, preserved-unknown=${pp.report.stripped.length})`);
    }
    return pp.output;
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();
    const previewLen = 80;
    const preview = (s: string) => s.length > previewLen ? s.slice(0, previewLen) + '…' : s;
    // Per-call model override — `with <model>` in the buffer flips
    // dispatch target for THIS call only. Stored on `this` so the
    // multiple downstream callLLM sites (3-pass EXTRACT/APPLY/VERIFY,
    // FUSED) pick it up without each having to thread the parameter.
    // The pattern is safe because getCues is awaited as a single
    // promise per resolve generation; the resolver aborts the old
    // signal before starting a new generation, and providers honour
    // it (the sibling-abort pattern shipped June 2026, perf #95).
    // The try/finally below clears the field even on throw.
    const override = applySubscriptionPreference(
      detectModelOverride(context.text),
      context.anthropicSubscription ?? 'prefer',
    );
    const overrideTarget = override ? this.resolveOverride(override) : null;
    this._currentOverride = overrideTarget;
    try {
      const blankIdx = context.words.indexOf('_');
      if (blankIdx === -1) return { results: [] };

      if (overrideTarget) {
        this.log(`TransformBlank: model-override → ${overrideTarget.provider.id}/${overrideTarget.model} (token="${override!.matchedToken}")`);
      } else if (override) {
        this.log(`TransformBlank: model-override skip — no apiKey for provider '${override.provider}' (token="${override.matchedToken}")`);
      }

      const effectiveProvider = overrideTarget?.provider ?? this.provider;
      const effectiveModel = overrideTarget?.model ?? this.model;
      const __llmDesc = describeLLMCall(effectiveProvider, effectiveModel, undefined, {
        maxTokens: this.maxTokensOverride, temperature: this.temperatureOverride,
      });
      // The resolver subscribes to the `started` event and emits the
      // info-level "TransformBlank: starting (…)" log line itself. Don't
      // also log here — it produces a duplicate at debug + info, 1ms
      // apart. FluidBlank already only logs via the resolver subscriber;
      // this comment + the missing this.log() mirror that pattern.
      const __pipelineT0 = Date.now();
      this.emit({
        type: 'started',
        textLen: context.text.length,
        blankIdx,
        llm: __llmDesc,
        mode: this.mode,
        ...(overrideTarget && override
          ? { modelOverride: { provider: overrideTarget.provider.id, model: overrideTarget.model, token: override.matchedToken } }
          : {}),
      });

      // VARIANT POOL — decide fresh dispatch vs cache serve. State
      // machine + LRU + cycling live in `VariantCache` (shared
      // primitive in `@opencues/core/variant-cache.ts`). On hit we
      // short-circuit the LLM dispatch entirely and return a result
      // carrying the cached rewrite as alternatives[1], with other
      // pool entries at alternatives[2..N] so DynDef cycling (Up
      // arrow) walks the variant history without re-paying.
      //
      // FUSED MODE ONLY. 3-pass mode's finalRewrite is the splice-
      // REPLACEMENT portion (not the whole buffer) and serving it
      // through the cache's whole-body replace path would wipe the
      // buffer's prefix/suffix. Caching 3-pass would require also
      // caching transformTarget so the resolver can replay the
      // surgical splice — out of scope for the prototype; tracked as
      // a follow-up.
      const cacheKey = this._computeCacheKey(context);
      const variantChoice = this.mode === 'fused'
        ? TransformBlankSource._variantCache.select(cacheKey)
        : { kind: 'fresh' as const, others: [] as { rewrite: string; span: string }[] };
      if (variantChoice.kind === 'cache') {
        this.log(`TransformBlank: variant-cache HIT — serving cached rewrite (pool size ${variantChoice.others.length + 1})`);
        // Emit a synthetic pass-completed so observers see the same
        // event stream whether the rewrite came from the LLM or the
        // cache. Without this, scenarios that wait for
        // `transform-blank.pass-completed pass=P1` time out on the
        // second trigger against the same buffer (cache HIT) even
        // though the substitute itself succeeds in ~4ms. The agentic
        // pipeline-events scenario (08) caught this — it asserts the
        // event sequence is mode-agnostic, which includes the
        // variant-cache HIT path. The latency is 0 because no LLM
        // call ran; verdict is TRANSFORM because the cache only ever
        // stores TRANSFORM verdicts (NONE/TASK_* paths return
        // empty/no result and don't write to the cache).
        this.emit({
          type: 'pass-completed',
          pass: 'P1',
          verdict: 'TRANSFORM',
          instruction: '',
          target: '',
          latencyMs: 0,
          source: 'visible',
        });
        // Re-derive splice geometry from the cached SPAN. The cache
        // key includes context.text verbatim, so the SPAN we recorded
        // on the original dispatch IS still a substring of the live
        // buffer here — lastIndexOf is structurally safe.
        const otherRewrites = variantChoice.others.map(o => o.rewrite);
        const range = findSpanCharRange(variantChoice.value.span, context.text);
        const spanStart = range !== null ? range[0] : 0;
        const spanEnd = range !== null ? range[1] : context.text.length;
        return {
          results: [{
            wordIndex: blankIdx,
            word: '_',
            // alternatives[0] = FULL original buffer (race-guard +
            // DynDef revert state); alternatives[1] = cached slice
            // REWRITE; alternatives[2..N] = other cached slice REWRITEs.
            // Resolver computes splice bounds from transformTarget (= SPAN)
            // via indexOf against alternatives[0].
            alternatives: [context.text, variantChoice.value.rewrite, ...otherRewrites],
            source: this.id,
            priority: this.priority,
            spanStart,
            spanEnd,
            metadata: {
              // transformTarget = SPAN content — routes the resolver
              // substitute branch through the existing splice path
              // (3-pass and FUSED+SPAN share one mechanism: deterministic
              // slot splice with parser/LLM-emitted bounds). The merge
              // path is now reserved for AgentRewrite only.
              transformTarget: variantChoice.value.span,
              pipelineMode: 'variant-cache',
              pipelineLatencyMs: 0,
              variantCacheHit: true,
              variantPoolSize: variantChoice.others.length + 1,
            },
          }],
          timing: Date.now() - startTime,
          model: this.model,
        };
      }
      // Fresh path — `variantChoice.others` carries the prior pool
      // entries (may be empty during build phase). Each entry is
      // {rewrite, span}; alternatives at the return site use just the
      // rewrites for Up-arrow history walk.
      const priorVariants = variantChoice.others;

      // FUSED MODE — single-call short-circuit. Capable generalist models
      // (cerebras, gemini, claude, openai by default) emit VERDICT +
      // INSTRUCTION + TARGET + REWRITE in one call, skipping P1.5/P2/P3
      // entirely. Falls through to 3-pass on model failure (empty
      // rewrite, missing verdict) so the user still gets a result.
      // Benchmark evidence: tests/benchmarks/transform-blank/
      // EXPERIMENTS.md § Experiment 6.
      if (this.mode === 'fused') {
        const fusedResult = await this.runFusedAndBuild(context, blankIdx, __pipelineT0, preview, startTime, cacheKey, priorVariants);
        if (fusedResult) return fusedResult;
        // Fused failed (empty result / parse miss) — fall through to
        // the 3-pass pipeline below as graceful degradation.
        this.log('TransformBlank: fused fallback → 3-pass');
      }

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
      const rawExtractText = context.richText ?? context.asTypedText ?? context.text;
      // Override path strips `with <model>` from the LLM-bound prompt
      // so the model name doesn't leak into the rewrite. The substitute
      // span (spanStart=0/spanEnd=context.text.length below) still wipes
      // the original buffer including "with opus", so the override
      // token disappears with the rewrite. Skip strip on rich/as-typed
      // paths — they already echo user-typed structure; the override
      // detector only ran against context.text (visible buffer).
      const extractText = overrideTarget && !context.richText && !context.asTypedText
        ? stripModelOverride(rawExtractText, override!)
        : rawExtractText;
      const sourceTag = context.richText ? 'rich-text' : context.asTypedText ? 'as-typed' : 'visible';
      const p1Tokens = budgetForOutput(extractText.length, 1.0);
      const p1Start = Date.now();
      const useJson = useStrictJson(effectiveProvider.id, effectiveModel);
      const extractRaw = await this.callLLM(
        P1_EXTRACT_SYSTEM,
        `INPUT: ${extractText}`,
        p1Tokens,
        useJson ? buildJsonResponseFormat('transform_extract', EXTRACT_SCHEMA as unknown as Record<string, unknown>) : undefined,
        context.signal,
      );
      const ext = useJson ? parseExtractJson(extractRaw) : parseExtract(extractRaw);
      this.log(`TransformBlank P1 EXTRACT (${Date.now() - p1Start}ms, max_tokens=${p1Tokens}, source=${sourceTag}): verdict=${ext.verdict}, instruction="${ext.instruction}", target="${preview(ext.target)}"`);
      this.emit({
        type: 'pass-completed',
        pass: 'P1',
        verdict: ext.verdict,
        instruction: ext.instruction,
        target: preview(ext.target),
        latencyMs: Date.now() - p1Start,
        source: sourceTag,
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
        const { block: genCatalogBlock, ctx: genUserCtx } = this.buildUserCatalogBlock(context);
        const { block: genBlankBlock, snapshot: genBlankSnapshot } = this.buildBlankCatalogBlock(context);
        const genRaw = await this.callLLM(
          P2_GENERATIVE_APPLY_SYSTEM,
          `INSTRUCTION: ${ext.instruction}${genCatalogBlock}${genBlankBlock}`,
          genTokens,
          useJson ? buildJsonResponseFormat('transform_generative', APPLY_SCHEMA as unknown as Record<string, unknown>) : undefined,
          context.signal,
        );
        const generatedRaw = (useJson ? parseApplyJson(genRaw) : parseApply(genRaw)).rewrite;
        const generated = this.resolveSentinels(generatedRaw, context.text, genUserCtx, genBlankSnapshot);
        this.log(`TransformBlank P2 GENERATIVE (${Date.now() - genStart}ms, max_tokens=${genTokens}): "${preview(generated)}"`);
        if (!generated) {
          this.log(`TransformBlank: claim-and-bail — GENERATIVE empty, slot ${blankIdx} consumed (no downstream fallback)`);
          // Mirrors the IMPERATIVE branch: if EXTRACT decided this input
          // was a TRANSFORM (here: generative-shaped), TransformBlank
          // owns the slot. APPLY couldn't produce output — but the
          // user's intent was "create something for me here", not "look
          // up an answer." Letting FluidBlank fall through and segment
          // the prompt as a lookup phrase would vandalise the intent.
          // Rule: if TransformBlank tries the slot, FluidBlank never does.
          return {
            results: [],
            consumedBlankSlots: [blankIdx],
            timing: Date.now() - startTime,
            model: this.model,
          };
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

      // P1.5 — DEICTIC RESOLVER (conditional sub-step).
      // Only fires when the instruction contains a deictic reference
      // ("this line", "this word", "it", "those", etc.). Rewrites the
      // instruction with deictics resolved into explicit quoted spans
      // so APPLY gets an unambiguous edit command. See P1_5_RESOLVE_DEICTICS_SYSTEM.
      let resolvedInstruction = ext.instruction;
      if (needsDeicticResolution(ext.instruction)) {
        const p1_5Start = Date.now();
        const p1_5Tokens = 512;
        try {
          const targetWithCursor = injectCursorSentinel(
            ext.target,
            translateBufferCursorToTargetCursor(context.text, context.cursor ?? -1, ext.target),
          );
          const p1_5Raw = await this.callLLM(
            P1_5_RESOLVE_DEICTICS_SYSTEM,
            `INSTRUCTION: ${ext.instruction}\nTARGET: ${targetWithCursor}`,
            p1_5Tokens,
            useJson ? buildJsonResponseFormat('transform_resolve', RESOLVE_SCHEMA as unknown as Record<string, unknown>) : undefined,
            context.signal,
          );
          const resolved = useJson
            ? parseResolveJson(p1_5Raw)
            : (() => {
                const m = p1_5Raw.match(/RESOLVED:[ \t]*([\s\S]*?)\s*$/i);
                return (m ? m[1].trim() : '').trim();
              })();
          if (resolved) {
            resolvedInstruction = resolved;
            this.log(`TransformBlank P1.5 RESOLVE (${Date.now() - p1_5Start}ms): "${ext.instruction}" → "${preview(resolved)}"`);
          } else {
            this.log(`TransformBlank P1.5 RESOLVE (${Date.now() - p1_5Start}ms): empty output — keeping original instruction`);
          }
        } catch (err) {
          this.log(`TransformBlank P1.5 RESOLVE failed (${Date.now() - p1_5Start}ms) — keeping original: ${(err as Error).message ?? err}`);
        }
      }

      // P2 APPLY — sequential composition for "X | Y" instructions.
      // Output of step N feeds target of step N+1. Token budget: rewrite
      // is usually same length as target, but transforms can stretch it
      // (e.g. "expand contractions" adds chars). Use 1.5× headroom.
      const parts = resolvedInstruction.split('|').map(s => s.trim()).filter(Boolean);
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
      const { block: applyCatalogBlock, ctx: applyUserCtx } = this.buildUserCatalogBlock(context);
      const { block: applyBlankBlock, snapshot: applyBlankSnapshot } = this.buildBlankCatalogBlock(context);
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
          `INSTRUCTION: ${inst}\nTARGET: ${targetForPrompt}${applyCatalogBlock}${applyBlankBlock}`,
          p2Tokens,
          useJson ? buildJsonResponseFormat('transform_apply', APPLY_SCHEMA as unknown as Record<string, unknown>) : undefined,
          context.signal,
        );
        // Strip any sentinel the model leaked into its output — input-only.
        const draftRaw = stripCursorSentinel((useJson ? parseApplyJson(applyRaw) : parseApply(applyRaw)).rewrite);
        // Resolve IDENTITY.md sentinels per step so VERIFY downstream sees
        // the real values, not bracket-tokens. Preserves unknown brackets.
        const draft = this.resolveSentinels(draftRaw, context.text, applyUserCtx, applyBlankSnapshot);
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
        // EXTRACT said TRANSFORM but APPLY couldn't produce a rewrite.
        // Claim the slot so downstream sources (notably FluidBlank) don't
        // "vandalise" the buffer by answering it as a question. The user's
        // input was an imperative — we just couldn't apply it. Better to
        // leave the buffer alone than to substitute an unrelated answer.
        this.log(`TransformBlank: claim-and-bail — APPLY empty after EXTRACT=TRANSFORM, slot ${blankIdx} consumed (no downstream fallback)`);
        return {
          results: [],
          consumedBlankSlots: [blankIdx],
          timing: Date.now() - startTime,
          model: this.model,
        };
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
          useJson ? buildJsonResponseFormat('transform_verify', VERIFY_SCHEMA as unknown as Record<string, unknown>) : undefined,
          context.signal,
        );
        ver = useJson ? parseVerifyJson(verifyRaw) : parseVerify(verifyRaw);
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
          // VERIFY's REPAIR output bypassed the per-step resolveSentinels
          // chain — if the model hallucinated a bracket-token (unlikely
          // since VERIFY sees only already-substituted DRAFT, but possible),
          // run the post-processor once more to catch it.
          finalRewrite = this.resolveSentinels(ver.rewrite, context.text, applyUserCtx, applyBlankSnapshot);
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

      // `transform-blank.completed` is intentionally emitted from the
      // RESOLVER's substitute branch (see runFusedAndBuild for the
      // rationale). Latency carried via metadata.pipelineLatencyMs.
      const pipelineLatencyMs = Date.now() - startTime;

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
          pipelineLatencyMs,
        },
      };

      return { results: [result], timing: Date.now() - startTime, model: this.model };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const msg = err.message;
      this.log(
        `TransformBlank: failed (${Date.now() - startTime}ms, llm=${this.provider.id}/${this.model}) — ${msg}`,
      );
      // Inline error substitute — same shape FluidBlank uses (PR June
      // 2026 for fluid-blank, extended to transform-blank in June 2026
      // after live testing surfaced silent failures on invalid (provider,
      // model) pairs). The `metadata.fluidBlankErrorReason` flag tells
      // the resolver to route this through the substitute-splice path so
      // the user sees `_` → `[OpenCues: ...]` inline.
      const reason = classifyLlmError(err);
      const blankIdx = context.words.indexOf('_');
      if (reason !== null && blankIdx >= 0 && this.formatErrorAsSubstitute) {
        const text = this.formatErrorAsSubstitute(reason, err);
        if (text && text.length > 0) {
          return {
            results: [{
              wordIndex: blankIdx,
              word: '_',
              alternatives: ['_', text],
              source: this.id,
              priority: this.priority,
              cueTip: 'TransformBlank failed — message describes the cause',
              metadata: { fluidBlankErrorReason: reason },
            }],
            error: msg,
            timing: Date.now() - startTime,
          };
        }
      }
      return {
        results: [],
        error: msg,
        timing: Date.now() - startTime,
      };
    } finally {
      // Clear per-call override regardless of success / throw — every
      // future getCues invocation starts with `_currentOverride = null`
      // and resolves its own override fresh.
      this._currentOverride = null;
    }
  }

  /**
   * Single-call fused pipeline. One LLM hop emits VERDICT + INSTRUCTION +
   * TARGET + REWRITE; this method consumes those and builds the final
   * CueResult (or returns null on failure → caller falls through to
   * 3-pass).
   *
   * Result shape on success matches the 3-pass path exactly so downstream
   * runtime code (Cycling, BlankFill, etc.) sees the same envelope —
   * mode is invisible to consumers.
   */
  private async runFusedAndBuild(
    context: CueContext,
    blankIdx: number,
    __pipelineT0: number,
    preview: (s: string) => string,
    startTime: number,
    cacheKey: string,
    priorVariants: { rewrite: string; span: string }[],
  ): Promise<CueSourceResult | null> {
    // Same text-source precedence as the 3-pass EXTRACT input (rich-text
    // > as-typed > visible) so styling + agent-revert behaviour matches.
    const rawExtractText = context.richText ?? context.asTypedText ?? context.text;
    // Mirror the 3-pass override strip — `with <model>` only sits in
    // the visible buffer, never in the rich-text / as-typed projection
    // (those are runtime overlays the user doesn't type the override
    // into). The substitute span at runFusedAndBuild's tail covers the
    // full original buffer including "with opus".
    const override = detectModelOverride(context.text);
    const overrideForStrip = override && this._currentOverride ? override : null;
    const extractText = overrideForStrip && !context.richText && !context.asTypedText
      ? stripModelOverride(rawExtractText, overrideForStrip)
      : rawExtractText;
    const sourceTag = context.richText ? 'rich-text' : context.asTypedText ? 'as-typed' : 'visible';
    // FULL_REWRITE budget — fused emits the WHOLE final buffer (May
    // 2026 contract change). Output is ~input-length plus VERDICT/
    // INSTRUCTION/TARGET label headers. May 23 2026: raised floor
    // 2048 → 4096 and ceiling 4096 → 16384 after the chrome
    // translate-to-japanese truncation bug. Bench
    // (`budget-translate-probe.ts`) measured latency + cost as FLAT
    // across 2048-8192 — the model emits what it needs and providers
    // bill on actual tokens, not the cap. The 2048 floor was just
    // enough for English↔English but cerebras + dense-script outputs
    // (Japanese, Chinese, Korean, Arabic) at reasoning=medium need
    // ~2500-3000 tokens when the model verbatim-echoes the TARGET
    // section. Floor of 4096 gives ~1.5x headroom over the observed
    // worst case; ceiling 16384 protects longer letters (5000-8000
    // char inputs translated to dense scripts can need 6000-10000
    // output tokens). Multiplier 3.0 accounts for the larger
    // payload — bench evidence in
    // `tests/results/single-call-dynamic-budget/` (original) +
    // `tests/results/budget-bump-floor4096/` (this raise).
    const FUSED_FLOOR = 4096;
    const FUSED_CEILING = 16384;
    const FUSED_HEADROOM = 700;
    const fusedTokens = Math.max(
      FUSED_FLOOR,
      Math.min(FUSED_CEILING, Math.ceil(extractText.length * 3.0 / 3) + FUSED_HEADROOM),
    );
    const fusedStart = Date.now();
    const { block: fusedCatalogBlock, ctx: fusedUserCtx } = this.buildUserCatalogBlock(context);
    const { block: fusedBlankBlock, snapshot: fusedBlankSnapshot } = this.buildBlankCatalogBlock(context);
    // Cerebras prefix-cache optimisation (PR June 2026): move identity
    // + blank-context catalog blocks from the user message into the
    // SYSTEM message. Cerebras's automatic prompt caching hits on the
    // static prefix (verified at 99.5% cache rate on gpt-oss-120b).
    // The catalog content is stable per session (identity) and per
    // refresh-TTL (blank-context snapshot); moving it into system
    // grows the cached prefix by ~600 tokens. Bench-validated against
    // tests/benchmarks/transform-blank to preserve accuracy.
    const fusedSystem = `${FUSED_SYSTEM}${fusedCatalogBlock}${fusedBlankBlock}`;
    // Cerebras Predicted Outputs (PR June 2026): pass the input body
    // as the prediction. For TransformBlank-style rewrites (fix typos,
    // make formal, shorten, rephrase) the output preserves 50-95% of
    // input byte content; cerebras's speculation accepts those tokens
    // from cache (input rate) instead of regenerating them (output
    // rate). Empirically 66% acceptance + ~150ms median latency win
    // on long-rewrite tasks; ~750ms p95 tail reduction on high-
    // reasoning calls. Gated at 50 chars so trivial generation
    // triggers ("draft an email _" with no body) don't pay the
    // rejected-token surcharge for no win. Other providers ignore
    // the field silently.
    // See docs/architecture/cerebras.md § Predicted Outputs.
    // Length gate. Picked empirically (June 2026 ad-hoc benches —
    // /tmp/cerebras-predicted-outputs-bench.mjs + reasoning matrix):
    //   - Below ~200 chars: cerebras's 16-token speculation window
    //     doesn't engage meaningfully on rewrite outputs — 0%
    //     acceptance rate, ~12ms median overhead from rejected tokens
    //     for no win.
    //   - Above ~200 chars: ~66% acceptance on typical rewrite tasks,
    //     ~150ms median speedup, ~750ms p95 tail reduction.
    // Accuracy: bench-validated against transform-blank/prod-fused.ts
    // on cerebras — 186/231 across 4 runs vs master 186-193 (cerebras
    // has ~7-case variance on this bench at temp=0/seed=42, so the
    // accuracy signal can't be distinguished from noise; we accept
    // the empirical no-drift result and rely on the cost asymmetry —
    // rejected prediction tokens are cheap, accepted ones are
    // input-rate). The iteration use case ("refine this draft 4
    // times") naturally has bodies > 200 chars once the first draft
    // is in place — the dominant payoff window.
    const PREDICTION_MIN_CHARS = 200;
    const fusedPrediction = extractText.length >= PREDICTION_MIN_CHARS ? extractText : undefined;
    const fusedRaw = await this.callLLM(fusedSystem, `INPUT: ${extractText}`, fusedTokens, undefined, context.signal, undefined, fusedPrediction);
    const fParsed = parseFused(fusedRaw);
    // Resolve IDENTITY.md sentinels + ambient blank-context tokens in
    // FULL_REWRITE before the result routes through the runtime's three-
    // way merge. Preserves unknown brackets so LLM-emitted placeholders
    // for non-user entities ([Recipient Name], [Date]) survive untouched.
    const f = {
      ...fParsed,
      rewrite: this.resolveSentinels(fParsed.rewrite, context.text, fusedUserCtx, fusedBlankSnapshot),
    };
    this.log(`TransformBlank FUSED (${Date.now() - fusedStart}ms, max_tokens=${fusedTokens}, source=${sourceTag}): verdict=${f.verdict}, instruction="${f.instruction}", target="${preview(f.target)}", span="${preview(f.span)}", rewrite="${preview(f.rewrite)}"`);
    this.emit({
      type: 'pass-completed',
      pass: 'P1',
      verdict: f.verdict,
      instruction: f.instruction,
      target: preview(f.target),
      latencyMs: Date.now() - fusedStart,
      // Source-tag exposes the input precedence (rich-text > as-typed >
      // visible) so agentic scenarios can assert the right code path
      // exercised. Primarily for testing MarkdownRender-cache priming
      // scenarios that prove rich-text injection took effect.
      source: sourceTag,
    });

    // TASK BRANCH — agent-task commands. Same metadata.taskAction
    // shape as the 3-pass TASK branch; runtime's resolver consumes
    // it identically.
    if (f.verdict === 'TASK_ARM' || f.verdict === 'TASK_ADD'
        || f.verdict === 'TASK_STOP' || f.verdict === 'TASK_SHOW') {
      this.log(`TransformBlank FUSED: TASK branch (${f.verdict}, instruction="${f.instruction}")`);
      const result: CueResult = {
        wordIndex: blankIdx,
        word: '_',
        alternatives: [context.text, ''],
        source: this.id,
        priority: this.priority,
        spanStart: 0,
        spanEnd: context.text.length,
        metadata: { taskAction: f.verdict, taskPayload: f.instruction },
      };
      return { results: [result], timing: Date.now() - startTime, model: this.model };
    }

    if (f.verdict === 'NONE' || !f.instruction) {
      this.log('TransformBlank FUSED: bailing — verdict=NONE or empty instruction');
      this.emit({ type: 'bailed', reason: 'FUSED-verdict-none-or-empty', latencyMs: Date.now() - __pipelineT0 });
      return { results: [], timing: Date.now() - startTime, model: this.model };
    }

    // For TRANSFORM (with or without target), REWRITE must be non-empty —
    // we either have the rewritten target or the generated content.
    // Empty rewrite means the model parsed the input but couldn't produce
    // the result in one call → fall through to 3-pass for retry.
    if (!f.rewrite) {
      this.log('TransformBlank FUSED: empty rewrite — falling through to 3-pass');
      return null;
    }

    // SPAN+slice contract (June 2026 — unifies FUSED with the other
    // splice sources). LLM emits SPAN (the verbatim substring to
    // replace) + REWRITE (just the slice that fills it). The runtime
    // computes splice bounds via findSpanCharRange and substitutes
    // REWRITE at [spanStart, spanEnd). Anything outside SPAN —
    // including any user-typed prior content — is preserved verbatim
    // because the splice never touches it. This replaces the
    // pre-June-2026 whole-buffer + three-way-merge mechanism (merge
    // didn't protect against the LLM dropping unrelated prefix from
    // FULL_REWRITE — empirically broken on 5/5 prior-content tests).
    //
    // Fallback for legacy LLM output (empty / unfindable SPAN): treat
    // REWRITE as the whole post-transform buffer, splice [0, text.length).
    // Matches the pre-June-2026 contract so older provider responses
    // don't regress. New prompt examples train the LLM on SPAN; this
    // branch should be cold in steady state.
    //
    // Duplication-bug-class defence (the structural reason May 2026
    // moved to whole-buffer + merge): the May bug was narrow-TARGET +
    // wide-REWRITE + concat-tail at [span_end:]. The new contract has
    // no concat-tail — REWRITE replaces SPAN exactly, nothing else
    // is appended. The remaining risk is the LLM emitting REWRITE that
    // overlaps text outside SPAN; the prompt explicitly forbids this
    // (rule 9 + 10) and the SPAN-or-fallback split keeps the runtime
    // safe even if the LLM ignores the rule.
    //
    // NOTE: the `transform-blank.completed` event is intentionally NOT
    // fired here. It's emitted from the RESOLVER's substitute branch
    // AFTER the buffer setText commits (resolver.ts isTransformBlank
    // path). The reason: firing here would mean observers (tests,
    // statusline) can read the buffer BETWEEN the source returning
    // and the resolver's substitute committing, catching the loading-
    // animation braille char. Emitting post-setText makes `completed`
    // the user-visible commit marker — the buffer is final when the
    // event fires. Latency is carried through the result so the
    // resolver can include it on the event body.
    const pipelineLatencyMs = Date.now() - startTime;
    // Locate SPAN in the input buffer. The LLM was instructed to emit
    // a verbatim substring; lastIndexOf picks the closest-to-`_`
    // occurrence if the same span appears twice in the buffer.
    const spanRange = f.span ? findSpanCharRange(f.span, context.text) : null;
    const spliceStart = spanRange !== null ? spanRange[0] : 0;
    const spliceEnd = spanRange !== null ? spanRange[1] : context.text.length;
    const spanSubstring = spanRange !== null ? f.span : context.text;
    // Record the fresh rewrite + span into the variant cache. The span
    // travels with the rewrite so cache hits can re-derive splice
    // geometry without re-calling the LLM.
    TransformBlankSource._variantCache.record(cacheKey, { rewrite: f.rewrite, span: spanSubstring });
    // Re-read the pool POST-RECORD to get the actually-cached
    // siblings (priorVariants was captured pre-record and may
    // include an entry that's now been evicted).
    const postRecordOthers = TransformBlankSource._variantCache.entries(cacheKey)
      .filter(e => e.rewrite !== f.rewrite)
      .map(e => e.rewrite);
    const result: CueResult = {
      wordIndex: blankIdx,
      word: '_',
      // alternatives shape: [full-original-buffer, fresh-slice-rewrite,
      // ...other-pool-rewrites]. alternatives[0] is the FULL buffer
      // (the resolver's race-guard compares it against liveText, and
      // the DynDef cycling stores it as the "revert" state). The
      // resolver computes splice bounds from metadata.transformTarget
      // (= SPAN) via indexOf against alternatives[0] and replaces just
      // [spanStart, spanEnd) with alternatives[1] (= slice REWRITE).
      alternatives: [context.text, f.rewrite, ...postRecordOthers],
      source: this.id,
      priority: this.priority,
      spanStart: spliceStart,
      spanEnd: spliceEnd,
      metadata: {
        // transformTarget = SPAN content — routes the resolver
        // substitute branch through the existing splice path
        // (3-pass and FUSED+SPAN share one mechanism: deterministic
        // slot splice with parser/LLM-emitted bounds). The merge
        // path is now reserved for AgentRewrite only.
        transformTarget: spanSubstring,
        transformInstruction: f.instruction,
        transformTargetDebug: f.target,
        verifyVerdict: 'SKIPPED',
        pipelineMode: 'fused',
        // Latency carried for the resolver to use on the post-substitute
        // `transform-blank.completed` event (see header comment).
        pipelineLatencyMs,
        variantCacheHit: false,
        variantPoolSize: postRecordOthers.length + 1,
      },
    };
    return { results: [result], timing: Date.now() - startTime, model: this.model };
  }

  /**
   * Resolve a model-alias override to a concrete dispatch target.
   * Returns null when the override's provider isn't in the apiKeys map.
   * Mirror of `FluidBlankSource.resolveOverride`.
   */
  private resolveOverride(override: ModelOverride): { provider: ProviderAdapter; model: string; apiKey: string } | null {
    const adapter = getProvider(override.provider);
    if (adapter === null) return null;
    // CLI-transport providers (claude-code-cli) auth via the installed
    // binary (`claude /login`), not an env var — envKeyName is empty.
    // Skip the apiKey gate for them; the dispatch path (invokeCli)
    // surfaces auth failures at spawn time.
    if (adapter.transport === 'cli') {
      return { provider: adapter, model: override.model, apiKey: '' };
    }
    // apiKeys map is keyed by envKeyName (`ANTHROPIC_API_KEY`,
    // `CEREBRAS_API_KEY`, …) — matches what resolveLLM reads at
    // llm-provider.ts:1817 + what every host adapter populates.
    const apiKey = this.apiKeys[adapter.envKeyName];
    if (!apiKey) return null;
    return { provider: adapter, model: override.model, apiKey };
  }

  private async callLLM(
    system: string,
    user: string,
    maxTokens: number,
    responseFormat?: { name: string; strict?: boolean; schema: Record<string, unknown> },
    signal?: AbortSignal,
    overrideTarget?: { provider: ProviderAdapter; model: string; apiKey: string },
    /** Predicted-outputs hint — see cerebras.md § Predicted Outputs.
     *  Cerebras surfaces this on gpt-oss-120b; other providers ignore
     *  the field. Pass the BODY being transformed (original buffer
     *  text); the rewrite will share ~50-95% of byte content for
     *  typical transformations. */
    prediction?: string,
  ): Promise<string> {
    // Per-feature override (`transform-blank-max-tokens:` /
    // `transform-blank-temperature:`). When set, applies UNIFORMLY to
    // every pass (3-pass EXTRACT/APPLY/VERIFY + fused). Per-pass
    // tuning would need a richer API; the simple uniform override
    // covers the long-buffer-rewrite use case.
    const effectiveMaxTokens = this.maxTokensOverride ?? maxTokens;
    // Per-call override precedence: explicit overrideTarget arg > class
    // field _currentOverride (set by getCues) > configured provider.
    const eff = overrideTarget ?? this._currentOverride ?? null;
    const effProvider = eff?.provider ?? this.provider;
    const effModel = eff?.model ?? this.model;
    const effApiKey = eff?.apiKey ?? this.apiKey;
    const effEndpoint = eff ? effProvider.defaultEndpoint : this.endpoint;
    return dispatchChat(
      effProvider,
      this.httpAdapter,
      {
        model: effModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens: effectiveMaxTokens,
        temperature: this.temperatureOverride ?? 0,
        // reasoningEffort omitted — provider adapter applies its
        // bench-derived default (see ProviderAdapter.defaultReasoningEffort
        // in @opencues/core/llm-provider.ts).
        seed: 42,
        responseFormat,
        prediction,
      },
      {
        apiKey: effApiKey,
        endpoint: effEndpoint,
        signal,
        maxThinking: this.maxThinking,
        onUsage: (u) => {
          // Only log when the provider surfaced cache OR prediction
          // info (cerebras / openai). Other providers report 0 by
          // default; we skip those to keep /tmp/opencues.log clean.
          const hasCacheData = u.cachedTokens > 0 || u.cacheHitRate > 0;
          const hasPredData = u.acceptedPredictionTokens > 0 || u.rejectedPredictionTokens > 0;
          if (hasCacheData || hasPredData) {
            const predPart = hasPredData
              ? ` pred-accepted=${u.acceptedPredictionTokens} pred-rejected=${u.rejectedPredictionTokens} (acc rate ${(u.predictionAcceptRate * 100).toFixed(0)}%)`
              : '';
            this.log(`TransformBlank: usage prompt=${u.promptTokens} cached=${u.cachedTokens} (${(u.cacheHitRate * 100).toFixed(1)}%) completion=${u.completionTokens}${predPart}`);
          }
        },
      },
    );
  }

  /**
   * Derive a cache key for the variant pool. Includes everything that
   * could change the LLM rewrite: buffer text, effective provider+model,
   * pipeline mode, maxThinking. Excludes identity / blank context VALUES
   * — those are substituted post-LLM by the post-processor in `safe`
   * mode, so the cached rewrite (which carries `[TOKEN]` names) re-
   * substitutes against current values on each hit and stays correct
   * even as values drift. In `raw` mode values do affect the LLM input;
   * cached entries may serve slightly-stale-valued rewrites then. The
   * trade-off was deliberate (most users are on `safe` mode; raw users
   * get a minor cosmetic staleness window between context refreshes).
   */
  private _computeCacheKey(context: CueContext): string {
    const providerId = this._currentOverride?.provider.id ?? this.provider.id;
    const model = this._currentOverride?.model ?? this.model;
    const SEP = '\x1f';  // ASCII unit separator — won't collide with text content
    return [
      context.text,
      providerId,
      model,
      this.mode,
      this.maxThinking ? 'maxT' : 'minT',
    ].join(SEP);
  }

  /** For tests + diagnostics — current pool size for a given key. */
  variantPoolSize(key: string): number {
    return TransformBlankSource._variantCache.size(key);
  }

  /** For tests — re-expose the key derivation. */
  cacheKeyForTest(context: CueContext): string {
    return this._computeCacheKey(context);
  }

  /** Test-only: empty the module-level variant cache. Without this,
   *  test order would matter — a pool populated by one test would
   *  leak into the next. Production code must NEVER call this; the
   *  cache's LRU bound handles real-world memory growth. */
  static resetVariantPoolForTest(): void {
    TransformBlankSource._variantCache.clear();
  }
}
