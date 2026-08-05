/**
 * opencues-core/sources/sentence-cue-source.ts
 *
 * Sentence-scope cue. A cue whose CUE.md frontmatter declares
 * `scope: sentence` operates on whole sentences instead of individual
 * words: it segments the buffer, then fires ONE LLM CALL PER SENTENCE
 * (concurrency-capped — see `SENTENCE_CUE_CONCURRENCY` / `mapWithConcurrency`)
 * and emits one CueResult per sentence with
 * `alternatives = [originalSentence, ...alts]` and char-range
 * spanStart/spanEnd. Cycling Up/Down in the runtime swaps the
 * sentence in place (TransformBlank-style; uses the existing
 * multi-word substitution branch).
 *
 * ## Why one call per sentence (NOT one batched call)
 *
 * The original design batched all N sentences into one call and asked the
 * model to return a labelled block per sentence. That made the model
 * intermittently DROP a sentence (~1/3 of runs on a 4-sentence CJK buffer,
 * usually the longest) — no error, no cede, it just omitted one — and forced
 * fragile scaffolding (echo-each-sentence, numbered slots, text-matching back
 * to source spans, token-budget scaling, retry passes) purely to re-align the
 * response. A single-sentence call can't "drop one of N": there's one slot,
 * and we already KNOW the sentence + its char span, so no matching is needed.
 * Measured: per-sentence is 100% coverage vs ~66% batched, at the same wall-
 * clock (the calls run in parallel). Prefix caching is NOT the reason it's
 * cheap — the per-sentence system prompt is only ~256 cacheable tokens, so
 * `cached_tokens` saves negligible latency here (unlike the 20k-token fused
 * blank prompts); the speed comes from parallelism + fast generation.
 * Principle: never overload one call with N independent jobs.
 *
 * Priority sits BETWEEN word-cues and BlankSource so a sentence-cue
 * for a sentence containing a word-cue'd word wins (per the design
 * decision; suppression of overlapping word-cues is enforced in
 * resolver.ts).
 *
 * ## Prompt composition
 *
 * The user's `promptText` is the STABLE system message (cerebras caches its
 * prefix across all per-sentence calls), wrapped with a framework-supplied
 * `SINGLE_SENTENCE_FORMAT_SPEC` (return `ALT:` lines, or `ALT: NONE`). The
 * one sentence under analysis is the only per-call content, sent in the user
 * message as `SENTENCE: <text>`. The user writes the *intent* ("Rewrite each
 * sentence to be more formal..."); the framework appends the output format.
 *
 * ## Cede semantics
 *
 * Sentence cues cede when:
 *  - The buffer contains a `_` — user is in blank-flow mode, not
 *    prose-flow mode; the `_`-claiming sources (BlankSource /
 *    TransformBlank / FluidBlank / ConfigIntent) take precedence.
 *  - Per-sentence: the LLM emits `ALT: NONE` (sentence is too short /
 *    not prose / already meets the cue's intent).
 *
 * ## Bench provenance
 *
 * Prompt + parser validated at `tests/benchmarks/sentence-cues/`. v1
 * scored 100% recall + 100% precision on the 30-case `more-formal`
 * suite across all 5 providers. Re-run that bench when editing
 * `SINGLE_SENTENCE_FORMAT_SPEC` or the segmenter.
 */

import { CueSource, CueContext, CueSourceResult, CueResult, HttpAdapter } from '../types';
import { SourceConfig } from '../cues-md';
import { inferFieldCompat } from '../host-compat';
import { describeLLMCall, dispatchChat, type ProviderAdapter } from '../llm-provider';
import { getDehydrator } from '../dehydrate';
import { postProcessContext } from '../identity-context';
import { renderCalendarContextForCue, type CalendarContextSnapshot } from '../calendar-context';

/** Local wall-clock ISO `YYYY-MM-DDTHH:MM` — for the calendar cue's live
 *  now-anchor (mirrors fluid-blank-source's helper). */
