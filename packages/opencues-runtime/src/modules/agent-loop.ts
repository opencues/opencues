// Agent Loop — continuous-evaluation runtime module.
//
// When an agent task is armed (via `agentically <X> _`), this module
// subscribes to text-change events, debounces, and re-evaluates the
// buffer against the task prompt on every settle. Found edits are
// applied as DynDef entries with blankName='agent-task' so the
// existing dim-render / cycling / skip-filter machinery picks them
// up for free.
//
// See docs/architecture/agent-task.md for the full design + the
// "Implementation outcomes" section for the benchmark-driven
// decisions (EDITS-format default, defensive parse paths, apply-side
// candidate-set check). Empirical justification for each is in
// tests/benchmarks/agent-task/EXPERIMENTS.md.

import type { HostAdapter, TextChangeEvent, Unsubscribe } from '../adapter';
import type { DynDefs, WordDef } from '../state/dyn-defs';
import type { SpanFillState } from '../state/span-fill';
import type { AgentTaskState } from '../state/agent-task';
import { hashWordText } from '../state/agent-task';
import { splitWords } from './navigation';
import { TASK_TRIGGER_KEYWORDS } from './resolver';

/**
 * Words that form a TASK_* trigger phrase, kept editable-protected so
 * the agent can't accidentally rename them. Built from
 * TASK_TRIGGER_KEYWORDS (single source of truth for trigger patterns).
 *
 * - Single-word triggers (e.g. "agentically") protect themselves wherever
 *   they appear.
 * - Multi-word triggers (e.g. "add task") protect each word ONLY when
 *   both halves appear adjacent in the buffer — so prose like "I want
 *   to track this task" doesn't lock "task" out of edits, only the
 *   literal phrase "add task" / "stop task" / "current task" does.
 */
const TRIGGER_PHRASES: readonly string[] = Object.values(TASK_TRIGGER_KEYWORDS);

