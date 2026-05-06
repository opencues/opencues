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
  /** Debounce. Reuse the same 500ms the resolver uses by default. */
  readonly debounceMs?: number;
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
}

export interface AgentEdit {
  readonly wordIndex: number;
  readonly originalWord: string;
  readonly editedWord: string;
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

export class AgentLoop {
  private _unsubText: Unsubscribe | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
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

    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    const delay = this.options.debounceMs ?? 500;
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

    this._logFn(`AgentLoop: edit-pass returned ${edits.length} edit(s)`);

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
    const surviving: AgentEdit[] = [];
    const seenIndices = new Set<number>();
    for (const edit of edits) {
      if (!candidateSet.has(edit.wordIndex)) continue;      // outside candidate set
      const liveWord = liveWords[edit.wordIndex];
      if (!liveWord) continue;                              // index out of range now
      if (liveWord.word !== edit.originalWord) continue;    // word changed since LLM saw it
      if (edit.editedWord === edit.originalWord) continue;  // no-op edit
      const existingDef = this.dynDefs.get(edit.wordIndex);
      if (existingDef && isOwnedByOtherSource(existingDef)) continue; // active substitution from another source landed since
      if (seenIndices.has(edit.wordIndex)) {                // LLM emitted a duplicate for this slot
        this._logFn(`AgentLoop: dropping duplicate edit at idx ${edit.wordIndex} ("${edit.editedWord}")`);
        continue;
      }
      seenIndices.add(edit.wordIndex);
      surviving.push(edit);
    }

    const applied = surviving.length;
    if (applied > 0) {
      this._logFn(`AgentLoop: applied ${applied}/${edits.length} edit(s) as DynDefs`);

      // Splice right-to-left so earlier indices' char offsets stay
      // valid. (The OLD wordSpans are computed once over `liveText` so
      // each edit's start/end refer to the pre-splice frame.)
      const sortedDesc = surviving.slice().sort((a, b) => b.wordIndex - a.wordIndex);
      let newText = liveText;
      for (const edit of sortedDesc) {
        const w = liveWords[edit.wordIndex];
        newText = newText.slice(0, w.start) + edit.editedWord + newText.slice(w.end);
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
        const altWordCount = edit.editedWord.split(/\s+/).filter(Boolean).length;
        const newWordIndex = edit.wordIndex + cumulativeWordDelta;
        const startWord = newWords[newWordIndex];
        const endWord = newWords[newWordIndex + Math.max(0, altWordCount - 1)];
        // Defensive: if our shift miscalculated and the position is
        // out of range (shouldn't happen for surviving edits), drop
        // the def rather than store at a bogus index.
        if (!startWord || !endWord) {
          this._logFn(`AgentLoop: skipping def store — newWordIndex ${newWordIndex} out of range (${newWords.length} words)`);
          continue;
        }
        // Shift PRIOR defs at higher indices BEFORE storing the new
        // one. A multi-word edit (1 → N words) shifts every later
        // word position right by N-1, so DynDefs from earlier passes
        // would otherwise end up off-by-(N-1) and either render the
        // dim on the wrong word or get pruned on the next user
        // text-change. Done strictly before the set() so the new
        // def we're about to insert at newWordIndex isn't itself
        // shifted (shiftAfter only touches idx > newWordIndex).
        const wordDelta = altWordCount - 1;
        if (wordDelta !== 0) {
          this.dynDefs.shiftAfter(newWordIndex, wordDelta);
        }
        const def: WordDef = {
          originalWord: edit.originalWord,
          alternatives: [edit.originalWord, edit.editedWord],
          currentIndex: 1,                                  // showing edit
          spanStart: startWord.start,
          spanEnd: endWord.end,
          blankName: 'agent-task',                          // locks against re-resolution
        };
        this.dynDefs.set(newWordIndex, def);
        // Retry-mode cache: record at the NEW index using the hash of
        // the post-edit visible word (first word of the edited phrase).
        // Without this, the next pass would compute hash of the new
        // word, miss the cache (which had OLD hash), and re-ask the LLM
        // about something it just translated. The original "skip
        // un-edited" branch above already left those un-cached on
        // purpose — they're the words we actually want reconsidered.
        if (retryMode) {
          this.state.recordEvaluation(newWordIndex, hashWordText(startWord.word));
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
          const w = liveWords[edit.wordIndex];
          if (w.end <= cursorBefore) {
            cursorAdjusted += edit.editedWord.length - edit.originalWord.length;
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
    // Format: <idx> | <orig> | <edit-or-KEEP>
    const parts = trimmed.split('|').map(s => s.trim());
    if (parts.length !== 3) continue;
    const idx = parseInt(parts[0], 10);
    if (Number.isNaN(idx) || idx < 0) continue;
    const orig = parts[1];
    const edit = parts[2];
    if (!orig || !edit) continue;
    // KEEP marker — explicit no-op, don't include as an edit
    if (/^keep$/i.test(edit)) continue;
    if (edit === orig) continue;  // model emitted unchanged value, treat as no-op
    edits.push({ wordIndex: idx, originalWord: orig, editedWord: edit });
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

RULES:
1. Walk the candidate list MENTALLY before emitting. Don't stop early — check every single candidate.
2. Each emitted line: <wordIndex> | <originalWord> | <editedWord>
3. Be conservative on AMBIGUOUS edits — when in doubt, skip. Be exhaustive on UNAMBIGUOUS edits (typos, proper-noun capitalisation, etc.).
4. Multi-word transformations are NOT supported. Skip words you can't fix in a single-word swap.
5. Pay special attention to the LAST few candidate indices — they're easy to miss.

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
END`;