function localWallClockIso(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ============================================================================
// Sentence segmenter — regex-based, robust over linguistic perfection
// ============================================================================

export interface SentenceSpan {
  /** Sentence text including its terminator. */
  text: string;
  /** Inclusive char offset in the original buffer. */
  start: number;
  /** Exclusive char offset (end of the terminator). */
  end: number;
  /** Word index of the first word of the sentence. */
  firstWordIndex: number;
}

/**
 * Split a buffer into sentences with char + word offsets.
 *
 * Strategy: match sentence CONTENT non-greedily up to a real terminator.
 * A terminator is an ASCII `.!?` followed by whitespace or EOF, OR a
 * CJK/fullwidth `。！？．`, OR a HARD LINE BREAK (`\n`), OR end-of-string.
 *
 * A newline terminates a sentence even without punctuation: content on
 * separate visual lines is never one sentence. Without this a buffer like
 * "thanks a bunch guys\ndasdasda" (two lines, no `.` between them) matched
 * as ONE span crossing the newline — so its cue highlight painted across
 * BOTH lines and cycling replaced text spanning two lines (observed live on
 * Gmail). It also makes the "markdown headers / list items are each their
 * own sentence" behaviour (below) actually hold — those are `\n`-separated.
 *
 * The content run is `[\s\S]+?` (any char, non-greedy) rather than a
 * "non-terminator" character class, so a MID-TOKEN ASCII period —
 * "WCAG 2.1", "gpt-5.4", "e.g.", an IP, a URL — is kept as content
 * instead of breaking the run. The earlier `[^.!?。！？．]+` class stopped
 * at every `.`/`!`/`?`; when that mid-token `.` wasn't a real terminator
 * (no trailing space) the regex couldn't complete and SKIPPED the text
 * before it — dropping "アクセシビリティ（WCAG 2." entirely so it was never
 * cue-able (observed live on Claude Code).
 *
 * CJK/fullwidth terminators (`。！？．`) split directly because those
 * scripts don't put a space after the stop — without them a Japanese /
 * Chinese paragraph collapsed into ONE giant "sentence". The CJK comma
 * `、` is deliberately NOT a terminator. Trim each match so leading /
 * trailing whitespace stays in the buffer.
 *
 * Known limitations (intentional v1 simplifications):
 *  - Abbreviations ("Mr. Smith") still split when the period is followed
 *    by a space — indistinguishable from a sentence end without a lexicon.
 *  - Markdown-style headers / lists treated as single sentences.
 *
 * These are mitigated downstream by the LLM emitting `ALT: NONE` on
 * fragments / non-prose. Production cost is acceptable for v1.
 */
export function segmentSentences(buffer: string, words: ReadonlyArray<string>): SentenceSpan[] {
  if (!buffer) return [];
  const spans: SentenceSpan[] = [];
  // `[\s\S]+?` (≥1 char, non-greedy) can never produce a zero-width match,
  // so the exec loop below always advances.
  const re = /[\s\S]+?(?:[.!?]+(?=\s|$)|[。！？．]+|\n+|$)/g;
  // Zero-width characters: ZWSP (U+200B) + ZWNJ (U+200C) — Claude Code's
  // render-kick toggles these onto the buffer to force a repaint (see the CC
  // ZWS-strip-at-boundaries contract). They are NOT content: a buffer ending
  // in a render-kick `‌` must not segment that lone char as its own
  // "sentence" (which then pollutes the sentence count, collides on the last
  // word, and can bump the REAL final sentence out of registration — the
  // "実施されます。 left out" bug). Treat them like whitespace at span edges,
  // and skip a span that is nothing but zero-width / whitespace.
  const ZW = /[​‌﻿]/g;
  const trimEdges = (s: string): string => s.replace(/^[\s​‌﻿]+/, '').replace(/[\s​‌﻿]+$/, '');
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    const raw = m[0];
    const trimmed = trimEdges(raw);
    // Empty after trimming, or zero real content (only zero-width left) →
    // not a sentence.
    if (!trimmed || !trimmed.replace(ZW, '').trim()) continue;
    const start = m.index + raw.indexOf(trimmed[0]);
    const end = start + trimmed.length;
    spans.push({ text: trimmed, start, end, firstWordIndex: -1 });
  }
  // Map char-start to word-index. Words array indexes whitespace-split
  // tokens; build a parallel offset array.
  let charCursor = 0;
  const wordCharStart: number[] = [];
  for (const w of words) {
    const idx = buffer.indexOf(w, charCursor);
    if (idx === -1) { wordCharStart.push(-1); continue; }
    wordCharStart.push(idx);
    charCursor = idx + w.length;
  }
  for (const span of spans) {
    let firstWordIndex = wordCharStart.findIndex(idx => idx >= span.start && idx < span.end);
    if (firstWordIndex === -1) {
      // No word STARTS inside this sentence. This is the spaceless-CJK case:
      // the sentence begins mid-word because the PRIOR sentence's 。 has no
      // following space, so its first chars share a whitespace-word with the
      // prior sentence. Anchor to the word that CONTAINS the sentence start
      // (the last word starting at/before it) — NOT the old fallback of 0,
      // which made every such sentence collide with the FIRST sentence at
      // word 0 and get dropped at registration (the long-second-sentence
      // "not highlighted" bug).
      let containing = 0;
      for (let i = 0; i < wordCharStart.length; i++) {
        const ws = wordCharStart[i];
        if (ws === -1) continue;
        if (ws <= span.start) containing = i; else break;
      }
      firstWordIndex = containing;
    }
    span.firstWordIndex = firstWordIndex;
  }
  return spans;
}