function normaliseLower(s: string): string {
  // Strip non-letters so "stop." or "task," still match.
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

function isTriggerWord(words: ReturnType<typeof splitWords>, idx: number): boolean {
  const cur = normaliseLower(words[idx]?.word ?? '');
  if (cur === '') return false;
  for (const phrase of TRIGGER_PHRASES) {
    const phraseWords = phrase.toLowerCase().split(/\s+/).filter(Boolean);
    if (phraseWords.length === 0) continue;
    // For each role idx within the phrase, check whether `idx` corresponds
    // to that role given the surrounding words form a contiguous match.
    for (let role = 0; role < phraseWords.length; role += 1) {
      const start = idx - role;
      if (start < 0 || start + phraseWords.length > words.length) continue;
      let match = true;
      for (let k = 0; k < phraseWords.length; k += 1) {
        if (normaliseLower(words[start + k].word) !== phraseWords[k]) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
  }
  return false;
}

export interface AgentLoopOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  /**
   * Word-completion debounce — fires after a space / newline lands.
   * Mirrors CC's `dynamicHighlight.ts` Tier 1 cadence so the agent
   * behaves like the other cues. Default 50 ms.
   */
  readonly debounceMs?: number;
  /**
   * Final-pause debounce — fires when the user stops typing without
   * committing the last word with a space. Mirrors CC's Tier 2.
   * Default 300 ms.
   */
  readonly finalPauseMs?: number;
  /** Optional injection seam for tests. */
  readonly httpAdapter?: { post(url: string, body: string, headers: Record<string, string>): Promise<string> };
  /** Optional log function — wires through to adapter.log('debug', ...) by default. */
  readonly log?: (msg: string) => void;
  /**
   * Output format the model is asked to emit.
   *   - 'EDITS' (default): only emit lines for words that need editing.
   *     Faster, smaller output, scales to long docs (gpt-oss-120b
   *     hits 100% on the 70-case suite and 1689ms / 100% recall on
   *     a 200-word doc — versus DECISIONS' 8503ms / 25% recall).
   *   - 'DECISIONS': one verdict per candidate (KEEP or edit). The
   *     completeness guarantee was the original v1 design; turned out
   *     to over-spend tokens on long docs and lose accuracy.
   * See tests/benchmarks/agent-task/EXPERIMENTS.md Experiment 4.
   */
  readonly promptFormat?: 'DECISIONS' | 'EDITS';
  /**
   * Lazy gate: when it returns true, only words that received an edit
   * on a pass are cached as evaluated; words the LLM skipped get
   * reconsidered next pass. Trades extra tokens for higher recall on
   * non-idempotent prompts (translate, paraphrase, formality). Wired
   * to `opencues.md` `agent-retry-mode: on/off` via the lazy
   * `() => configLoader.opencuesState.agentRetryMode === 'on'` thunk
   * so a frontmatter flip takes effect on the next pass without a
   * host restart.
   */
  readonly retryModeEnabled?: () => boolean;
  /**
   * Lazy gate for the shape-based locality guard:
   *   SHRINK/DELETE only in TERMINATED sentences; ADDITION only in
   *   sentences strictly past the cursor.
   *
   * Defaults to ON — safety is the default. Mechanical unit tests that
   * pre-date the guard (using non-terminated fixtures to exercise the
   * splice / cursor / dyndef-shift logic) opt out explicitly with
   * `() => false`.
   */
  readonly shapeGuardEnabled?: () => boolean;
}

export interface AgentEdit {
  /** Start word index of the edit (inclusive). */
  readonly wordIndex: number;
  /**
   * End word index of the edit (inclusive). When undefined, the edit
   * covers the single word at `wordIndex` — the historical
   * 1-to-N-words shape. When set and `> wordIndex`, the edit covers
   * the contiguous range `[wordIndex, endIndex]` and `originalWord`
   * holds the space-joined span. Used for grammar fixes that need
   * to merge or replace multiple words at once ("any way" →
   * "anyway", "I went the store" → drop "the").
   */
  readonly endIndex?: number;
  /**
   * The literal text the LLM saw at this position. For ranges, this
   * is the space-joined sequence of the live words covered. The apply
   * path validates `originalWord === liveWords[start..end].map(...)
   * .join(' ')` before splicing — a mismatch means the user has
   * touched the span since the LLM looked, so we drop the edit.
   */
  readonly originalWord: string;
  /** Replacement text (may be multi-word). Empty string means DELETE. */
  readonly editedWord: string;
}

/**
 * Strip flanking (leading/trailing) punctuation/symbols from a word.
 * Internal punctuation (apostrophes in "don't", periods in "U.S.A")
 * stays in `core` because it sits between letters/digits.
 *
 * Used to make agent-edit matching tolerant to trailing periods,
 * commas, etc. The LLM commonly emits `dramaticly | dramatically`
 * even when the live word is `dramaticly.` — without this strip the
 * survival filter rejects on `liveWord.word !== edit.originalWord`
 * and we lose the fix entirely.
 */
function stripFlankPunct(word: string): { lead: string; core: string; trail: string } {
  const leadMatch = word.match(/^[^\p{L}\p{N}]+/u);
  const trailMatch = word.match(/[^\p{L}\p{N}]+$/u);
  const lead = leadMatch ? leadMatch[0] : '';
  // If the whole word IS punctuation, leadMatch eats everything;
  // protect against negative-length core slice.
  if (lead.length === word.length) return { lead: '', core: word, trail: '' };
  const trail = trailMatch ? trailMatch[0] : '';
  const core = word.slice(lead.length, word.length - trail.length);
  return { lead, core, trail };
}

/**
 * Cheap content preview for log output (don't dump 5000-char doc).
 */
/**
 * Distinguish DynDef ownership: active substitution vs passive cue offer.
 *
 * "Active substitution" — the visible word at this index has been replaced by
 * another source. Examples: a blank-fill from BlankSource (volume, brightness),
 * a transform-blank rewrite, a fluid-blank lookup. Overwriting these would
 * fight whatever the user just summoned.
 *
 * "Passive cue offer" — the original word is still visible; the DynDef only
 * carries cycleable alternatives the user has not yet accepted. Examples:
 * SpellingSource flagging a typo, a word-cue source offering domain synonyms,
 * a LocalCueSource tip group. The agent CAN edit these — the user hasn't
 * committed to any alternative.
 *
 * Discriminator: `blankName` is set by sources that perform active
 * substitution; passive cue sources leave it undefined. The agent's own
 * prior edits use `blankName='agent-task'`, which we let pass — the
 * task cache prevents re-eval within the same task, and a new task should
 * be free to revisit the same word.
 */
function isOwnedByOtherSource(def: WordDef): boolean {
  return def.blankName !== undefined && def.blankName !== 'agent-task';
}

function preview(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Locate the sentence containing `charPos`, returning its trimmed text,
 * char-range, and whether the sentence is TERMINATED (closed by `.`,
 * `?`, `!`, or a newline) versus running off the end of the buffer
 * (the user is still typing it).
 *
 * Used by:
 *  - Sentence-fingerprint invalidation: snapshot vs live sentence text
 *    comparison. Catches user-typed-into-sentence and prior-edit-in-
 *    sentence drift between LLM-call and apply.
 *  - Shape-based apply guard: SHRINK/DELETE only allowed in terminated
 *    sentences; ADDITION only allowed in sentences strictly past the
 *    cursor (terminated AND ending before cursorPos).
 *
 * `text` is trimmed of flanking whitespace so a trailing typed space
 * doesn't trip a false fingerprint mismatch. `start`/`end` are the
 * UN-trimmed char positions, so callers can compare end-position to
 * cursor.
 */
export function sentenceInfoAt(text: string, charPos: number): {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly isTerminated: boolean;
} {
  // Walk back to start: previous sentence terminator OR newline OR start.
  let start = 0;
  for (let i = Math.min(charPos - 1, text.length - 1); i >= 0; i -= 1) {
    const c = text.charAt(i);
    if (c === '\n') { start = i + 1; break; }
    if (c === '.' || c === '?' || c === '!') {
      // Only treat as terminator when followed by whitespace or EOF —
      // avoids "U.S.A" splitting mid-acronym.
      const next = text.charAt(i + 1);
      if (next === '' || /\s/.test(next)) { start = i + 1; break; }
    }
  }
  // Walk forward to end + remember whether we hit a terminator (vs EOF).
  let end = text.length;
  let isTerminated = false;
  for (let i = charPos; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (c === '\n') { end = i; isTerminated = true; break; }
    if (c === '.' || c === '?' || c === '!') {
      const next = text.charAt(i + 1);
      if (next === '' || /\s/.test(next)) { end = i + 1; isTerminated = true; break; }
    }
  }
  return { text: text.slice(start, end).trim(), start, end, isTerminated };
}

/**
 * Return the text of the sentence containing `charPos`. Thin wrapper
 * around `sentenceInfoAt` for callers that only care about the text.
 * Kept as the existing public API so nothing breaks.
 */
export function sentenceContaining(text: string, charPos: number): string {
  return sentenceInfoAt(text, charPos).text;
}

/**
 * Classify an edit by how it RESHAPES the buffer. Used to decide where
 * the edit is allowed to land:
 *
 *   SWAP      — word count unchanged AND core token unchanged or
 *               substituted. Reversible via cycling. Allowed anywhere
 *               (including the user's in-flight sentence).
 *   SHRINK    — word count REDUCED (DELETE = 1→0, range 2→1, etc.).
 *               Destructive. Only allowed in TERMINATED sentences.
 *   ADDITION  — word count GREW (1→2, range 2→3, etc.) OR a same-count
 *               edit that ONLY ADDS flank punctuation ("Hi" → "Hi,",
 *               "for" → "for."). The latter looks like a swap but
 *               shifts register/punctuation density; the LLM tends to
 *               propose these in cascades under formality prompts.
 *               Only allowed in sentences TERMINATED AND ending strictly
 *               before the cursor.
 */
export type EditShape = 'swap' | 'shrink' | 'addition';

/**
 * Decoration: a single-word edit that doesn't change the word's core
 * letters/digits but adds flank punctuation. Examples:
 *   "Hi"  → "Hi,"   (trailing comma)
 *   "for" → "for."  (trailing period)
 *   "yes" → "(yes)" (leading + trailing parens)
 *
 * Excluded:
 *   - Range edits (single-word only — multi-word range edits with
 *     unchanged count are usually structural rewrites, not decoration).
 *   - Cases where punctuation count is equal or smaller (those are
 *     handled by anti-oscillation or by ordinary swap/shrink rules).
 *   - Cases where cores differ (e.g. "rite" → "write" — real swap).
 */
export function isPunctuationDecoration(edit: AgentEdit): boolean {
  if (edit.endIndex !== undefined && edit.endIndex !== edit.wordIndex) return false;
  if (edit.editedWord === '') return false;
  const o = stripFlankPunct(edit.originalWord);
  const e = stripFlankPunct(edit.editedWord);
  if (o.core !== e.core) return false;
  return (e.lead.length + e.trail.length) > (o.lead.length + o.trail.length);
}

/**
 * Detect "edge duplication": an edit whose editedWord begins with a
 * token equal to the previous live word, or ends with a token equal to
 * the next live word. Applying such an edit produces visible duplicates
 * like `I → I am` landing on a buffer where the next word is already
 * `am` (yields `I am am considering`).
 *
 * The model emits these when its snapshot of the buffer is stale OR
 * when the prior pass already added the missing word. The sentence-
 * fingerprint and anti-oscillation guards don't catch this class —
 * the sentence may be unchanged, and the inverse hasn't been applied.
 *
 * Comparison is on stripped cores (case-insensitive) so trailing
 * punctuation on either side doesn't mask the match. DELETE edits are
 * skipped (empty editedWord can't duplicate).
 */
export function wouldDuplicateAdjacent(
  edit: AgentEdit,
  liveWords: ReadonlyArray<{ word: string }>,
): boolean {
  if (edit.editedWord === '') return false;
  const tokens = edit.editedWord.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const startIdx = edit.wordIndex;
  const endIdx = edit.endIndex ?? edit.wordIndex;
  const eqCore = (a?: string, b?: string): boolean => {
    if (a === undefined || b === undefined) return false;
    const ac = stripFlankPunct(a).core.toLowerCase();
    const bc = stripFlankPunct(b).core.toLowerCase();
    return ac.length > 0 && ac === bc;
  };
  // Trailing duplication: last edited token vs next live word.
  const nextLive = liveWords[endIdx + 1]?.word;
  if (eqCore(tokens[tokens.length - 1], nextLive)) return true;
  // Leading duplication: first edited token vs previous live word.
  const prevLive = startIdx > 0 ? liveWords[startIdx - 1]?.word : undefined;
  if (eqCore(tokens[0], prevLive)) return true;
  return false;
}

export function classifyEdit(edit: AgentEdit): EditShape {
  const origCount = (edit.endIndex ?? edit.wordIndex) - edit.wordIndex + 1;
  const editedCount = edit.editedWord === ''
    ? 0
    : edit.editedWord.split(/\s+/).filter(Boolean).length;
  if (editedCount < origCount) return 'shrink';
  if (editedCount > origCount) return 'addition';
  // Same word count: distinguish real swaps from punctuation decoration.
  if (isPunctuationDecoration(edit)) return 'addition';
  return 'swap';
}

export class AgentLoop {
  private _unsubText: Unsubscribe | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastSeenLength = 0;
  private _generation = 0;
  private _httpAgent: { post(url: string, body: string, headers: Record<string, string>): Promise<string> } | null = null;
  private _logFn: (msg: string) => void;

  constructor(
    private adapter: HostAdapter,
    private state: AgentTaskState,
    private dynDefs: DynDefs,
    private spanFillState: SpanFillState | undefined,
    private options: AgentLoopOptions,
  ) {
    this._logFn = options.log ?? ((msg) => this.adapter.log('debug', msg));
  }

  subscribe(): void {
    this._unsubText = this.adapter.onTextChange(e => this.onTextChange(e));
  }

  unsubscribe(): void {
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
  }

  private onTextChange(e: TextChangeEvent): void {
    if (e.source !== 'user') return;          // ignore our own setText echoes
    if (!this.state.armed) return;            // no task → nothing to do

    // Tiered firing matching the other cues' (CC dynamicHighlight)
    // pattern:
    //   Tier 1 — Space / newline typed (word-complete) → fast (50 ms)
    //   Tier 2 — Final pause without word-complete → slower (300 ms)
    // The slow tier exists so the LAST word eventually gets evaluated
    // even when the user stops typing without a trailing space.
    //
    // Mid-word pauses no longer fire on partial words: a 60 ms pause
    // mid-word starts the Tier 2 timer, which gets reset by the next
    // keystroke; only when the user actually settles AND has typed
    // beyond a word boundary does the agent run.
    const prevLen = this._lastSeenLength;
    const grew = e.text.length > prevLen;
    const lastChar = e.text.charAt(e.text.length - 1);
    const wordCompleted = grew && (lastChar === ' ' || lastChar === '\t' || lastChar === '\n');
    this._lastSeenLength = e.text.length;

    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    const delay = wordCompleted
      ? (this.options.debounceMs ?? 50)
      : (this.options.finalPauseMs ?? 300);
    this._debounceTimer = setTimeout(() => {
      void this.runOnce(e.text);
    }, delay);
  }

  /** Exposed for tests + benchmark harness. */
  async runOnce(text: string): Promise<void> {
    if (!this.state.armed) return;
    const generation = ++this._generation;

    // Build candidate word indices: every word EXCLUDING:
    //  - blanks (`_`)
    //  - cursor-adjacent word (incomplete typing)
    //  - words inside an active blank-fill span (SpanFillState)
    //  - words inside a multi-word static-alt span
    //  - words owned by an *active substitution* DynDef from another source
    //    (BlankFill, fluid-blank, transform-blank, etc.) — but NOT passive
    //    cue offers (spelling, word-cues, tip groups), which only suggest
    //    alternatives without changing the visible word
    //  - words already-evaluated under the current taskId (cache hit)
    //  - words that form a TASK_* trigger phrase (`agentically`,
    //    `add task`, `stop task`, `current task`). Editing these mid-
    //    typing would silently break the user's ability to issue task
    //    commands — e.g. if `agentically` got translated to `agentisch`,
    //    a subsequent `agentisch translate to french _` wouldn't match
    //    EXTRACT's TASK_ARM regex. Only protected while the agent is
    //    armed (this whole method bails early if !state.armed).
    const wordSpans = splitWords(text);
    const cursorPos = this.adapter.getCursorOffset();
    const cursorWordIdx = this.findCursorWordIdx(wordSpans, cursorPos);
    const activeSpan = this.spanFillState?.current;

    const candidates: Array<{ wordIndex: number; word: string; hash: string }> = [];
    for (let i = 0; i < wordSpans.length; i++) {
      const word = wordSpans[i].word;
      if (word === '_') continue;
      if (i === cursorWordIdx) continue;                    // cursor-adjacent
      if (activeSpan && i >= activeSpan.index && i < activeSpan.index + activeSpan.spanLength) continue;
      if (this.dynDefs.findSpanContaining(i)) continue;     // multi-word static-alt span
      const def = this.dynDefs.get(i);
      if (def && isOwnedByOtherSource(def)) continue;       // active substitution from another source
      if (isTriggerWord(wordSpans, i)) continue;            // task-trigger keyword (agentically, add task, ...)
      const hash = hashWordText(word);
      if (this.state.isEvaluated(i, hash)) continue;        // already-checked under current task
      candidates.push({ wordIndex: i, word, hash });
    }

    if (candidates.length === 0) {
      this._logFn(`AgentLoop: no candidates (textLen=${text.length}, allWords=${wordSpans.length}, cursor=${cursorPos}@word${cursorWordIdx})`);
      return;
    }

    this._logFn(`AgentLoop: starting (textLen=${text.length}, candidates=${candidates.length}/${wordSpans.length}, cursor=${cursorPos}@word${cursorWordIdx}, taskId=${this.state.taskId?.slice(0, 8)}…)`);

    // Snapshot the SENTENCE TEXT containing each candidate. After the
    // LLM call returns, we re-derive the same sentence in liveText and
    // drop edits whose sentence has drifted (user typed into it OR a
    // prior edit landed in it). This prevents the "are → are you?"
    // class of bugs where the LLM autocompletes mid-typed prose and
    // the user's continued typing appears to be duplicated.
    const sentenceSnapshot = new Map<number, string>();
    for (const c of candidates) {
      const span = wordSpans[c.wordIndex];
      if (span) sentenceSnapshot.set(c.wordIndex, sentenceContaining(text, span.start));
    }

    // Stale check before LLM call.
    if (generation !== this._generation) return;

    // EXPERIMENT 1: what does the agent SEE?
    // For v1 we send the full doc text + the candidate word indices.
    // Alternatives to benchmark later: just candidate words; or
    // doc with <owned>...</owned> markers. See EXPERIMENTS.md.
    let edits: AgentEdit[];
    try {
      edits = await this.callEditPass(text, this.state.prompt, candidates.map(c => c.wordIndex));
    } catch (err) {
      this._logFn(`AgentLoop: edit-pass threw — ${err}`);
      return;
    }

    // Stale check post-LLM. New text-change might have invalidated.
    if (generation !== this._generation) {
      this._logFn(`AgentLoop: stale generation, dropping ${edits.length} edits`);
      return;
    }

    this._logFn(
      `AgentLoop: edit-pass returned ${edits.length} edit(s)` +
      (edits.length > 0
        ? `: ${edits.map(e =>
            `[${e.wordIndex}${e.endIndex !== undefined && e.endIndex !== e.wordIndex ? `-${e.endIndex}` : ''}] "${e.originalWord}" → "${e.editedWord || 'DELETE'}"`
          ).join(', ')}`
        : '')
    );

    // Re-fetch live text — user might have typed during the LLM call.
    const liveText = this.adapter.getText();
    const liveWords = splitWords(liveText);

    // Record evaluations. Default cache policy is aggressive — every
    // candidate counts as evaluated under this taskId, including words
    // the LLM left alone. Suits idempotent prompts ("correct spelling")
    // where a clean verdict means clean forever.
    //
    // When `retryModeEnabled` is on (opencues.md `agent-retry-mode: on`),
    // skip caching for words the LLM didn't edit so they get reconsidered
    // on the next pass. Required for non-idempotent transforms (translate,
    // paraphrase, "make it more formal") where the first pass can miss
    // words and the apply-side filter would otherwise reject the LLM's
    // belated catch-up edits.
    //
    // Edited words in retry mode are cached at their NEW index with the
    // NEW word's hash AFTER the apply block below — that way the next
    // pass's lookup against the post-edit visible word hits and the
    // agent doesn't re-translate already-translated text.
    const retryMode = this.options.retryModeEnabled?.() ?? false;
    if (!retryMode) {
      for (const c of candidates) {
        this.state.recordEvaluation(c.wordIndex, c.hash);
      }
    }

    // Apply edits as DynDefs. The Resolver skip filter and DimRender
    // pick these up for free — agent gets ownership semantics without
    // any new ownership machinery.
    //
    // Defensive: even though we told the LLM "may edit only these"
    // candidate indices, the model occasionally proposes edits OUTSIDE
    // the candidate set (cache-hit indices, owned indices, cursor-
    // adjacent). Enforce the constraint on the apply side too.
    const candidateSet = new Set(candidates.map(c => c.wordIndex));

    // Filter once — the same survival rules apply to BOTH the buffer
    // splice and the DynDef placement. Storing the def list ahead of
    // application also lets us index in the new text frame after the
    // splice (correct word positions for multi-word edits).
    //
    // Dedupe by wordIndex: if the LLM emits two edits for the same
    // slot in a single batch, only keep the first. Applying both
    // produces visible duplication artefacts like
    // `collaborating collaborativelyatively` or `strongngng` because
    // the second splice operates on the post-edit-1 frame using OLD
    // `w.start`/`w.end` from `liveWords`. The tail of edit-1's
    // `editedWord` beyond the original word's length is left behind,
    // then edit-2 lands on top of the leftover. LLM-side bug; we
    // refuse to compose them.
    // Survival filter for both single-word and range edits.
    //
    // Range edits (`endIndex` set) cover [wordIndex, endIndex] inclusive.
    // The LLM's `originalWord` for a range is the space-joined live span;
    // we check it against the actual `liveWords` content so an edit
    // computed against stale text gets rejected.
    //
    // Dedupe: track every idx already CLAIMED by a surviving edit.
    // An incoming edit (single OR range) gets dropped if its span
    // overlaps any claimed idx — this protects the apply loop from the
    // strongngng-class composition bug regardless of edit shape.
    const surviving: AgentEdit[] = [];
    const claimedIndices = new Set<number>();
    for (const rawEdit of edits) {
      let edit = rawEdit;
      const startIdx = edit.wordIndex;
      const endIdx = edit.endIndex ?? edit.wordIndex;
      // Range bounds sanity (parser should have caught endIdx < startIdx, but defensive).
      if (endIdx < startIdx) continue;
      // Every index in the span must be a candidate. The candidate set
      // already excludes cursor-adjacent / span-owned / trigger-word
      // / cache-hit indices, so this single check enforces ALL of them
      // for the whole range at once.
      let allInCandidates = true;
      for (let i = startIdx; i <= endIdx; i += 1) {
        if (!candidateSet.has(i)) { allInCandidates = false; break; }
      }
      if (!allInCandidates) continue;
      // Index range must still resolve in liveWords.
      if (!liveWords[startIdx] || !liveWords[endIdx]) continue;
      // Validate originalWord matches the joined live span. First try
      // exact match; on drift, fall back to PUNCTUATION-TOLERANT match
      // (LLMs commonly emit `dramaticly` when the live word is
      // `dramaticly.`). When that succeeds, rewrite the edit to use
      // the live span verbatim and re-attach the live word's flanking
      // punctuation to the LLM's replacement so the buffer ends up
      // with `dramatically.` not `dramatically`.
      const liveSpan = liveWords.slice(startIdx, endIdx + 1).map(w => w.word).join(' ');
      if (liveSpan !== edit.originalWord) {
        // Single-word punctuation rescue (range edits drift less commonly).
        if (startIdx === endIdx) {
          const live = stripFlankPunct(liveSpan);
          const orig = stripFlankPunct(edit.originalWord);
          if (live.core.length > 0 && live.core === orig.core) {
            const editedStripped = stripFlankPunct(edit.editedWord);
            edit = {
              ...edit,
              originalWord: liveSpan,
              editedWord: edit.editedWord === ''
                ? ''  // DELETE preserved
                : live.lead + editedStripped.core + live.trail,
            };
          } else {
            continue;
          }
        } else {
          continue;
        }
      }
      // No-op filter (single-word and range share this rule).
      if (edit.editedWord !== '' && edit.editedWord === edit.originalWord) continue;
      // No def in the range may be owned by another source (BlankFill,
      // transform-blank, etc.). Single-word case = the original
      // existingDef check; for ranges, ANY position with such a def
      // disqualifies the whole edit.
      let blockedByOwner = false;
      for (let i = startIdx; i <= endIdx; i += 1) {
        const def = this.dynDefs.get(i);
        if (def && isOwnedByOtherSource(def)) { blockedByOwner = true; break; }
      }
      if (blockedByOwner) continue;
      // Sentence-fingerprint guard. The agent reasoned about an edit
      // against the SNAPSHOT sentence; if that sentence has changed in
      // any way since (user typed into it, prior edit landed in it),
      // the edit's reasoning is stale — drop it. Catches the "are →
      // are you?" autocompletion-into-typed-suffix duplication bug.
      // Edits in untouched sentences are unaffected.
      const snapSentence = sentenceSnapshot.get(startIdx);
      if (snapSentence !== undefined) {
        const liveSentence = sentenceContaining(liveText, liveWords[startIdx].start);
        if (liveSentence !== snapSentence) {
          this._logFn(`AgentLoop: dropping edit at idx ${startIdx}${endIdx > startIdx ? `-${endIdx}` : ''} ("${edit.editedWord}") — sentence invalidated`);
          continue;
        }
      }
      // Shape-based locality guard. Different edit kinds carry different
      // risk and are restricted to sentences where they're safe:
      //   SWAP      → anywhere (word count unchanged, reversible).
      //   SHRINK    → only in TERMINATED sentences (don't destroy words
      //               from a sentence the user hasn't closed yet — e.g.
      //               typed "Cool so " → agent shouldn't DELETE "so").
      //   ADDITION  → only in sentences strictly PAST the cursor
      //               (terminated AND ending before cursorPos). Catches
      //               the autocompletion class: "are" → "are you?" sits
      //               in the user's in-flight sentence and would clash
      //               with whatever they type next.
      const shapeGuardOn = this.options.shapeGuardEnabled?.() ?? true;
      const shape = classifyEdit(edit);
      if (shapeGuardOn && shape !== 'swap') {
        const liveInfo = sentenceInfoAt(liveText, liveWords[startIdx].start);
        if (!liveInfo.isTerminated) {
          this._logFn(`AgentLoop: dropping ${shape} edit at idx ${startIdx}${endIdx > startIdx ? `-${endIdx}` : ''} ("${edit.originalWord}" → "${edit.editedWord || 'DELETE'}") — sentence not terminated`);
          continue;
        }
        if (shape === 'addition') {
          const cursorPos = this.adapter.getCursorOffset();
          if (liveInfo.end >= cursorPos) {
            this._logFn(`AgentLoop: dropping addition edit at idx ${startIdx}${endIdx > startIdx ? `-${endIdx}` : ''} ("${edit.originalWord}" → "${edit.editedWord}") — sentence not strictly past cursor`);
            continue;
          }
        }
      }
      // Anti-oscillation guard. If a prior pass applied the INVERSE of
      // this edit (e.g. earlier turned "Later" into "Later," and this
      // edit wants to turn "Later," back into "Later"), drop it. Stops
      // the visible add-then-remove churn that comes from model
      // vacillation across appendToPrompt-refreshed caches.
      if (this.state.wouldInvertRecent(edit.originalWord, edit.editedWord)) {
        this._logFn(`AgentLoop: dropping edit at idx ${startIdx}${endIdx > startIdx ? `-${endIdx}` : ''} ("${edit.originalWord}" → "${edit.editedWord}") — would invert a recent edit (oscillation)`);
        continue;
      }
      // Edge-duplication guard. The LLM sometimes emits an addition
      // whose first/last token already exists adjacent to the edit
      // span — e.g. `[7] "I" → "I am"` lands on a live buffer where
      // [8]="am" (because a prior pass turned "was" → "am"), producing
      // `I am am considering`. Drop these before they corrupt the buffer.
      if (wouldDuplicateAdjacent(edit, liveWords)) {
        this._logFn(`AgentLoop: dropping edit at idx ${startIdx}${endIdx > startIdx ? `-${endIdx}` : ''} ("${edit.originalWord}" → "${edit.editedWord}") — would duplicate adjacent live word`);
        continue;
      }
      // Overlap dedupe — if any idx in this edit's span has been
      // claimed by an earlier surviving edit, drop this one. Logs the
      // skip so duplicates / overlaps are visible in debug output.
      let overlap = false;
      for (let i = startIdx; i <= endIdx; i += 1) {
        if (claimedIndices.has(i)) { overlap = true; break; }
      }
      if (overlap) {
        this._logFn(`AgentLoop: dropping overlapping edit at idx ${startIdx}${endIdx > startIdx ? `-${endIdx}` : ''} ("${edit.editedWord}")`);
        continue;
      }
      for (let i = startIdx; i <= endIdx; i += 1) claimedIndices.add(i);
      surviving.push(edit);
    }

    const applied = surviving.length;
    if (applied > 0) {
      this._logFn(`AgentLoop: applied ${applied}/${edits.length} edit(s) as DynDefs`);

      // Splice right-to-left so earlier indices' char offsets stay
      // valid. (The OLD wordSpans are computed once over `liveText` so
      // each edit's start/end refer to the pre-splice frame.)
      //
      // DELETE (`editedWord === ''`): also consume ONE adjacent
      // whitespace char so the surrounding text closes up cleanly
      // ("the the cat" → "the cat", not "the  cat"). Prefer the
      // trailing whitespace; fall back to leading when the deleted
      // word is at the end of the doc / line.
      const sortedDesc = surviving.slice().sort((a, b) => b.wordIndex - a.wordIndex);
      let newText = liveText;
      for (const edit of sortedDesc) {
        const wStart = liveWords[edit.wordIndex];
        const wEnd = liveWords[edit.endIndex ?? edit.wordIndex];
        if (edit.editedWord === '') {
          // DELETE: drop chars [wStart.start, wEnd.end) plus one
          // adjacent whitespace (trailing preferred; leading at end of
          // buffer). For range deletes, this drops the whole span +
          // the surrounding whitespace so "the I really love" with
          // "1-2 | I really | DELETE" → "the love".
          let cutStart = wStart.start;
          let cutEnd = wEnd.end;
          const next = newText.charAt(cutEnd);
          const prev = cutStart > 0 ? newText.charAt(cutStart - 1) : '';
          if (next === ' ' || next === '\t') cutEnd += 1;
          else if (prev === ' ' || prev === '\t') cutStart -= 1;
          newText = newText.slice(0, cutStart) + newText.slice(cutEnd);
        } else {
          // Replace [wStart.start, wEnd.end) with editedWord. Single-
          // word edits collapse this to the historical [w.start, w.end)
          // splice; range edits replace the whole multi-word span.
          newText = newText.slice(0, wStart.start) + edit.editedWord + newText.slice(wEnd.end);
        }
      }

      // Re-derive word positions in the NEW text and store DynDefs at
      // their NEW word indices. A single multi-word edit (e.g. `will`
      // → `ich werde`) shifts every downstream word right by N-1; if
      // we stored later edits' defs at their OLD indices, DimRender's
      // findSpanContaining would see the lower-index multi-word span
      // swallow them and they'd never get reached. Process LEFT-TO-
      // RIGHT, accumulating the word-count delta as we go, so each
      // def lands at its post-splice position.
      const newWords = splitWords(newText);
      const sortedAsc = surviving.slice().sort((a, b) => a.wordIndex - b.wordIndex);
      let cumulativeWordDelta = 0;
      for (const edit of sortedAsc) {
        const startIdx = edit.wordIndex;
        const endIdx = edit.endIndex ?? edit.wordIndex;
        const rangeLength = endIdx - startIdx + 1;
        const altWordCount = edit.editedWord === ''
          ? 0
          : edit.editedWord.split(/\s+/).filter(Boolean).length;
        const wordDelta = altWordCount - rangeLength;
        const newStartIdx = startIdx + cumulativeWordDelta;
        const newEndIdx = newStartIdx + rangeLength - 1;

        // Drop ALL existing defs in the range — those words are gone
        // (replaced or deleted). For a single-word edit this matches
        // the legacy single-slot drop; for a range it sweeps the
        // whole span.
        for (let i = newStartIdx; i <= newEndIdx; i += 1) {
          this.dynDefs.delete(i);
        }
        // Shift PRIOR defs at idx > newEndIdx by wordDelta. Done
        // BEFORE storing the new def so the just-stored def at
        // newStartIdx isn't itself shifted.
        if (wordDelta !== 0) {
          this.dynDefs.shiftAfter(newEndIdx, wordDelta);
        }

        // DELETE: no replacement def to store. Cumulative delta
        // tracks the -rangeLength so subsequent edits' newStartIdx
        // is correct.
        if (edit.editedWord === '') {
          cumulativeWordDelta += wordDelta;
          continue;
        }

        const startWord = newWords[newStartIdx];
        const endWord = newWords[newStartIdx + Math.max(0, altWordCount - 1)];
        // Defensive: if our shift miscalculated and the position is
        // out of range (shouldn't happen for surviving edits), drop
        // the def rather than store at a bogus index.
        if (!startWord || !endWord) {
          this._logFn(`AgentLoop: skipping def store — newWordIndex ${newStartIdx} out of range (${newWords.length} words)`);
          cumulativeWordDelta += wordDelta;
          continue;
        }
        const def: WordDef = {
          originalWord: edit.originalWord,
          alternatives: [edit.originalWord, edit.editedWord],
          currentIndex: 1,                                  // showing edit
          spanStart: startWord.start,
          spanEnd: endWord.end,
          blankName: 'agent-task',                          // locks against re-resolution
        };
        this.dynDefs.set(newStartIdx, def);
        // Anti-oscillation: remember "originalWord → editedWord" so a
        // future inverse edit (editedWord → originalWord) gets dropped.
        this.state.recordEditSignature(edit.originalWord, edit.editedWord);
        // Retry-mode cache: record at the NEW index using the hash of
        // the post-edit visible word (first word of the edited phrase).
        // Without this, the next pass would compute hash of the new
        // word, miss the cache (which had OLD hash), and re-ask the LLM
        // about something it just translated. The original "skip
        // un-edited" branch above already left those un-cached on
        // purpose — they're the words we actually want reconsidered.
        if (retryMode) {
          this.state.recordEvaluation(newStartIdx, hashWordText(startWord.word));
        }
        cumulativeWordDelta += wordDelta;
      }
      if (newText !== liveText) {
        const cursorBefore = this.adapter.getCursorOffset();
        // Translate the cursor across the splice. The offset we got from
        // getCursorOffset() refers to the OLD text frame; pushText needs
        // an offset in the NEW text frame. Any edit whose end position is
        // at or before the cursor shifts the cursor by its length delta.
        // Edits after the cursor leave the offset alone.
        //
        // Without this translation, edits before the cursor make the
        // cursor "drift" — `rite`→`write` (+1 char) at offset 2 with
        // cursor at offset 28 would land the cursor at offset 28 in the
        // new text, which is one character earlier than where the user
        // logically was. Multiple edits compound the drift.
        let cursorAdjusted = cursorBefore;
        for (const edit of sortedDesc) {
          const wStart = liveWords[edit.wordIndex];
          const wEnd = liveWords[edit.endIndex ?? edit.wordIndex];
          // Cursor shifts only when the entire edit span sits at or
          // before the cursor. (Edits that straddle the cursor would
          // need finer-grained translation; in practice the candidate
          // filter already excludes the cursor-adjacent word so this
          // is a non-issue.)
          if (wEnd.end <= cursorBefore) {
            const oldSpanLen = wEnd.end - wStart.start;
            if (edit.editedWord === '') {
              // DELETE removes the span + ONE adjacent whitespace char.
              cursorAdjusted -= oldSpanLen + 1;
            } else {
              cursorAdjusted += edit.editedWord.length - oldSpanLen;
            }
          }
        }
        if (this.adapter.pushText) {
          this.adapter.pushText(newText, cursorAdjusted);
        } else {
          this.adapter.setText(newText);
          this.adapter.forceRender();
        }
        const cursorAfter = this.adapter.getCursorOffset();
        const lenDelta = newText.length - liveText.length;
        this._logFn(
          `AgentLoop: buffer mutated (textLen ${liveText.length}→${newText.length}, delta=${lenDelta >= 0 ? '+' : ''}${lenDelta}, cursor ${cursorBefore}→${cursorAfter}` +
          (cursorAdjusted !== cursorBefore ? ` [translated ${cursorBefore}→${cursorAdjusted}]` : '') +
          `)`
        );
      }
    }
  }

  /**
   * Find the word index whose span contains (or is immediately
   * adjacent to) the cursor. The agent excludes this index because
   * the user might still be typing it.
   */
  private findCursorWordIdx(wordSpans: ReturnType<typeof splitWords>, cursorPos: number): number {
    for (let i = 0; i < wordSpans.length; i++) {
      const w = wordSpans[i];
      // Cursor inside word OR right after it (no space typed yet)
      if (cursorPos >= w.start && cursorPos <= w.end) return i;
    }
    return -1;
  }

  /**
   * The expensive edit-pass LLM call. Returns the list of edits the
   * model suggests, or empty if nothing needs editing.
   *
   * Output format (parsed greedily, robust to small format drift):
   *
   *   EDITS:
   *   <wordIndex> | <originalWord> | <editedWord>
   *   <wordIndex> | <originalWord> | <editedWord>
   *   ...
   *   END
   *
   * Or "EDITS: none" / empty when nothing needs editing.
   */
  private async callEditPass(text: string, prompt: string, candidateIndices: number[]): Promise<AgentEdit[]> {
    const format = this.options.promptFormat ?? 'EDITS';
    const system = format === 'EDITS' ? EDITS_SYSTEM_PROMPT : DECISIONS_SYSTEM_PROMPT;

    const wordSpans = splitWords(text);
    const docWithIndices = wordSpans.map((w, i) => `[${i}]${w.word}`).join(' ');
    const userMsg = `TASK PROMPT: ${prompt}
DOC: ${docWithIndices}

Candidate word indices (you MAY edit only these — others are owned by other systems): [${candidateIndices.join(', ')}]`;

    // Dynamic max_tokens. DECISIONS emits one line per candidate (output
    // scales with candidate count). EDITS only emits lines for actual
    // edits, which is usually a small fraction of candidates — but the
    // model still needs reasoning headroom to walk the full list.
    const estLines = candidateIndices.length;
    const maxTokens = format === 'EDITS'
      ? Math.max(1024, Math.min(2200, estLines * 8 + 600))
      : Math.max(1024, Math.min(4096, estLines * 30 + 600));
    const body = JSON.stringify({
      model: this.options.defaultModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      reasoning_effort: 'low',
      seed: 42,
    });

    const agent = this.options.httpAdapter ?? this.getHttpAgent();
    const response = await agent.post(this.options.endpoint, body, {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.options.apiKey}`,
    });

    // Empty body (timeout, dropped connection) — treat as no edits.
    // The next text-change will re-fire the loop, which is our retry.
    if (!response || !response.trim()) {
      this._logFn(`AgentLoop: empty response body`);
      return [];
    }
    let data: any;
    try {
      data = JSON.parse(response);
    } catch (err) {
      this._logFn(`AgentLoop: response not valid JSON (${response.length} chars) — ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    if (data.error) {
      const msg = data.error.message ?? JSON.stringify(data.error);
      // 429 / rate-limit / quota: the next text-change will retry; don't crash.
      this._logFn(`AgentLoop: API error — ${msg}`);
      return [];
    }
    const out: string = data.choices?.[0]?.message?.content ?? '';
    if (!out) {
      this._logFn(`AgentLoop: response had no content (choices=${data.choices?.length ?? 0})`);
      return [];
    }
    return parseEditPassOutput(out);
  }

  private getHttpAgent(): { post(url: string, body: string, headers: Record<string, string>): Promise<string> } {
    if (this._httpAgent) return this._httpAgent;
    // Lazy require so tests without node-http-adapter still load.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NodeHttpAdapter } = require('@opencues/core/node-http-adapter');
    this._httpAgent = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });
    return this._httpAgent!;
  }
}

/**
 * Parse either the EDITS: ... END block (legacy) or the DECISIONS:
 * ... END block (new). DECISIONS format is more verbose (one line per
 * candidate, KEEP for no-op) but guarantees the model can't drop the
 * last item. We extract only the non-KEEP rows as edits.
 *
 * Lenient — accepts either marker, trailing whitespace, etc.
 */
export function parseEditPassOutput(raw: string): AgentEdit[] {
  const edits: AgentEdit[] = [];
  // Find EDITS: or DECISIONS: marker
  const startMatch = raw.match(/(EDITS|DECISIONS):\s*\n/i);
  if (!startMatch) return [];
  const start = startMatch.index! + startMatch[0].length;
  // Find END marker (or end of string)
  const endMatch = raw.slice(start).match(/^\s*END\s*$/im);
  const end = endMatch ? start + endMatch.index! : raw.length;
  const block = raw.slice(start, end);

  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^none$/i.test(trimmed)) continue;
    // Format: <idx>[-<endIdx>] | <orig> | <edit-or-KEEP-or-DELETE>
    const parts = trimmed.split('|').map(s => s.trim());
    if (parts.length !== 3) continue;
    // Index field accepts "<n>" or "<n>-<m>" with m >= n. Anything else
    // (negative, malformed) drops the line.
    const idxMatch = parts[0].match(/^(\d+)(?:-(\d+))?$/);
    if (!idxMatch) continue;
    const idx = parseInt(idxMatch[1], 10);
    const endIdxRaw = idxMatch[2];
    const endIdx = endIdxRaw !== undefined ? parseInt(endIdxRaw, 10) : undefined;
    if (Number.isNaN(idx) || idx < 0) continue;
    if (endIdx !== undefined && (Number.isNaN(endIdx) || endIdx < idx)) continue;
    const orig = parts[1];
    const edit = parts[2];
    if (!orig) continue;
    // KEEP marker — explicit no-op, don't include as an edit
    if (/^keep$/i.test(edit)) continue;
    // DELETE marker — emit an edit with empty editedWord. The apply
    // path uses '' to mean "remove this word + one adjacent whitespace
    // char so the surrounding text closes up cleanly". Works for both
    // single words and ranges (delete a multi-word phrase).
    if (/^delete$/i.test(edit)) {
      edits.push({ wordIndex: idx, endIndex: endIdx, originalWord: orig, editedWord: '' });
      continue;
    }
    if (!edit) continue;            // empty third column AND not DELETE → malformed line
    if (edit === orig) continue;    // model emitted unchanged value, treat as no-op
    edits.push({ wordIndex: idx, endIndex: endIdx, originalWord: orig, editedWord: edit });
  }
  return edits;
}

