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
 * Single fused pipeline — ONE LLM call emits:
 *
 *   { verdict: TRANSFORM|NONE|TASK_*, instruction, rewrite }
 *
 * The call classifies the input, extracts the instruction + target, and
 * produces the full rewritten buffer in one shot. For TRANSFORM cases the
 * runtime uses `rewrite` directly (FULL_REWRITE is the whole final buffer,
 * three-way-merged against live text by the resolver).
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
import { describeLLMCall, dispatchChat, getProvider, type ProviderAdapter } from '../llm-provider';
import { classifyLlmError, renderCharBudgetBlock, type FluidBlankErrorReason } from './fluid-blank-source';
import { detectPartialTransform } from './transform-partial-detector';
import { translateBufferCursorToTargetCursor } from './transform-cursor-translate';
import { injectCursorSentinel, stripCursorSentinel } from '../cursor-sentinel';
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
import {
  resolveTypedSentinels,
  catalogScalarLookup,
  instanceTokenFnBridge,
  jsonFieldAccessor,
  collectAiCallableFetches,
} from '../typed-sentinel';
import { blankClaimsUnderscore } from '../blank-shapes';
import { getDehydrator } from '../dehydrate';

// ============================================================================
// Prompts — ported verbatim from tests/benchmarks/transform-blank/
// ============================================================================
//
// TransformBlank uses a SINGLE fused prompt (`FUSED_SYSTEM`): ONE LLM call
// does classify + extract + apply, emitting VERDICT + INSTRUCTION +
// FULL_REWRITE together (TARGET dropped from the output June 2026 — debug-only, see EXPERIMENTS.md Experiment 13). When you touch the prompt, re-run
// `prod.ts` and update `docs/architecture/transform-blank.md`.
// ============================================================================

// ============================================================================
// FUSED system prompt — the single TransformBlank LLM call
// ============================================================================
//
// Single call that emits VERDICT + INSTRUCTION + FULL_REWRITE in one shot.
// Runs on every provider. Benchmark evidence: tests/benchmarks/transform-blank/
// EXPERIMENTS.md § Experiments 6-8.
//
// Verdict types: TRANSFORM/NONE/TASK_*/GENERATIVE (the GENERATIVE branch is
// signalled by VERDICT=TRANSFORM with empty TARGET). For TRANSFORM cases the
// model produces the rewritten target in REWRITE in the same call; downstream
// code uses REWRITE directly.
// Buffer-length floor above which a fused `VERDICT: NONE` is NOT trusted; the
// call cedes (returns null) so FluidBlank / the next source can handle the `_`
// (see the NONE handling in runFusedAndBuild). Well above any bare lookup
// ("capital of france _", "answer _") so genuine short cedes are unaffected;
// the fused-NONE-under-budget-pressure misfires only show up on long buffers
// (the reported case was ~1.3k chars).
const FUSED_NONE_RETRY_FLOOR = 400;