// ============================================================================
// Output-format spec — appended to the user's per-cue promptText
// ============================================================================

// Per-sentence output format — the user message carries exactly ONE sentence
// ("SENTENCE: <text>"), so the model just returns its rewrites. No SENTENCE:
// echo to match back, no "---" separators, no "emit exactly N" — there's one
// sentence, so there's nothing to drop or misalign.
export const SINGLE_SENTENCE_FORMAT_SPEC = `You are given ONE sentence (after "SENTENCE:"). Return up to 3 rewrites of THAT sentence, one per line:
ALT: <rewrite 1>
ALT: <rewrite 2>
ALT: <rewrite 3>

If the sentence needs no change — it's a fragment / greeting, it's technical (code / commands / URLs / identifiers), or it already meets the intent — return exactly:
ALT: NONE

RULES PER ALT:
  1. Preserve MEANING — semantically equivalent, no info added/dropped.
  2. Preserve PUNCTUATION shape (questions stay questions, etc.).
  3. Each ALT must be a complete sentence.
  4. ALTS should be DISTINCT — fewer distinct alts beats three near-identical ones.

DO NOT include the original sentence. Output ONLY ALT: lines, nothing else.`;

function hasFormatSpec(text: string): boolean {
  return /^\s*ALT:/m.test(text);
}

/**
 * Output-token budget for ONE sentence's call. Per-sentence calls keep this
 * small (no multi-sentence accumulation that used to truncate). Up to 3 alts,
 * each ~the sentence's length; CJK worst case ~1.6 output tokens/char; plus
 * reasoning headroom (gpt-oss at medium burns a chunk before content). Clamped
 * to [768, 8192].
 */
export function estimateSentenceCueBudget(sentenceCharLengths: ReadonlyArray<number>): number {
  const totalChars = sentenceCharLengths.reduce((n, len) => n + len, 0);
  const estimatedOutput = Math.ceil(totalChars * 1.6 * 3) + sentenceCharLengths.length * 24 + 1024;
  return Math.min(8192, Math.max(768, estimatedOutput));
}

/** Max concurrent per-sentence LLM calls. A "queue of sorts": a long buffer
 *  resolves through this cap instead of firing every sentence at once, so the
 *  provider isn't hammered while still overlapping the round-trips. */
export const SENTENCE_CUE_CONCURRENCY = 5;

/** Run `fn` over `items` with at most `limit` in flight at once; preserves
 *  input order in the result array. */
export async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

// ============================================================================
// Parser
// ============================================================================

export interface SingleSentenceAlts {
  alts: string[];
  /** True if the model returned ALT: NONE (legitimately declined to rewrite). */
  ceded: boolean;
}

/**
 * Parse a per-sentence response: just the `ALT:` lines for the one sentence we
 * asked about. No SENTENCE: echo, no "---" separators, no matching — the call
 * was scoped to a single known sentence. Leading whitespace tolerated (models
 * often indent), `ALT: NONE` → ceded.
 */