const DECISIONS_SYSTEM_PROMPT = `You are an inline editor running continuously in the background of a user's document. You receive a TASK PROMPT (what the user wants you to do), a DOC (the current text), and a list of CANDIDATE INDICES you may edit. Your job: emit a verdict for EACH candidate — KEEP if no edit, or the edited word.

Output format — ONE LINE PER CANDIDATE INDEX, in ascending order:

DECISIONS:
<wordIndex> | <originalWord> | KEEP
<wordIndex> | <originalWord> | <editedWord>
<wordIndex> | <originalWord> | KEEP
...
END

This is a COMPLETENESS guarantee: by emitting one line per candidate, you can't accidentally drop the last item. If there are 10 candidates, output exactly 10 DECISIONS lines (one per index, in order from lowest to highest).

Use KEEP when the word doesn't need editing under the task. Use the edited word when it does.

RULES:
1. ONE LINE PER CANDIDATE. If 10 candidates were given, emit 10 lines. If 3, emit 3.
2. Emit lines in ASCENDING order of wordIndex (0, 1, 2, ... in order).
3. Each line: <wordIndex> | <originalWord> | <KEEP or editedWord>
4. Use KEEP for any word that doesn't need editing.
5. Be conservative on AMBIGUOUS edits — when in doubt, KEEP. But be exhaustive on UNAMBIGUOUS edits (typos, proper-noun capitalisation, etc.) — actually edit them.
6. Multi-word transformations are NOT supported. KEEP words you can't fix in a single-word swap.

EXAMPLES:

TASK PROMPT: correct spelling
DOC: [0]I [1]rite [2]some [3]stuff
Candidate indices: [0, 1, 2, 3]
DECISIONS:
0 | I | KEEP
1 | rite | write
2 | some | KEEP
3 | stuff | KEEP
END

TASK PROMPT: correct spelling
DOC: [0]This [1]is [2]fine
Candidate indices: [0, 1, 2]
DECISIONS:
0 | This | KEEP
1 | is | KEEP
2 | fine | KEEP
END

TASK PROMPT: capitalize the days
DOC: [0]i [1]work [2]on [3]monday [4]and [5]friday [6]but [7]rest [8]on [9]sunday
Candidate indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
DECISIONS:
0 | i | KEEP
1 | work | KEEP
2 | on | KEEP
3 | monday | Monday
4 | and | KEEP
5 | friday | Friday
6 | but | KEEP
7 | rest | KEEP
8 | on | KEEP
9 | sunday | Sunday
END`;