export const FUSED_SYSTEM = `Read the input and produce a structured edit result.

The input is a sentence with an underscore (_) signalling either an IMPERATIVE INSTRUCTION the user wants applied to surrounding text, OR a command to manage a continuously-running agent task, OR a lookup placeholder (none of those).

Output exactly three labelled lines (FULL_REWRITE may span multiple lines):
VERDICT: TRANSFORM | NONE | TASK_ARM | TASK_ADD | TASK_STOP | TASK_SHOW
INSTRUCTION: <the imperative phrase OR task prompt, _ removed; or empty>
FULL_REWRITE: <the ENTIRE final buffer with the instruction applied AND the instruction phrase + _ removed. Contains ONLY what the user should see. Empty when VERDICT is NONE / TASK_*>

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

GENERATIVE — when the imperative asks to CREATE/GENERATE ("write a poem", "compose an email", "give me 5 startup ideas") AND the input is ONLY that instruction plus _ (no other body text), VERDICT=TRANSFORM, TARGET is empty, FULL_REWRITE contains the generated content. Structure with REAL LINE BREAKS (actual newlines) — poems break each line on its own line, lists put each item on its own line, emails use blank lines between paragraphs. NEVER use " / " (slash) or "\\n" literal text as a line separator; emit the actual newline.

MARKDOWN STYLING — when the instruction asks to DECORATE a named span ("make wilfred bold", "bold the word X", "italicize Y", "underline Z", "strike through W", "make X code") you are NOT rewriting or extracting — you wrap that span in markdown markers IN PLACE. The named span may appear ANYWHERE in the input — including in a sentence BEFORE the instruction, across a period, comma, or line break. VERDICT=TRANSFORM; TARGET = the ENTIRE input minus the instruction phrase + _; FULL_REWRITE = that whole TARGET verbatim, byte-for-byte, with ONLY markdown markers added around the named span (bold → \`**span**\`, italic → \`*span*\`, strike → \`~~span~~\`, code → \`\\\`span\\\`\`). Match the named span case-insensitively but PRESERVE its original casing in the output. NEVER bail to NONE because the styled word sits in a prior sentence — find it and decorate it.

STRUCTURE — when the instruction asks to reshape the TARGET into a markdown block structure: "turn into a list" / "make a list" / "make these bullet points" / "convert to bullets" → put EACH item on its own line prefixed with \`- \` (split the comma- or sequence-separated items; strip filler like "first"/"then"). "make it a heading" / "make this a title" → prefix the line with \`# \`. VERDICT=TRANSFORM, FULL_REWRITE = the restructured TARGET. Keep the items' content verbatim; only the structure changes.

CURSOR ANCHOR — the input may contain a \`[CURSOR]\` marker showing where the user's caret was. When the INSTRUCTION is POSITIONAL — it says to do something "here" or to "this line"/"this paragraph" — apply the edit AT the \`[CURSOR]\` location in FULL_REWRITE: "add a line break here" / "new line here" → insert ONE real newline at \`[CURSOR]\`; "add a paragraph break here" / "new paragraph here" / "split this paragraph here" → insert a blank line (two real newlines) at \`[CURSOR]\`; "insert <text> here" / "add <text> here" → insert <text> at \`[CURSOR]\`. Remove the instruction phrase + _ as usual; preserve all other text verbatim. For NON-positional instructions (translate, capitalise, fix typos, make formal, shorten, rephrase, summarise, bold X, …) IGNORE the \`[CURSOR]\` marker — treat the input as if it weren't there. NEVER emit the literal text "[CURSOR]" in FULL_REWRITE.

FILL PLACEHOLDER (takes precedence over ADD/APPEND below) — when the instruction supplies a VALUE for a named FIELD ("add recipient name Karen", "set date to Monday", "company Acme", "add my name Wilfred", "manager Karen") AND the TARGET already contains a matching placeholder — a bracketed/templated slot (\`[Recipient Name]\`, \`[Your Name]\`, \`[Name]\`, \`[Date]\`, \`[Company]\`, \`[Position]\`, \`{{name}}\`, \`<name>\`, \`___\`, \`xxx\`) or a "Label:" line with an empty value — REPLACE that placeholder IN PLACE with the value and remove the instruction. Do NOT append a new line; do NOT leave the placeholder. Match by keyword overlap between the field word(s) in the instruction and the placeholder text: "recipient name" → \`[Recipient Name]\` (or the closest name slot, e.g. \`[Name]\` / \`[Your Name]\`), "company"/"employer" → \`[Company]\`, "date"/"last day"/"end date" → \`[Date]\` / \`[Last Working Day]\`, "position"/"role"/"title" → \`[Position]\` / \`[Your Role]\`, "name" → the name slot. The value to insert is the instruction's trailing tokens after the field name. Only when NO placeholder plausibly matches does the ADD/APPEND rule below apply. This holds no matter how far the placeholder sits from the trailing _ (e.g. greeting at the top, command at the bottom of a long letter).

ADD / APPEND OVER A BODY — when a CREATE/ADD instruction ("add a paragraph about X", "write a conclusion", "add a section on Y", "append a note about Z", "include a disclaimer") FOLLOWS or SURROUNDS existing body text AND no matching placeholder exists (see FILL PLACEHOLDER above), that body IS the TARGET — NOT a generative no-target request. VERDICT=TRANSFORM, TARGET = the existing body verbatim, and FULL_REWRITE = the existing body PRESERVED VERBATIM with the newly generated content appended at the end on a new paragraph (\\n\\n). Generate the requested content; do not drop, summarise, or replace the body. The presence of body text is decisive: instruction + body → append (body preserved in FULL_REWRITE); instruction alone → generative (FULL_REWRITE is only the generated content). Never bail to NONE just because the body is long or unrelated to the add phrase.

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
9. FULL_REWRITE contains ONLY what the user should see — instruction phrase + _ deleted, all surrounding context preserved verbatim or transformed per the instruction.
10. ADDITION instructions ("add", "append", "include", "write a <section/paragraph/conclusion>") do NOT replace the TARGET — keep the TARGET verbatim and append the new content at the end on a new paragraph (\\n\\n). The body survives; only new text is added. EXCEPTION: if the instruction supplies a VALUE for a named FIELD and a matching placeholder already exists in the TARGET, FILL that placeholder in place instead of appending (see FILL PLACEHOLDER above) — "add recipient name Karen" over a buffer containing \`[Recipient Name]\` fills the slot, it does NOT append a "Recipient Name: Karen" line.

EXAMPLES:

INPUT: change boy to girl _ the boy ran fast
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl
FULL_REWRITE: the girl ran fast

INPUT: he/she swap _ he gave the book to John
VERDICT: TRANSFORM
INSTRUCTION: he/she swap
FULL_REWRITE: she gave the book to John

INPUT: make it british english _ the color of the harbor is gray
VERDICT: TRANSFORM
INSTRUCTION: make it british english
FULL_REWRITE: the colour of the harbour is grey

INPUT: pluralize _ the child found one mouse
VERDICT: TRANSFORM
INSTRUCTION: pluralize
FULL_REWRITE: the children found mice

INPUT: change pet from dog to cat _ the dog wagged its tail and barked at the postman
VERDICT: TRANSFORM
INSTRUCTION: change pet from dog to cat
FULL_REWRITE: the cat swished its tail and meowed at the postman

INPUT: i bought apple and samsung phones online uppercase the brands _
VERDICT: TRANSFORM
INSTRUCTION: uppercase the brands
FULL_REWRITE: i bought APPLE and SAMSUNG phones online

INPUT: My name is Wilfred and I work on opencues. make wilfred bold _
VERDICT: TRANSFORM
INSTRUCTION: make wilfred bold
FULL_REWRITE: My name is **Wilfred** and I work on opencues.

INPUT: pluralize and make past tense _ the child runs to the park
VERDICT: TRANSFORM
INSTRUCTION: pluralize | make past tense
FULL_REWRITE: the children ran to the parks

INPUT: write a poem about the sea _
VERDICT: TRANSFORM
INSTRUCTION: write a poem about the sea
FULL_REWRITE: Waves whisper to the shore,
endless rhythm, salt-bright air,
the sea holds every story.

INPUT: Build a responsive website with HTML, CSS, and JavaScript, with a homepage and a contact form. add a paragraph about security _
VERDICT: TRANSFORM
INSTRUCTION: add a paragraph about security
FULL_REWRITE: Build a responsive website with HTML, CSS, and JavaScript, with a homepage and a contact form.

Security is a priority: serve the site over HTTPS, validate and sanitize all form inputs, guard against SQL injection and XSS, and store any credentials using strong, salted hashing.

INPUT: Dear [Recipient Name],

I am writing to formally resign, effective [Date]. add recipient name Karen _
VERDICT: TRANSFORM
INSTRUCTION: add recipient name Karen
FULL_REWRITE: Dear Karen,

I am writing to formally resign, effective [Date].

INPUT: agentically correct spelling _
VERDICT: TASK_ARM
INSTRUCTION: correct spelling
FULL_REWRITE:

INPUT: capital of france _
VERDICT: NONE
INSTRUCTION:
FULL_REWRITE:

INPUT: click _ to continue
VERDICT: NONE
INSTRUCTION:
FULL_REWRITE:

INPUT: answer this _
VERDICT: NONE
INSTRUCTION:
FULL_REWRITE:

INPUT: answer _
VERDICT: NONE
INSTRUCTION:
FULL_REWRITE:

INPUT: fill in _
VERDICT: NONE
INSTRUCTION:
FULL_REWRITE:

INPUT: what is the answer _
VERDICT: NONE
INSTRUCTION:
FULL_REWRITE:`;

