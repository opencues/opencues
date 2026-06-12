/**
 * opencues-core/sources/sentence-cue-source.ts
 *
 * Sentence-scope cue. A cue whose CUE.md frontmatter declares
 * `scope: sentence` operates on whole sentences instead of individual
 * words: it segments the buffer, sends ONE LLM call per buffer with
 * the per-cue prompt, and emits one CueResult per sentence with
 * `alternatives = [originalSentence, ...alts]` and char-range
 * spanStart/spanEnd. Cycling Up/Down in the runtime swaps the
 * sentence in place (TransformBlank-style; uses the existing
 * multi-word substitution branch).
 *
 * Priority sits BETWEEN word-cues and BlankSource so a sentence-cue
 * for a sentence containing a word-cue'd word wins (per the design
 * decision; suppression of overlapping word-cues is enforced in
 * resolver.ts).
 *
 * ## Prompt composition
 *
 * The user's `promptText` is wrapped with a framework-supplied OUTPUT
 * FORMAT spec — same shape ConfigSource uses for word cues. The user
 * writes the *intent* ("Rewrite each sentence to be more formal..."),
 * the framework appends the strict block-delimited output format the
 * parser knows how to read.
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
 * `SENTENCE_ALT_FORMAT_SPEC` or the segmenter.
 */

import { CueSource, CueContext, CueSourceResult, CueResult, HttpAdapter } from '../types';
import { SourceConfig } from '../cues-md';
import { describeLLMCall, dispatchChat, type ProviderAdapter } from '../llm-provider';

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
 * Strategy: regex match runs of non-terminator chars followed by one
 * or more terminators (`.!?`) AND either whitespace or EOF. Trim each
 * match so leading/trailing whitespace stays in the buffer (offsets
 * map to the first / last non-whitespace char).
 *
 * Known limitations (intentional v1 simplifications):
 *  - Abbreviations ("Mr.", "Dr.", "e.g.") split mid-word.
 *  - URLs containing periods get split at each dot.
 *  - Markdown-style headers / lists treated as single sentences.
 *
 * These are mitigated downstream by the LLM emitting `ALT: NONE` on
 * fragments / non-prose. Production cost is acceptable for v1.
 */
export function segmentSentences(buffer: string, words: ReadonlyArray<string>): SentenceSpan[] {
  if (!buffer) return [];
  const spans: SentenceSpan[] = [];
  const re = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    const raw = m[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
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
    if (firstWordIndex === -1) firstWordIndex = 0;
    span.firstWordIndex = firstWordIndex;
  }
  return spans;
}

// ============================================================================
// Output-format spec — appended to the user's per-cue promptText
// ============================================================================

export const SENTENCE_ALT_FORMAT_SPEC = `OUTPUT FORMAT — exactly this shape, nothing else, repeated per sentence:

  SENTENCE: <verbatim sentence as it appears in the input>
  ALT: <rewrite 1>
  ALT: <rewrite 2>
  ALT: <rewrite 3>
  ---

The trailing "---" separator is required after every sentence block, including the last.

WHEN TO EMIT ALTS:
  - The sentence is prose (not code / commands / URLs / identifiers).
  - The sentence is long enough to carry meaning (subject + verb minimum — not "ok." or "hi.").
  - At least ONE useful rewrite exists for the cue's intent.

WHEN TO EMIT "ALT: NONE":
  - Sentence is a fragment, one-word greeting, interjection.
  - Sentence is technical (code / commands / URLs / identifiers).
  - Sentence already meets the cue's intent (no useful lift possible).

RULES PER ALT:
  1. Preserve MEANING — semantically equivalent, no info added/dropped.
  2. Preserve PUNCTUATION shape (questions stay questions, etc.).
  3. Each ALT must be a complete sentence.
  4. ALTS should be DISTINCT — fewer distinct alts is better than three near-identical ones.

DO NOT include the original sentence in the ALT list. DO NOT output anything outside the SENTENCE/ALT/--- structure.`;

function hasFormatSpec(text: string): boolean {
  return /^SENTENCE:/m.test(text) || /^ALT:/m.test(text);
}

// ============================================================================
// Parser
// ============================================================================

export interface SentenceAltBlock {
  sentence: string;
  alts: string[];
  /** True if the model emitted ALT: NONE for this block. */
  ceded: boolean;
}