const EDITS_SYSTEM_PROMPT = `You are an inline editor running continuously in the background of a user's document. You receive a TASK PROMPT (what the user wants you to do), a DOC (the current text), and a list of CANDIDATE INDICES you may edit. Your job: emit ONLY the edits you want to apply — nothing for words that don't need editing.

Output format — ONE LINE PER EDIT (skip words that need no edit):

EDITS:
<wordIndex> | <originalWord> | <editedWord>
<wordIndex> | <originalWord> | <editedWord>
...
END

If nothing needs editing, output:

EDITS:
none
END

BASELINE EDITS — ALWAYS make these alongside the task prompt, even if it doesn't ask:
- Capitalise the first word of any sentence (the doc-start word, OR any word immediately after a sentence terminator \`.\` \`?\` \`!\` or a paragraph break).
- Capitalise proper nouns (names of people, places, brands, days, months).
- Fix obvious typos and misspellings (\`teh\` → \`the\`, \`recieve\` → \`receive\`, \`adn\` → \`and\`).
- Collapse duplicated stop-words (\`the the\` → \`the\`, \`I I\` → \`I\`).
- Add a missing terminator at the END of a clearly-complete sentence (only when it's followed by a paragraph break, another capitalised sentence, or end-of-document — never to a sentence the user is still typing).

The TASK PROMPT runs ON TOP OF these baselines, not instead of them. If the task prompt is "translate to German", you still capitalise sentence-starts and fix typos in the resulting German text.

RULES:
1. Walk the candidate list MENTALLY in ORDER from FIRST to LAST. Don't stop early. Before you emit your final line, mentally re-check the LAST 3 indices in the candidate list — those are the ones the model most often drops.
2. Each emitted line: <wordIndex>[-<endIdx>] | <originalSpan> | <editedSpan>
3. Be conservative on AMBIGUOUS edits — when in doubt, skip. Be exhaustive on UNAMBIGUOUS edits (typos, proper-noun capitalisation, etc.).
4. EXPANSIONS allowed: edit one word into multiple words by emitting the new phrase as <editedSpan>, e.g. "1 | will | ich werde" replaces "will" with "ich werde". Use this for translations and for inserting words ("I went store" → emit "2 | store | to the store" to fill in missing words).
5. DELETIONS allowed: emit "DELETE" as <editedSpan> to remove a redundant word, e.g. "1 | the | DELETE" turns "the the cat" into "the cat". Use for grammar fixes that require removing a word entirely. The runtime tidies the surrounding whitespace.
6. RANGES allowed: edit a CONTIGUOUS span of words by writing <startIdx>-<endIdx> in the index column. <originalSpan> is the live words space-joined. Use this to MERGE words ("1-2 | any way | anyway"), to REWRITE a phrase ("3-5 | I went store | I went to the store"), or to DELETE a phrase ("1-2 | really really | DELETE"). Every index in the range MUST be in the candidate list — if even one isn't, skip the edit entirely. Ranges replace single-index edits where applicable; do not emit overlapping edits on the same word.
7. ORIGINAL WORDS preserve trailing punctuation. If the live word in the doc is "tomorrow." (with a period), your <originalSpan> is "tomorrow." NOT "tomorrow". The runtime is tolerant of this (it strips trailing punctuation for matching) but be precise when you can.
8. DO NOT add stylistic punctuation (extra commas, salutation commas like "Hi, " → "Hi, ,", em dashes, etc.) unless the task prompt EXPLICITLY asks for it. The baselines above are limited to capitalisation, typos, dup-removal, and terminal punctuation only.

EXAMPLES:

TASK PROMPT: correct spelling
DOC: [0]I [1]rite [2]some [3]stuff
Candidate indices: [0, 1, 2, 3]
EDITS:
1 | rite | write
END

TASK PROMPT: correct spelling
DOC: [0]This [1]is [2]fine
Candidate indices: [0, 1, 2]
EDITS:
none
END

TASK PROMPT: capitalize the days
DOC: [0]i [1]work [2]on [3]monday [4]and [5]friday [6]but [7]rest [8]on [9]sunday
Candidate indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
EDITS:
3 | monday | Monday
5 | friday | Friday
9 | sunday | Sunday
END

TASK PROMPT: correct spelling
DOC: [0]thier [1]proposal [2]was [3]carefuly [4]recieved
Candidate indices: [0, 1, 2, 3, 4]
EDITS:
0 | thier | their
3 | carefuly | carefully
4 | recieved | received
END

TASK PROMPT: fix grammar
DOC: [0]the [1]the [2]cat [3]sat
Candidate indices: [0, 1, 2, 3]
EDITS:
1 | the | DELETE
END

TASK PROMPT: fix grammar
DOC: [0]I [1]went [2]store
Candidate indices: [0, 1, 2]
EDITS:
2 | store | to the store
END

TASK PROMPT: fix grammar
DOC: [0]we [1]went [2]any [3]way [4]we [5]could
Candidate indices: [0, 1, 2, 3, 4, 5]
EDITS:
2-3 | any way | anyway
END

TASK PROMPT: tighten prose
DOC: [0]he [1]really [2]really [3]wanted [4]to [5]go
Candidate indices: [0, 1, 2, 3, 4, 5]
EDITS:
1-2 | really really | really
END

TASK PROMPT: fix grammar
DOC: [0]I [1]went [2]the [3]the [4]store
Candidate indices: [0, 1, 2, 3, 4]
EDITS:
2-3 | the the | the
END

TASK PROMPT: correct spelling
DOC: [0]The [1]team [2]worked [3]on [4]the [5]itteration [6]and [7]made [8]significnt [9]progress [10]over [11]two [12]weeks [13]on [14]the [15]new [16]platform [17]launching [18]next [19]month [20]which [21]definately [22]impressed [23]everyone [24]on [25]the [26]team [27]and [28]our [29]customrs
Candidate indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]
EDITS:
5 | itteration | iteration
8 | significnt | significant
21 | definately | definitely
29 | customrs | customers
END
[Note: 4 typos total. The LAST one (idx 29) is at the very end of the candidate list — easy to miss if you stop walking early. ALWAYS finish the list.]

TASK PROMPT: make formal
DOC: [0]hi [1]john [2]how's [3]it [4]going? [5]i [6]hope [7]you [8]got [9]home [10]safe.
Candidate indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
[Baselines apply: sentence-start capitalisation at idx 0 and idx 5, proper-noun capitalisation at idx 1. The TASK is "make formal" — that justifies "how's it going?" → "how are you?" but does NOT justify adding stylistic salutation commas to "Hi" or appositive commas to "John".]
EDITS:
0 | hi | Hi
1 | john | John
2 | how's | how are
3 | it | you
4 | going? | doing?
5 | i | I
END

TASK PROMPT: translate to spanish
DOC: [0]hi [1]john [2]how [3]are [4]you?
Candidate indices: [0, 1, 2, 3, 4]
[Translation runs ON TOP OF baselines: sentence-start cap at idx 0 still applies in the Spanish output. Proper noun "John" is unchanged across languages. Greeting "hi" → "Hola" capitalised correctly.]
EDITS:
0 | hi | Hola
2-4 | how are you? | cómo estás?
END`;