export function parseSingleSentenceAlts(raw: string): SingleSentenceAlts {
  const alts: string[] = [];
  let ceded = false;
  const altLines = raw.match(/^[ \t]*ALT:\s*(.*?)\s*$/gm) ?? [];
  for (const line of altLines) {
    const value = line.replace(/^[ \t]*ALT:\s*/, '').trim();
    if (!value) continue;
    if (value.toUpperCase() === 'NONE') { ceded = true; continue; }
    if (!alts.includes(value)) alts.push(value);
  }
  return { alts, ceded };
}

// ============================================================================
// Source
// ============================================================================

export type SentenceCueEvent =
  | { type: 'started'; textLen: number; sentenceCount: number; llm: string }
  | { type: 'completed'; emitted: number; ceded: number; latencyMs: number }
  | { type: 'bailed'; reason: string; latencyMs: number };

export interface SentenceCueSourceConfig {
  httpAdapter: HttpAdapter;
  provider: ProviderAdapter;
  endpoint: string;
  apiKey: string;
  model: string;
  /** Per-cue config — supplies promptText, priority, name. */
  sourceConfig: SourceConfig;
  /** Default priority when sourceConfig.priority is absent. */
  defaultPriority?: number;
  /** OPENCUES.md `max-thinking` toggle (default on). Threaded into the
   *  dispatch ctx for the reasoning-budget resolution in model-thinking.ts. */
  maxThinking?: boolean;
  log?: (msg: string) => void;
  onEvent?: (event: SentenceCueEvent) => void;
}

export class SentenceCueSource implements CueSource {
  readonly id: string;
  readonly priority: number;
  /** Sentence cues offer alternatives → cycleable. Universal-Integration
   *  hosts (no cycling surface) prune them upstream. */
  readonly isCycleable = true;

  private httpAdapter: HttpAdapter;
  private provider: ProviderAdapter;
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private maxThinking: boolean;
  private sourceConfig: SourceConfig;
  private log: (msg: string) => void;
  private emit: (event: SentenceCueEvent) => void;

  constructor(config: SentenceCueSourceConfig) {
    this.httpAdapter = config.httpAdapter;
    this.provider = config.provider;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxThinking = config.maxThinking ?? true;
    this.sourceConfig = config.sourceConfig;
    this.id = `sentence-cue:${config.sourceConfig.name}`;
    this.priority = config.sourceConfig.priority ?? config.defaultPriority ?? 85;
    this.log = config.log ?? (() => { /* silent */ });
    this.emit = config.onEvent ?? (() => { /* silent */ });
  }

