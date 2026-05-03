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

// ============================================================================
// Prompts — ported verbatim from tests/benchmarks/transform-blank/
// ============================================================================

const P1_EXTRACT_SYSTEM = `You read a sentence containing _ and identify whether it carries an IMPERATIVE INSTRUCTION the user wants applied to the surrounding text.

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

const P2_APPLY_SYSTEM = `You receive:
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
REWRITE: i bought apple, SAMSUNG, and SONY products`;

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
REWRITE: Does the meeting start at 3pm?`;

// ============================================================================
// Parsers
// ============================================================================

interface ExtractResult {
  verdict: 'TRANSFORM' | 'NONE';
  instruction: string;  // pipe-joined for composed instructions
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
  const verdictMatch = raw.match(/^VERDICT:\s*(TRANSFORM|NONE)\s*$/im);
  const instructionMatch = raw.match(/^INSTRUCTION:\s*(.*?)\s*$/im);
  // TARGET may span multiple lines; drop `m` so $ is end-of-string.
  const targetMatch = raw.match(/TARGET:\s*([\s\S]*?)\s*$/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'NONE') as 'TRANSFORM' | 'NONE';
  return {
    verdict,
    instruction: instructionMatch ? instructionMatch[1].trim() : '',
    target: targetMatch ? targetMatch[1].trim() : '',
  };
}

function parseApply(raw: string): ApplyResult {
  const m = raw.match(/REWRITE:\s*([\s\S]*?)\s*$/i);
  return { rewrite: m ? m[1].trim() : '' };
}

function parseVerify(raw: string): VerifyResult {
  const verdictMatch = raw.match(/^VERDICT:\s*(OK|REPAIR)\s*$/im);
  const rewriteMatch = raw.match(/REWRITE:\s*([\s\S]*?)\s*$/i);
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

export interface TransformBlankSourceConfig {
  httpAdapter: HttpAdapter;
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
}

export class TransformBlankSource implements CueSource {
  readonly id = 'transform-blank';
  readonly priority: number;

  private httpAdapter: HttpAdapter;
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private blanks: Record<string, BlankConfig>;
  private log: (msg: string) => void;

  constructor(config: TransformBlankSourceConfig) {
    this.httpAdapter = config.httpAdapter;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.priority = config.priority ?? 93;
    this.blanks = config.blanks ?? {};
    this.log = config.log ?? (() => { /* default: silent */ });
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
    // and getCues() bails with an empty result. The keyword heuristic
    // we used to gate on was brittle (missed "full caps", "fullcaps",
    // etc.) so we let the LLM decide. Cost: one extra ~400ms LLM call
    // per non-transform `_` typed. We previously called this a
    // heuristic via looksLikeImperative() — kept the helper for
    // potential future fast-path uses. See git history for the prior
    // verb/phrase list.
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

      // P1 EXTRACT — split into instruction (pipe-joined for composed)
      // and target.
      const p1Start = Date.now();
      const extractRaw = await this.callLLM(P1_EXTRACT_SYSTEM, `INPUT: ${context.text}`, 2048);
      const ext = parseExtract(extractRaw);
      this.log(`TransformBlank P1 EXTRACT (${Date.now() - p1Start}ms): verdict=${ext.verdict}, instruction="${ext.instruction}", target="${preview(ext.target)}"`);
      if (ext.verdict === 'NONE' || !ext.instruction || !ext.target) {
        this.log(`TransformBlank: bailing — P1 verdict=NONE or empty fields`);
        return { results: [], timing: Date.now() - startTime, model: this.model };
      }

      // P2 APPLY — sequential composition for "X | Y" instructions.
      // Output of step N feeds target of step N+1.
      const parts = ext.instruction.split('|').map(s => s.trim()).filter(Boolean);
      this.log(`TransformBlank P2 APPLY: ${parts.length} step(s) — [${parts.map(p => `"${p}"`).join(', ')}]`);
      let currentTarget = ext.target;
      let lastRewrite = '';
      for (let i = 0; i < parts.length; i++) {
        const inst = parts[i];
        const stepStart = Date.now();
        const applyRaw = await this.callLLM(
          P2_APPLY_SYSTEM,
          `INSTRUCTION: ${inst}\nTARGET: ${currentTarget}`,
          2048,
        );
        const draft = parseApply(applyRaw).rewrite;
        this.log(`TransformBlank P2 APPLY step ${i + 1}/${parts.length} (${Date.now() - stepStart}ms): "${preview(draft)}"`);
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
      const verifyInstruction = parts.join(' and ');
      const p3Start = Date.now();
      const verifyRaw = await this.callLLM(
        P3_VERIFY_SYSTEM,
        `INSTRUCTION: ${verifyInstruction}\nTARGET: ${ext.target}\nDRAFT: ${lastRewrite}`,
        2048,
      );
      const ver = parseVerify(verifyRaw);
      this.log(`TransformBlank P3 VERIFY (${Date.now() - p3Start}ms): verdict=${ver.verdict}, rewrite="${preview(ver.rewrite)}"`);

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
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      reasoning_effort: 'low',
      seed: 42,
    });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    const response = await this.httpAdapter.post(this.endpoint, body, headers);
    const data = JSON.parse(response);
    return data.choices?.[0]?.message?.content ?? '';
  }
}
