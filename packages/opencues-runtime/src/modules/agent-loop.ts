// Agent Loop — continuous-evaluation runtime module.
//
// When an agent task is armed (via `agentically <X> _`), this module
// subscribes to text-change events, debounces, and re-evaluates the
// buffer against the task prompt on every settle. Found edits are
// applied as DynDef entries with blankName='agent-task' so the
// existing dim-render / cycling / skip-filter machinery picks them
// up for free.
//
// See docs/architecture/agent-task.md for the full design.
//
// Status: v1 — minimal viable loop. Many decisions deferred to the
// benchmark phase (Experiment markers in code show where).

import type { HostAdapter, TextChangeEvent, Unsubscribe } from '../adapter';
import type { DynDefs, WordDef } from '../state/dyn-defs';
import type { SpanFillState } from '../state/span-fill';
import type { AgentTaskState } from '../state/agent-task';
import { hashWordText } from '../state/agent-task';
import { splitWords } from './navigation';

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
}

export interface AgentEdit {
  readonly wordIndex: number;
  readonly originalWord: string;
  readonly editedWord: string;
}

/**
 * Cheap content preview for log output (don't dump 5000-char doc).
 */
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
    //  - words owned by SpanFillState (active blank-fill)
    //  - words owned by DynDefs (any other source)
    //  - words already-evaluated under the current taskId (cache hit)
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
      if (this.dynDefs.get(i)) continue;                    // any DynDef owns this index
      const hash = hashWordText(word);
      if (this.state.isEvaluated(i, hash)) continue;        // already-checked under current task
      candidates.push({ wordIndex: i, word, hash });
    }

    if (candidates.length === 0) {
      this._logFn(`AgentLoop: no candidates (textLen=${text.length}, allWords=${wordSpans.length})`);
      return;
    }

    this._logFn(`AgentLoop: starting (textLen=${text.length}, candidates=${candidates.length}/${wordSpans.length}, taskId=${this.state.taskId?.slice(0, 8)}…)`);

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

    // Record evaluations for ALL candidates (we asked, we got an answer
    // — even "no edit" counts as evaluated under this taskId).
    for (const c of candidates) {
      this.state.recordEvaluation(c.wordIndex, c.hash);
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

    let applied = 0;
    for (const edit of edits) {
      // Defensive checks against post-debounce text mutations:
      if (!candidateSet.has(edit.wordIndex)) continue;      // outside candidate set
      const liveWord = liveWords[edit.wordIndex];
      if (!liveWord) continue;                              // index out of range now
      if (liveWord.word !== edit.originalWord) continue;    // word changed since LLM saw it
      if (edit.editedWord === edit.originalWord) continue;  // no-op edit
      if (this.dynDefs.get(edit.wordIndex)) continue;       // claimed by something else now

      const def: WordDef = {
        originalWord: edit.originalWord,
        alternatives: [edit.originalWord, edit.editedWord],
        currentIndex: 1,                                    // showing edit
        spanStart: liveWord.start,
        spanEnd: liveWord.start + edit.editedWord.length,
        blankName: 'agent-task',                            // locks against re-resolution
      };
      this.dynDefs.set(edit.wordIndex, def);
      applied += 1;
    }

    if (applied > 0) {
      this._logFn(`AgentLoop: applied ${applied}/${edits.length} edit(s) as DynDefs`);

      // Apply edits to the actual buffer text. We have to do this via
      // setText since DynDefs only declare ownership — they don't
      // mutate the buffer. Build the new text by splicing each edit.
      let newText = liveText;
      // Apply right-to-left so earlier indices' offsets stay valid.
      // Same candidateSet filter as above — only edits that survived
      // the apply-loop's checks should mutate the buffer.
      const sorted = edits
        .filter(e => candidateSet.has(e.wordIndex)
          && liveWords[e.wordIndex] && liveWords[e.wordIndex].word === e.originalWord
          && e.editedWord !== e.originalWord)
        .sort((a, b) => b.wordIndex - a.wordIndex);
      for (const edit of sorted) {
        const w = liveWords[edit.wordIndex];
        newText = newText.slice(0, w.start) + edit.editedWord + newText.slice(w.end);
      }
      if (newText !== liveText) {
        if (this.adapter.pushText) {
          this.adapter.pushText(newText, this.adapter.getCursorOffset());
        } else {
          this.adapter.setText(newText);
          this.adapter.forceRender();
        }
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
    const system = `You are an inline editor running continuously in the background of a user's document. You receive a TASK PROMPT (what the user wants you to do), a DOC (the current text), and a list of CANDIDATE INDICES you may edit. Your job: emit a verdict for EACH candidate — KEEP if no edit, or the edited word.

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
END

TASK PROMPT: correct spelling
DOC: [0]thier [1]proposal [2]was [3]carefuly [4]recieved
Candidate indices: [0, 1, 2, 3, 4]
DECISIONS:
0 | thier | their
1 | proposal | KEEP
2 | was | KEEP
3 | carefuly | carefully
4 | recieved | received
END`;

    const wordSpans = splitWords(text);
    const docWithIndices = wordSpans.map((w, i) => `[${i}]${w.word}`).join(' ');
    const userMsg = `TASK PROMPT: ${prompt}
DOC: ${docWithIndices}

Candidate word indices (you MAY edit only these — others are owned by other systems): [${candidateIndices.join(', ')}]`;

    // Dynamic max_tokens: DECISIONS format emits ONE LINE PER CANDIDATE,
    // so the output scales with candidate count. ~30 tokens per line
    // (idx + word + verdict + separators), plus reasoning headroom.
    // Floor at 1024 for short docs, ceiling at 4096 for long ones.
    const estLines = candidateIndices.length;
    const maxTokens = Math.max(1024, Math.min(4096, estLines * 30 + 600));
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

    const data = JSON.parse(response);
    if (data.error) {
      this._logFn(`AgentLoop: API error — ${data.error.message ?? JSON.stringify(data.error)}`);
      return [];
    }
    const out: string = data.choices?.[0]?.message?.content ?? '';
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