export function parseSentenceAltOutput(raw: string): SentenceAltBlock[] {
  const blocks: SentenceAltBlock[] = [];
  const rawBlocks = raw.split(/^\s*-{3,}\s*$/m);
  for (const rawBlock of rawBlocks) {
    const text = rawBlock.trim();
    if (!text) continue;
    const sentenceMatch = text.match(/^SENTENCE:\s*(.*?)(?:\n|$)/);
    if (!sentenceMatch) continue;
    const sentence = sentenceMatch[1].trim();
    if (!sentence) continue;
    const alts: string[] = [];
    let ceded = false;
    const altLines = text.match(/^ALT:\s*(.*?)$/gm) ?? [];
    for (const line of altLines) {
      const value = line.replace(/^ALT:\s*/, '').trim();
      if (!value) continue;
      if (value.toUpperCase() === 'NONE') { ceded = true; continue; }
      if (!alts.includes(value)) alts.push(value);
    }
    blocks.push({ sentence, alts, ceded });
  }
  return blocks;
}

const normSentence = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim();

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
    // Cede when the user is in blank-flow mode — `_` means a blank
    // source is going to claim. Sentence-cues are prose-time, not
    // blank-time.
    if (context.words.some(w => w === '_')) return false;
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

    const ensuredPrompt = hasFormatSpec(promptText)
      ? promptText.trimEnd()
      : `${promptText.trimEnd()}\n\n${SENTENCE_ALT_FORMAT_SPEC}`;
    const fullPrompt = `${ensuredPrompt}\n\nINPUT: ${context.text}`;

    let raw: string;
    try {
      // Token budget — ~3 sentences × 3 alts × ~30 tokens each + framing
      // = ~400 tokens of OUTPUT. 768 covers most prose buffers when
      // reasoning is OFF. When reasoning is on for a gpt-oss model,
      // the provider auto-floors to 2048 (see llm-provider.ts:
      // `needsReasoningFloor`) — covers reasoning + content. The
      // agentic harness on 2026-05-18 caught the previous
      // unconditional 768 producing empty content
      // (`emitted=0, ceded=0` in 120-187ms) on cerebras-gpt-oss-120b
      // with reasoning=medium; the provider floor closed the gap.
      // Per-source overrides: sourceConfig.maxTokens / .temperature
      // win when set in the cue's CUE.md frontmatter. Defaults (768 +
      // 0.3) reflect bench-tuned values; lowering maxTokens too far
      // on a reasoning model risks the same budget-starvation that
      // motivated the provider-level reasoning-floor (see
      // llm-provider.ts:needsReasoningFloor).
      raw = await this.callLLM(ensuredPrompt, `INPUT: ${context.text}`, this.sourceConfig.maxTokens ?? 768, context.signal);
    } catch (e) {
      this.log(`SentenceCue[${this.sourceConfig.name}]: LLM call failed — ${(e as Error).message}`);
      this.emit({ type: 'bailed', reason: 'llm-error', latencyMs: Date.now() - t0 });
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    const blocks = parseSentenceAltOutput(raw);
    void fullPrompt; // exported for debug; reference suppresses unused-var

    // Match each model block to its source sentence by normalised text.
    const results: CueResult[] = [];
    let cededCount = 0;
    for (const span of spans) {
      const norm = normSentence(span.text);
      const block = blocks.find(b => normSentence(b.sentence) === norm);
      if (!block || block.ceded || block.alts.length === 0) {
        if (block?.ceded) cededCount++;
        continue;
      }
      results.push({
        wordIndex: span.firstWordIndex,
        word: context.words[span.firstWordIndex] ?? span.text.split(/\s+/)[0],
        // alternatives = [original, ...rewrites]. Cycling Up to alt[1+]
        // swaps the sentence; Down to alt[0] restores. Same shape
        // TransformBlank emits today; resolver's multi-word substitution
        // branch handles both.
        alternatives: [span.text, ...block.alts],
        source: this.id,
        priority: this.priority,
        spanStart: span.start,
        spanEnd: span.end,
        cueTip: this.sourceConfig.name,
        metadata: {
          sentenceCue: {
            cueName: this.sourceConfig.name,
            altCount: block.alts.length,
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