// ============================================================================
// Parsers
// ============================================================================

type ExtractVerdict = 'TRANSFORM' | 'NONE' | 'TASK_ARM' | 'TASK_ADD' | 'TASK_STOP' | 'TASK_SHOW';

interface FusedResult {
  verdict: ExtractVerdict;
  instruction: string;
  target: string;
  rewrite: string;
}

/**
 * Parser for the fused output (`FUSED_SYSTEM` prompt). Reads VERDICT +
 * INSTRUCTION + (FULL_)REWRITE. As of June 2026 the prompt no longer asks
 * for a TARGET line (it was a debug-only echo ≈ the whole buffer — dropped
 * to save output tokens; EXPERIMENTS.md Experiment 13). The TARGET regex
 * is kept tolerant so a model that still emits one is parsed (into the
 * now-vestigial `target` field) rather than leaking it into REWRITE.
 * REWRITE can span multiple lines and is captured to EOF.
 */
function parseFused(raw: string): FusedResult {
  const verdictMatch = raw.match(/^VERDICT:[ \t]*(TRANSFORM|NONE|TASK_ARM|TASK_ADD|TASK_STOP|TASK_SHOW)[ \t]*$/im);
  const instructionMatch = raw.match(/^INSTRUCTION:[ \t]*(.*?)[ \t]*$/im);
  // TARGET may span multiple lines but stops at the FULL_REWRITE: (or
  // legacy REWRITE:) label via lookahead.
  const targetMatch = raw.match(/TARGET:[ \t]*([\s\S]*?)(?=^(?:FULL_)?REWRITE:|\s*$)/im);
  // FULL_REWRITE is the last field — capture to end of output. Accept
  // bare REWRITE: too for back-compat with models that drop the prefix.
  const rewriteMatch = raw.match(/(?:FULL_)?REWRITE:[ \t]*([\s\S]*?)\s*$/i);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'NONE') as ExtractVerdict;
  return {
    verdict,
    instruction: instructionMatch ? instructionMatch[1].trim() : '',
    target: targetMatch ? targetMatch[1].trim() : '',
    rewrite: rewriteMatch ? rewriteMatch[1].trim() : '',
  };
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
 * Lifecycle events emitted by `TransformBlankSource` during the fused
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
  | { type: 'started'; textLen: number; blankIdx: number; llm: string; mode: string }
  /** Outbound PII scrub fired — `count` catalog values were replaced with
   *  [TOKEN]s before dispatch (identity-context safe mode). Display-only
   *  telemetry; the buffer is untouched (dehydration produces an outbound
   *  copy only). See docs/architecture/hydration-dehydration.md. */
  | { type: 'dehydrated'; count: number }
  /** The fused pass completed. Emitted with `pass: 'P1'` carrying the
   *  verdict + extracted instruction + target. (The 'P2'/'P3' members
   *  are retained in the union for back-compat with consumers; the
   *  current single-call pipeline only emits 'P1'.) */
  | { type: 'pass-completed'; pass: 'P1' | 'P2' | 'P3'; latencyMs: number;
      verdict?: string; instruction?: string; target?: string;
      step?: number; totalSteps?: number;
      /** FUSED input precedence — 'rich-text' when markdown
       *  markers were re-injected from MarkdownRender's cache,
       *  'as-typed' when the agent-revert path applied, 'visible'
       *  otherwise. Only set on P1 (the input-bearing pass). Used by
       *  agentic tests to assert the right input path was exercised. */
      source?: 'rich-text' | 'as-typed' | 'visible' }
  /** Pipeline bailed early. `reason` is a stable kebab-case identifier
   *  (FUSED-verdict-none-or-empty, etc.). */
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
  /** Per-feature max-tokens override (`transform-blank-max-tokens:`).
   *  When set, the fused call uses it as the max instead of the
   *  bench-tuned default. Useful for very-long-buffer rewrites that
   *  exceed the default. */
  maxTokens?: number;
  /** Per-feature temperature override (`transform-blank-temperature:`).
   *  Falls back to 0 (deterministic rewrites) when absent. */
  temperature?: number;
  /** OPENCUES.md `max-thinking` toggle (default on). Threaded into the
   *  dispatch ctx so model-thinking.ts resolves the reasoning ceiling vs
   *  reduced level for the fused call. */
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
   * surface what the fused pipeline is doing. Wire to the runtime's
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
   * When set, user-actionable HTTP failures (401, 404, 429, 400, network,
   * model-not-found, insufficient-credits) emit an inline `_` → error
   * substitute instead of silently failing. Wire the same formatter
   * FluidBlank uses (`nativeHostFormatLLMError` from boot-common.ts) so
   * every blank-triggered LLM source produces the same visible error
   * surface — the user always knows WHY their `_` didn't fire. Omit to
   * preserve silent-fail behaviour (legacy default for back-compat with
   * tests + chrome).
   */
  formatErrorAsSubstitute?: (reason: FluidBlankErrorReason, err?: Error, ctx?: { provider?: string; model?: string; endpoint?: string }) => string;
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
  /**
   * Per-input variant pool — caches prior LLM rewrites for each
   * (buffer + provider + model + mode + maxThinking) tuple so that
   * re-triggers on the same buffer can:
   *   - Cycle through prior fresh rewrites instantly (Up arrow walks
   *     the alternatives array — DynDef cycling is unchanged), and
   *   - Periodically generate a NEW fresh rewrite to preserve
   *     variation (real providers don't return byte-identical output
   *     even at temperature=0 + seed=42; users rely on re-trigger to
   *     roll the dice).
   *
   * State machine per key:
   *   - 'building' (entries.length < POOL_SIZE): every trigger is
   *     fresh, accumulates in the pool.
   *   - 'cycling' (entries.length == POOL_SIZE, cyclePos < POOL_SIZE):
   *     trigger serves entries[cyclePos] from cache, cyclePos++.
   *   - 'refreshing' (entries.length == POOL_SIZE, cyclePos == POOL_SIZE):
   *     trigger generates fresh, FIFO-evicts oldest, cyclePos=0.
   *     After: switch back to 'cycling'.
   *
   * Result after warmup: 3 fresh + 3 cache + 1 fresh + 3 cache + 1
   * fresh + … — 75% cache-hit rate during sustained re-trigger flows.
   *
   * Cache lifetime is MODULE-LEVEL (static) — survives source
   * instance rebuilds. On hosts where the resolver rebuilds frequently
   * (chrome's universal-integration flips `supportsCycling()` per
   * focused target; live config-sync from the native-host triggers
   * reloads), an instance-scoped pool would empty between every
   * trigger and the cache would never accumulate entries. The static
   * pool is keyed on (buffer + provider + model + mode + maxThinking)
   * so different configs never collide; the KEY_CAP LRU bound keeps
   * memory bounded as users switch providers / modes.
   *
   * The pool DOES survive across all source instances within the
   * process. This is what we want: re-entering a buffer state after
   * the resolver rebuilt (focus shift, config refresh) still hits
   * cache. Tests must clear it explicitly (see resetVariantPoolForTest).
   */
  private static _variantPool = new Map<string, { entries: string[]; cyclePos: number }>();
  private static readonly VARIANT_POOL_SIZE = 3;
  private static readonly VARIANT_KEY_CAP = 32;
  private maxTokensOverride: number | undefined;
  private temperatureOverride: number | undefined;
  private maxThinking: boolean;
  private blanks: Record<string, BlankConfig>;
  private log: (msg: string) => void;
  private emit: (event: TransformBlankEvent) => void;
  private formatErrorAsSubstitute: ((reason: FluidBlankErrorReason, err?: Error, ctx?: { provider?: string; model?: string; endpoint?: string }) => string) | undefined;

  constructor(config: TransformBlankSourceConfig) {
    this.httpAdapter = config.httpAdapter;
    this.provider = config.provider;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxTokensOverride = config.maxTokens;
    this.temperatureOverride = config.temperature;
    this.maxThinking = config.maxThinking ?? true;
    this.priority = config.priority ?? 93;
    this.blanks = config.blanks ?? {};
    this.log = config.log ?? (() => { /* default: silent */ });
    this.emit = config.onEvent ?? (() => { /* default: silent */ });
    this.formatErrorAsSubstitute = config.formatErrorAsSubstitute;
  }

  supports(context: CueContext): boolean {
    const lower = context.words.map(w => w.toLowerCase());
    const blankIndex = lower.indexOf('_');
    if (blankIndex === -1) return false;

    // Cede when a keyword/shaped blank claims this `_` (shape match, or a
    // non-shaped blank's keyword on the same line). SHARED predicate —
    // identical for FluidBlank / TransformBlank / ConfigIntent so they can't
    // drift (see blankClaimsUnderscore).
    if (blankClaimsUnderscore(context.text, context.words, this.blanks)) return false;

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
    const block = renderIdentityContextCatalogForTransform(ctx, mode, context.sentinelLanguage);
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
    if (!bc) {
      // No ambient blank-context snapshot, but ai-callable LIVE FUNCTIONS may
      // still apply (typed mode) — render them so the LLM can emit calls.
      const fnBlock = context.sentinelLanguage === 'typed' ? (context.aiCallableFnsBlock ?? '') : '';
      return { block: fnBlock, snapshot: undefined };
    }
    const snapshot: BlankContextSnapshot = { fields: bc.fields, catalog: bc.catalog };
    const mode: BlankContextMode = bc.mode;
    let block = renderBlankContextCatalogForTransform(snapshot, mode, context.sentinelLanguage);
    // Phase 4 — append the ai-callable LIVE FUNCTIONS block (typed only) so the
    // LLM emits `[STOCK(ticker=NVDA)]` calls the on-demand pass can resolve.
    if (context.sentinelLanguage === 'typed' && context.aiCallableFnsBlock) {
      block = block + context.aiCallableFnsBlock;
    }
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
  private async resolveSentinels(
    rewrite: string,
    originalBody: string,
    ctx: Identity | undefined,
    blankSnapshot?: BlankContextSnapshot | undefined,
    sentinelLanguage: 'bare' | 'typed' = 'bare',
    aiCallableFns?: ReadonlyMap<string, { blankName: string; tokenPrefix: string }>,
    blankFetch?: (blankName: string, arg: string) => Promise<string | undefined>,
    // Tokens the outbound dehydration pass introduced this call —
    // both-present conflicts (user typed the literal token AND their
    // value appeared in the buffer) stay preserved but get warned.
    // `originalBody` MUST remain the TRUE pre-dehydration text.
    introducedTokens?: ReadonlySet<string>,
  ): Promise<string> {
    const hasIdentity = ctx && ctx.catalog.size > 0;
    const hasBlank = blankSnapshot && blankSnapshot.catalog.size > 0;
    // On-demand ai-callable fetch can resolve tokens even with no pre-fetched
    // catalog, so don't short-circuit when the gate is live.
    const hasOnDemand = sentinelLanguage === 'typed' && !!aiCallableFns && aiCallableFns.size > 0 && !!blankFetch;
    if (!hasIdentity && !hasBlank && !hasOnDemand) return rewrite;
    const catalog = hasIdentity && hasBlank
      ? mergeCatalogs(ctx!.catalog, blankSnapshot!.catalog)
      : hasIdentity
        ? ctx!.catalog
        : hasBlank
          ? blankSnapshot!.catalog
          : new Map<string, string>();
    // Typed grammar (opt-in via `sentinel-language: typed`): resolve the
    // parameterized + nested + field-access forms with the typed-sentinel
    // engine. The scalar lookup is a strict superset of bare matching
    // (exact + canonical), so any flat `[TOKEN]` resolves identically; the
    // engine additionally handles `[STOCK PRICE(ticker=NVDA)]` (bridged to
    // the pre-fetched `[STOCK NVDA]` instance) and nested composition, with
    // validate-and-degrade on unknown ids / bad accessors.
    if (sentinelLanguage === 'typed') {
      let workingCatalog = catalog;
      // Phase 4 — ON-DEMAND parameterized fetch. For ai-callable fn-calls the
      // LLM emitted whose instance isn't already on the shelf, fetch via the
      // capability-gated blankFetch (runtime enforces ai-callable + never a
      // script blank), then merge the results into the catalog so the bridge
      // below resolves them. Pre-fetched instances skip the call.
      if (aiCallableFns && aiCallableFns.size > 0 && blankFetch) {
        const sl0 = catalogScalarLookup(catalog);
        const fetches = collectAiCallableFetches(rewrite, aiCallableFns, sl0)
          .filter(f => !catalog.has(f.instanceToken));
        if (fetches.length) {
          const results = await Promise.all(fetches.map(async f => {
            try { return { tok: f.instanceToken, val: await blankFetch(f.blankName, f.arg) }; }
            catch { return { tok: f.instanceToken, val: undefined as string | undefined }; }
          }));
          const aug = new Map(catalog);
          let got = 0;
          for (const r of results) if (r.val != null && r.val !== '') { aug.set(r.tok, r.val); got++; }
          workingCatalog = aug;
          this.log(`TransformBlank: ai-callable on-demand fetch — ${fetches.length} call(s), ${got} resolved`);
        }
      }
      const scalarLookup = catalogScalarLookup(workingCatalog);
      const r = resolveTypedSentinels(rewrite, {
        scalarLookup,
        callFn: instanceTokenFnBridge(scalarLookup),
        applyAccessor: jsonFieldAccessor,
        originalBody,
        preserveUnknown: true,
        introducedTokens,
      });
      if (r.report.resolved.length || r.report.badAccessors.length) {
        this.log(`TransformBlank: typed-sentinel resolved=${r.report.resolved.length}, degraded=${r.report.degraded.length}, bad-accessors=${r.report.badAccessors.length}, preserved=${r.report.preserved.length}`);
      }
      if (r.report.ambiguous.length) {
        this.log(`TransformBlank: ${r.report.ambiguous.length} ambiguous token(s) (user-typed AND dehydrated) preserved as tokens`);
      }
      return r.output;
    }
    const pp = postProcessContext(rewrite, {
      catalog,
      originalBody,
      preserveUnknown: true,
      introducedTokens,
    });
    if (pp.report.resolved.length || pp.report.tolerantMatches.length) {
      this.log(`TransformBlank: context post-processed (resolved=${pp.report.resolved.length}, tolerant=${pp.report.tolerantMatches.length}, preserved-unknown=${pp.report.stripped.length})`);
    }
    if (pp.report.ambiguous.length) {
      this.log(`TransformBlank: ${pp.report.ambiguous.length} ambiguous token(s) (user-typed AND dehydrated) preserved as tokens`);
    }
    return pp.output;
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();
    const previewLen = 80;
    const preview = (s: string) => s.length > previewLen ? s.slice(0, previewLen) + '…' : s;
    try {
      const blankIdx = context.words.indexOf('_');
      if (blankIdx === -1) return { results: [] };

      const effectiveProvider = this.provider;
      const effectiveModel = this.model;
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
        mode: 'fused',
      });

      // VARIANT POOL — decide fresh dispatch vs cache serve. See the
      // _variantPool field doc for the state machine. On hit we
      // short-circuit the LLM dispatch entirely and return a result
      // carrying the cached rewrite as alternatives[1], with other
      // pool entries at alternatives[2..N] so DynDef cycling (Up
      // arrow) walks the variant history without re-paying.
      const cacheKey = this._computeCacheKey(context);
      const variantChoice = this._selectVariant(cacheKey);
      if (variantChoice.kind === 'cache') {
        this.log(`TransformBlank: variant-cache HIT — serving cached rewrite (pool size ${variantChoice.others.length + 1})`);
        return {
          results: [{
            wordIndex: blankIdx,
            word: '_',
            alternatives: [context.text, variantChoice.rewrite, ...variantChoice.others],
            source: this.id,
            priority: this.priority,
            spanStart: 0,
            spanEnd: context.text.length,
            metadata: {
              // transformTarget intentionally omitted — its absence
              // routes the resolver substitute branch to whole-body
              // replace, which is correct: the cached rewrite IS the
              // post-substitution whole-buffer content.
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
      // entries (may be empty during build phase). These get
      // prepended-after-fresh on the alternatives array at each
      // return site so users can Up-arrow through history without
      // re-dispatching.
      const priorVariants = variantChoice.others;

      // FUSED is the only TransformBlank pipeline. One LLM hop emits
      // VERDICT + INSTRUCTION + FULL_REWRITE; runFusedAndBuild
      // consumes it and builds the CueResult. A null result is a genuine cede
      // (NONE on a short lookup, or a parse miss) — return empty and let
      // FluidBlank / the next source handle the `_`.
      const fusedResult = await this.runFusedAndBuild(context, blankIdx, __pipelineT0, preview, startTime, cacheKey, priorVariants);
      return fusedResult ?? { results: [], timing: Date.now() - startTime, model: this.model };
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
        const text = this.formatErrorAsSubstitute(reason, err, { provider: this.provider.id, model: this.model, endpoint: this.endpoint });
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
      // (no per-call state to reset)
    }
  }

  /**
   * Single-call fused pipeline. One LLM hop emits VERDICT + INSTRUCTION +
   * FULL_REWRITE; this method consumes those and builds the final
   * CueResult (or returns null on a genuine cede / parse miss, so the
   * caller returns empty and the next source handles the `_`).
   *
   * Downstream runtime code (Cycling, BlankFill, etc.) sees the standard
   * CueResult envelope.
   */
  private async runFusedAndBuild(
    context: CueContext,
    blankIdx: number,
    __pipelineT0: number,
    preview: (s: string) => string,
    startTime: number,
    cacheKey: string,
    priorVariants: string[],
  ): Promise<CueSourceResult | null> {
    // Text-source precedence (rich-text > as-typed > visible) so styling
    // + agent-revert behaviour matches.
    const rawExtractText = context.richText ?? context.asTypedText ?? context.text;
    const extractText = rawExtractText;
    const sourceTag = context.richText ? 'rich-text' : context.asTypedText ? 'as-typed' : 'visible';
    // CURSOR ANCHOR — positional instructions ("add a line break here",
    // "split this paragraph here", "insert X here") need to know WHERE the
    // user's caret was. Inject a [CURSOR] marker into the input at the
    // translated caret offset. GATED on a positional cue in the input so
    // the ~95% of non-positional transforms don't carry a marker that
    // could distract the single fused classify+apply call. The prompt's
    // CURSOR ANCHOR rule tells the model to ignore [CURSOR] for
    // non-positional instructions; the gate is belt-and-braces for the
    // fused single-call shape (3-pass could afford an always-on marker
    // because its EXTRACT classifier ran cursor-blind).
    const POSITIONAL_CUE = /\b(here|this line|this paragraph|new line|new paragraph|line break|paragraph break)\b/i;
    // DEHYDRATION (outbound PII scrub) — in `safe` mode, identity values
    // the user TYPED are replaced with [TOKEN]s before the buffer ships
    // to the provider; resolveSentinels hydrates the FULL_REWRITE back
    // to value space before it leaves this source, so the runtime's
    // three-way merge / spans / variant pool never see token
    // coordinates. Outbound COPY only — `extractText`/`context.text`
    // stay original. See docs/architecture/hydration-dehydration.md.
    const idCtx = context.identityContext;
    const dehydrator = idCtx && idCtx.mode === 'safe' && idCtx.catalog.size > 0
      ? getDehydrator(idCtx.catalog, (m) => this.log(`TransformBlank: ${m}`))
      : undefined;
    const dInput = dehydrator?.dehydrate(extractText);
    const outboundText = dInput?.changed ? dInput.text : extractText;
    const introducedTokens = dInput?.changed ? dInput.introduced : undefined;
    if (dInput?.changed) {
      this.log(`TransformBlank: dehydrated ${dInput.spans.length} value(s) → tokens (outbound PII scrub)`);
      this.emit({ type: 'dehydrated', count: dInput.spans.length });
    }
    let inputForLLM = outboundText;
    if (POSITIONAL_CUE.test(extractText)) {
      // Cursor is computed on ORIGINAL coordinates, then mapped into the
      // dehydrated text. mapOffset snaps a mid-value caret to the token
      // boundary — the sentinel must never split a value
      // (`Wil[CURSOR]fred` would defeat matching and leak fragments).
      const curOffset = translateBufferCursorToTargetCursor(context.text, context.cursor ?? -1, extractText);
      if (curOffset >= 0) {
        const outOffset = dInput?.changed ? dInput.mapOffset(curOffset, 'right') : curOffset;
        inputForLLM = injectCursorSentinel(outboundText, outOffset);
        this.log(`TransformBlank FUSED: [CURSOR] injected at offset ${outOffset}/${outboundText.length} (positional cue${dInput?.changed ? ', dehydrated coords' : ''})`);
      }
    }
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
    // Prediction ships the DEHYDRATED text: (a) the raw buffer riding
    // the `prediction` param was a PII leak channel of its own, and
    // (b) the model's echo is in token space anyway, so speculation
    // acceptance is higher against the dehydrated bytes.
    const fusedPrediction = extractText.length >= PREDICTION_MIN_CHARS ? outboundText : undefined;
    // FIELD LIMIT rides the USER message (per-call context — never a
    // system-prefix salt) when the host declared a small field
    // capacity. Bench prompts unaffected: benches never set a budget.
    const fusedRaw = await this.callLLM(fusedSystem, `INPUT: ${inputForLLM}${renderCharBudgetBlock(context.answerCharBudget)}`, fusedTokens, undefined, context.signal, fusedPrediction);
    const fParsedRaw = parseFused(fusedRaw);
    // Strip any [CURSOR] the model leaked into FULL_REWRITE — input-only
    // marker, must never reach the buffer.
    const fParsed = { ...fParsedRaw, rewrite: stripCursorSentinel(fParsedRaw.rewrite) };
    // Resolve IDENTITY.md sentinels + ambient blank-context tokens in
    // FULL_REWRITE before the result routes through the runtime's three-
    // way merge. Preserves unknown brackets so LLM-emitted placeholders
    // for non-user entities ([Recipient Name], [Date]) survive untouched.
    const f = {
      ...fParsed,
      rewrite: await this.resolveSentinels(fParsed.rewrite, context.text, fusedUserCtx, fusedBlankSnapshot, context.sentinelLanguage, context.aiCallableFns, context.blankFetch, introducedTokens),
    };
    this.log(`TransformBlank FUSED (${Date.now() - fusedStart}ms, max_tokens=${fusedTokens}, source=${sourceTag}): verdict=${f.verdict}, instruction="${f.instruction}", target="${preview(f.target)}", rewrite="${preview(f.rewrite)}"`);
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

    // TASK BRANCH — agent-task commands. The runtime's resolver consumes
    // the metadata.taskAction shape.
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
      // A NONE on a SHORT buffer is a genuine cede — a bare lookup like
      // "capital of france _" that FluidBlank should answer. But the fused
      // path has to emit the ENTIRE rewritten buffer (FULL_REWRITE) in one
      // shot, and cerebras gpt-oss-120b INTERMITTENTLY returns VERDICT: NONE
      // under that output/reasoning-budget pressure on a long buffer even
      // when there IS a clear trailing imperative (symptom: a chained
      // "make it all make sense structurally _" on a ~1.3k-char buffer
      // silently does nothing). On a long buffer, don't trust a fused NONE —
      // cede (return null) so the next source can take a fresh look rather
      // than letting a budget-pressure misfire silently drop the edit.
      if (context.text.length > FUSED_NONE_RETRY_FLOOR) {
        this.log(`TransformBlank FUSED: verdict=NONE on a long buffer (${context.text.length} chars) — not trusting it; ceding`);
        return null;
      }
      this.log('TransformBlank FUSED: bailing — verdict=NONE or empty instruction');
      this.emit({ type: 'bailed', reason: 'FUSED-verdict-none-or-empty', latencyMs: Date.now() - __pipelineT0 });
      return { results: [], timing: Date.now() - startTime, model: this.model };
    }

    // For TRANSFORM (with or without target), REWRITE must be non-empty —
    // we either have the rewritten target or the generated content.
    // Empty rewrite means the model parsed the input but couldn't produce
    // the result in one call → cede (return null).
    if (!f.rewrite) {
      this.log('TransformBlank FUSED: empty rewrite — ceding');
      return null;
    }

    // Whole-buffer contract (May 2026 — FULL_REWRITE replaces
    // REWRITE-of-target). The LLM owns the entire rewritten buffer;
    // the runtime three-way-merges it against the live text. This
    // structurally eliminates the duplication bug class that arose
    // when narrow-TARGET + wide-REWRITE made the splice path concat
    // an already-rewritten tail. No detector needed.
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
    // Record the fresh rewrite into the variant pool — subsequent
    // identical-buffer triggers will cycle through cached variants
    // (see _variantPool docs for the state machine). FIFO eviction
    // when at capacity, so the just-recorded rewrite is the most
    // recent and an older entry may have just been dropped.
    this._recordFreshRewrite(cacheKey, f.rewrite);
    // Re-read the pool POST-RECORD to get the actually-cached
    // siblings (priorVariants was captured pre-record and may
    // include an entry that's now been evicted).
    const postRecordOthers = (TransformBlankSource._variantPool.get(cacheKey)?.entries ?? [])
      .filter(r => r !== f.rewrite);
    const result: CueResult = {
      wordIndex: blankIdx,
      word: '_',
      // alternatives shape: [original, fresh, ...other-pool-entries].
      // Up-arrow walks alternatives[2..N] = prior cached variants;
      // Down-arrow walks to alternatives[0] = original (revert).
      alternatives: [context.text, f.rewrite, ...postRecordOthers],
      source: this.id,
      priority: this.priority,
      spanStart: 0,
      spanEnd: context.text.length,
      metadata: {
        // INSTRUCTION kept for debug + event payloads. TARGET is no longer
        // emitted (dropped June 2026; `f.target` is empty) — it was CoT
        // scaffolding, NOT splice geometry.
        // `transformTarget` is intentionally omitted from the metadata
        // shape the runtime reads for substitution: its presence on a
        // result is the signal to take the surgical-splice path. Whole-
        // buffer fused results skip that branch and route through
        // `threeWayMerge` instead.
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

  private async callLLM(
    system: string,
    user: string,
    maxTokens: number,
    responseFormat?: { name: string; strict?: boolean; schema: Record<string, unknown> },
    signal?: AbortSignal,
    /** Predicted-outputs hint — see cerebras.md § Predicted Outputs.
     *  Cerebras surfaces this on gpt-oss-120b; other providers ignore
     *  the field. Pass the BODY being transformed (original buffer
     *  text); the rewrite will share ~50-95% of byte content for
     *  typical transformations. */
    prediction?: string,
  ): Promise<string> {
    // Per-feature override (`transform-blank-max-tokens:` /
    // `transform-blank-temperature:`). When set, applies to the fused
    // call instead of the bench-tuned default — covers the long-buffer-
    // rewrite use case.
    const effectiveMaxTokens = this.maxTokensOverride ?? maxTokens;
    return dispatchChat(
      this.provider,
      this.httpAdapter,
      {
        model: this.model,
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
        apiKey: this.apiKey,
        endpoint: this.endpoint,
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
   * maxThinking. Excludes identity / blank context VALUES
   * — those are substituted post-LLM by the post-processor in `safe`
   * mode, so the cached rewrite (which carries `[TOKEN]` names) re-
   * substitutes against current values on each hit and stays correct
   * even as values drift. In `raw` mode values do affect the LLM input;
   * cached entries may serve slightly-stale-valued rewrites then. The
   * trade-off was deliberate (most users are on `safe` mode; raw users
   * get a minor cosmetic staleness window between context refreshes).
   */
  private _computeCacheKey(context: CueContext): string {
    const providerId = this.provider.id;
    const model = this.model;
    const SEP = '\x1f';  // ASCII unit separator — won't collide with text content
    return [
      context.text,
      providerId,
      model,
      'fused',
      this.maxThinking ? 'maxT' : 'minT',
    ].join(SEP);
  }

  /**
   * Decide whether to dispatch fresh or serve from the variant pool.
   * Returns the chosen primary rewrite (or null if we must dispatch
   * fresh). Also returns the pool state's "other" entries so the
   * caller can enrich the alternatives array.
   *
   * State machine semantics — see the _variantPool field doc.
   *
   * Pool is updated by this method (cyclePos advances on cache hit;
   * the FRESH path is responsible for calling _recordFreshRewrite()
   * AFTER dispatch succeeds).
   */
  private _selectVariant(key: string): { kind: 'cache'; rewrite: string; others: string[] } | { kind: 'fresh'; others: string[] } {
    let entry = TransformBlankSource._variantPool.get(key);
    if (!entry) {
      entry = { entries: [], cyclePos: 0 };
      TransformBlankSource._variantPool.set(key, entry);
    } else {
      // LRU recency.
      TransformBlankSource._variantPool.delete(key);
      TransformBlankSource._variantPool.set(key, entry);
    }

    // Building phase — pool not yet full.
    if (entry.entries.length < TransformBlankSource.VARIANT_POOL_SIZE) {
      return { kind: 'fresh', others: entry.entries.slice() };
    }

    // Cycling phase — pool full, serve next.
    if (entry.cyclePos < entry.entries.length) {
      const rewrite = entry.entries[entry.cyclePos];
      entry.cyclePos++;
      const others = entry.entries.filter((_, i) => i !== entry!.cyclePos - 1);
      return { kind: 'cache', rewrite, others };
    }

    // Refresh phase — cycle done, generate fresh.
    return { kind: 'fresh', others: entry.entries.slice() };
  }

  /**
   * Record a fresh LLM rewrite into the variant pool. Called by the
   * dispatch path after a successful LLM call. Handles FIFO eviction
   * when the pool is at capacity (preserves variation by always
   * adding the newest, dropping the oldest).
   */
  private _recordFreshRewrite(key: string, rewrite: string): void {
    let entry = TransformBlankSource._variantPool.get(key);
    if (!entry) {
      // Defensive — shouldn't happen since _selectVariant always
      // creates the entry. Fall through gracefully.
      entry = { entries: [], cyclePos: 0 };
      TransformBlankSource._variantPool.set(key, entry);
    }

    // FIFO eviction at capacity. Reset cyclePos so the next trigger
    // walks the new pool from the start.
    if (entry.entries.length >= TransformBlankSource.VARIANT_POOL_SIZE) {
      entry.entries.shift();
    }
    entry.entries.push(rewrite);
    entry.cyclePos = 0;

    // LRU cap on distinct keys.
    while (TransformBlankSource._variantPool.size > TransformBlankSource.VARIANT_KEY_CAP) {
      const oldest = TransformBlankSource._variantPool.keys().next().value;
      if (oldest === undefined) break;
      TransformBlankSource._variantPool.delete(oldest);
    }
  }

  /** For tests + diagnostics — current pool size for a given key. */
  variantPoolSize(key: string): number {
    return TransformBlankSource._variantPool.get(key)?.entries.length ?? 0;
  }

  /** For tests — re-expose the key derivation. */
  cacheKeyForTest(context: CueContext): string {
    return this._computeCacheKey(context);
  }

  /** Test-only: empty the module-level variant pool. Without this,
   *  test order would matter — a pool populated by one test would
   *  leak into the next. Production code must NEVER call this; the
   *  pool's LRU bound handles real-world memory growth. */
  static resetVariantPoolForTest(): void {
    TransformBlankSource._variantPool.clear();
  }
}