  supports(context: CueContext): boolean {
    if (!context.text || !context.text.trim()) return false;
    // Field-kind scoping (`on-field:` / `not-on-field:`). A cue that declares
    // `not-on-field: single-line` cedes in a single-line field (search box /
    // omnibox) — evaluated per-resolve against the host's field declaration.
    // No declaration, or a host that reports no field shape → runs as before.
    if (!inferFieldCompat(this.sourceConfig, context.ambient)) return false;
    // Cede when the user is in blank-flow mode — `_` means a blank
    // source is going to claim. Sentence-cues are prose-time, not
    // blank-time.
    if (context.words.some(w => w === '_')) return false;
    // A calendar-aware cue (uses-calendar-context) is SELF-INERT when there's no
    // ingested calendar — `calendar-context-mode: off` (or an empty snapshot)
    // means the resolver forwards no `calendarContext`, so there's nothing to
    // check against. Cede rather than spend an LLM call per sentence.
    if (this.sourceConfig.usesCalendarContext
      && (!context.calendarContext || context.calendarContext.events.length === 0)) return false;
    // Need at least one sentence-shaped chunk. The segmenter is
    // tolerant — anything with a subject+verb shape will emit at
    // least one span; the LLM cedes per-sentence if the content is
    // not prose.
    const spans = segmentSentences(context.text, context.words);
    return spans.length > 0;
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const t0 = Date.now();
    const spans = segmentSentences(context.text, context.words);
    if (spans.length === 0) {
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    const llmDesc = describeLLMCall(this.provider, this.model, undefined, {
      maxTokens: this.sourceConfig.maxTokens, temperature: this.sourceConfig.temperature,
    });
    this.log(`SentenceCue[${this.sourceConfig.name}]: starting (textLen=${context.text.length}, sentences=${spans.length}, llm=${llmDesc})`);
    this.emit({ type: 'started', textLen: context.text.length, sentenceCount: spans.length, llm: llmDesc });

    const promptText = this.sourceConfig.promptText;
    if (!promptText) {
      this.log(`SentenceCue[${this.sourceConfig.name}]: skipping — no promptText`);
      this.emit({ type: 'bailed', reason: 'no-prompt-text', latencyMs: Date.now() - t0 });
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    // ONE LLM CALL PER SENTENCE — never batch N sentences into one call.
    // Batching made the model intermittently DROP a sentence (~1/3 of runs on
    // a 4-sentence CJK buffer, usually the longest) and forced fragile
    // scaffolding (echo-each-sentence, numbered slots, text-matching, retry,
    // budget-scaling) just to re-align the response to the source sentences.
    // A single-sentence call can't "drop one of N" — there's one slot — and
    // we already KNOW the sentence + its char span, so no matching is needed.
    // The cue's promptText + format spec live in the STABLE system message
    // (cerebras caches that prefix across all per-sentence calls ~99.5%, so N
    // calls cost barely more than one on TTFT); only the one sentence varies
    // in the user message. Calls run through a small concurrency cap so a
    // long buffer doesn't hammer the provider.
    // Calendar-aware cue (uses-calendar-context): append the ingested calendar
    // (events + times as [EVENT N] tokens + a live now-anchor) to the STABLE
    // system message so the LLM can detect a scheduling contradiction in the
    // user's sentence. The cue's promptText owns the task; this adds the data.
    const lifeSnapshot: CalendarContextSnapshot | undefined =
      this.sourceConfig.usesCalendarContext && context.calendarContext
        ? { events: context.calendarContext.events, catalog: context.calendarContext.catalog, ingestedAt: context.calendarContext.ingestedAt }
        : undefined;
    const lifeBlock = lifeSnapshot
      ? renderCalendarContextForCue(lifeSnapshot, 'on', localWallClockIso(new Date()))
      : '';
    if (lifeBlock) {
      this.log(`SentenceCue[${this.sourceConfig.name}]: calendar-context injected (${lifeSnapshot!.events.length} event${lifeSnapshot!.events.length === 1 ? '' : 's'})`);
    }
    const basePrompt = hasFormatSpec(promptText)
      ? promptText.trimEnd()
      : `${promptText.trimEnd()}\n\n${SINGLE_SENTENCE_FORMAT_SPEC}`;
    const system = `${basePrompt}${lifeBlock}`;

    // DEHYDRATION (outbound PII scrub) — in identity-context `safe`
    // mode, catalog values inside each sentence are replaced with
    // [TOKEN]s before the sentence ships; returned alternatives are
    // hydrated back below (preserveUnknown so LLM-emitted placeholders
    // survive). `span.text`, offsets, and alternatives[0] stay original.
    const idCtx = context.identityContext;
    const dehydrator = idCtx && idCtx.mode === 'safe' && idCtx.catalog.size > 0
      ? getDehydrator(idCtx.catalog, (m) => this.log(`SentenceCue[${this.sourceConfig.name}]: ${m}`))
      : undefined;

    const matched: Array<string[] | 'ceded' | null> = await mapWithConcurrency(
      spans,
      SENTENCE_CUE_CONCURRENCY,
      async (span) => {
        if (context.signal?.aborted) return null;
        try {
          const budget = this.sourceConfig.maxTokens ?? estimateSentenceCueBudget([span.text.length]);
          const dSpan = dehydrator?.dehydrate(span.text);
          const outbound = dSpan?.changed ? dSpan.text : span.text;
          if (dSpan?.changed) {
            this.log(`SentenceCue[${this.sourceConfig.name}]: dehydrated ${dSpan.spans.length} value(s) → tokens (outbound PII scrub)`);
          }
          const raw = await this.callLLM(system, `SENTENCE: ${outbound}`, budget, context.signal);
          const parsed = parseSingleSentenceAlts(raw);
          if (parsed.ceded) return 'ceded';
          if (parsed.alts.length === 0) return null;
          // Hydration catalog = identity sentinels (safe mode) PLUS the
          // calendar's [EVENT N] → title map (uses-calendar-context). The
          // conflict alternative names the clashing event by token; hydrate
          // it to the real title locally. Failure keeps the raw alternative
          // (visible token, revertable via alternatives[0]).
          const hydrationCatalog = new Map<string, string>(idCtx?.catalog ?? []);
          if (lifeSnapshot) for (const [t, v] of lifeSnapshot.catalog) hydrationCatalog.set(t, v);
          if (hydrationCatalog.size === 0) return parsed.alts;
          return parsed.alts.map(alt => {
            try {
              return postProcessContext(alt, {
                catalog: hydrationCatalog,
                originalBody: span.text, // TRUE pre-dehydration sentence
                preserveUnknown: true,
                introducedTokens: dSpan?.introduced,
              }).output;
            } catch { return alt; }
          });
        } catch (e) {
          this.log(`SentenceCue[${this.sourceConfig.name}]: call failed for "${span.text.slice(0, 24)}…" — ${(e as Error).message}`);
          return null;
        }
      },
    );

    const results: CueResult[] = [];
    let cededCount = 0;
    for (let si = 0; si < spans.length; si++) {
      const span = spans[si];
      const alts = matched[si];
      if (alts === 'ceded') { cededCount++; continue; }
      if (!alts || alts.length === 0) continue;
      // For a calendar-context (calendar-conflict) cue the ADVISORY belongs in the
      // status line, not buried in a cycleable alternative — the user shouldn't
      // have to Ctrl+Alt+Up to read a heads-up. Extract the flag the LLM
      // appended (`… — heads up: <conflict>`) and surface it as the cueTip; the
      // status bar renders it passively when the cursor is on the sentence.
      // cueTip is an ADVISORY (a notification) ONLY. A calendar-conflict cue
      // extracts the LLM's appended heads-up as a `⚠` tip. A plain rewrite cue
      // (e.g. more-formal) is a cycleable IMPROVEMENT, not a notification —
      // leave cueTip undefined so its inline note renders emoji-free as
      // `N | <label>` (inlineNoteText's improvement branch, e.g.
      // "Improve formality"). Defaulting to the cue NAME here made every
      // rewrite cue read as a `⚠ N | <name>` notification — the bug.
      let tip: string | undefined;
      if (this.sourceConfig.usesCalendarContext) {
        const m = alts[0]?.match(/heads up:\s*(.+)$/i) ?? alts[0]?.match(/—\s*(.+)$/);
        if (m && m[1]) tip = `⚠ ${m[1].trim().replace(/[.\s]+$/, '')}`;
      }
      results.push({
        wordIndex: span.firstWordIndex,
        word: context.words[span.firstWordIndex] ?? span.text.split(/\s+/)[0],
        // alternatives = [original, ...rewrites]. Cycling Up to alt[1+]
        // swaps the sentence; Down to alt[0] restores. Same shape
        // TransformBlank emits today; resolver's multi-word substitution
        // branch handles both.
        alternatives: [span.text, ...alts],
        source: this.id,
        priority: this.priority,
        spanStart: span.start,
        spanEnd: span.end,
        cueTip: tip,
        metadata: {
          sentenceCue: {
            cueName: this.sourceConfig.name,
            altCount: alts.length,
          },
        },
      });
    }

    this.log(`SentenceCue[${this.sourceConfig.name}]: completed (${Date.now() - t0}ms, emitted=${results.length}, ceded=${cededCount}, sentences=${spans.length})`);
    this.emit({ type: 'completed', emitted: results.length, ceded: cededCount, latencyMs: Date.now() - t0 });
    return { results, timing: Date.now() - t0, model: this.model };
  }

  private async callLLM(system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
    return dispatchChat(
      this.provider,
      this.httpAdapter,
      {
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens,
        temperature: this.sourceConfig.temperature ?? 0.3,
        seed: 42,
      },
      { apiKey: this.apiKey, endpoint: this.endpoint, signal, maxThinking: this.maxThinking },
    );
  }
}
