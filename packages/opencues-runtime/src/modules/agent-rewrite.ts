// Agent Rewrite — cadence-driven, transform-blank-style agent.
//
// The architectural simplification (May 2026): instead of generating
// per-edit proposals and judging them individually, we run ONE LLM
// call per round that emits the FULL REWRITTEN BUFFER. We then diff
// the rewrite against our snapshot, three-way-merge against the live
// buffer (so user typing during the LLM call is never clobbered),
// and splice the surviving hunks into the live buffer.
//
// Replaces ~1000 lines of generator + judge + four runtime guards
// (sentence-fingerprint, oscillation, shape, edge-dup) with one
// round-trip and one merge. The four guards become unnecessary:
//   - drift: the merge drops LLM hunks that overlap user hunks.
//   - oscillation: each round re-reads from current state — no past
//     decisions to invert.
//   - cascades: there's only ONE rewrite per round, so the LLM can't
//     emit a flurry of correlated micro-edits.
//   - edge-duplication: the rewrite IS the final text — there's
//     nothing to compose.
//
// See word-diff.ts for the merge geometry. The single agent module —
// the legacy per-keystroke AgentLoop and proposal-queue Judge were
// retired once AgentRewrite proved its merge layer made the per-edit
// guards structurally unnecessary.

import type { HostAdapter } from '../adapter';
import type { DynDefs, WordDef } from '../state/dyn-defs';
import type { AgentTaskState } from '../state/agent-task';
import { hashWordText } from '../state/agent-task';
import { splitWords } from './navigation';
import { wordDiff, threeWayMerge, translateAToC, type DiffHunk } from './word-diff';

export interface AgentRewriteOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  /** Cadence in ms. Default 1500. */
  readonly cadenceMs?: number;
  /** Optional injection seam for tests. */
  readonly httpAdapter?: { post(url: string, body: string, headers: Record<string, string>): Promise<string> };
  /** Optional log function — wires through to adapter.log('debug', ...) by default. */
  readonly log?: (msg: string) => void;
}

export class AgentRewrite {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _httpAgent: { post(url: string, body: string, headers: Record<string, string>): Promise<string> } | null = null;
  private _logFn: (msg: string) => void;
  /**
   * Recent applied buffer states. If a new merge would put the buffer
   * into a state we've already been in, skip — that's the oscillation
   * pattern (LLM flipping between two valid forms across rounds, e.g.
   * "you'll" vs "you will"). Without this, the user sees visible
   * flicker as the buffer toggles each tick.
   */
  private _recentApplied: string[] = [];

  constructor(
    private adapter: HostAdapter,
    private dynDefs: DynDefs,
    private state: AgentTaskState,
    private options: AgentRewriteOptions,
  ) {
    this._logFn = options.log ?? ((msg) => this.adapter.log('debug', msg));
  }

  start(): void {
    if (this._timer) return;
    const cadence = this.options.cadenceMs ?? 1500;
    this._timer = setInterval(() => { void this.tick(); }, cadence);
    this._logFn(`AgentRewrite: started (cadence=${cadence} ms)`);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      this._logFn('AgentRewrite: stopped');
    }
  }

  /** Run one round. Exposed for tests + benchmark harness. */
  async tick(): Promise<void> {
    if (this._running) return;
    if (!this.state.armed) return;
    const snapshot = this.adapter.getText();
    if (!snapshot.trim()) return;

    this._running = true;
    try {
      const cursorAtSnapshot = this.adapter.getCursorOffset();
      const taskAtSnapshot = this.state.prompt;
      this._logFn(`AgentRewrite: round start (textLen=${snapshot.length}, cursor=${cursorAtSnapshot}, taskId=${this.state.taskId?.slice(0, 8)}…)`);

      let rewrite: string | null;
      try {
        rewrite = await this.callLLM(snapshot, taskAtSnapshot);
      } catch (err) {
        this._logFn(`AgentRewrite: LLM call failed — ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (rewrite === null) return;

      const validation = validateLLMRewrite(snapshot, rewrite);
      if (!validation.ok) {
        this._logFn(`AgentRewrite: ${validation.reason}`);
        return;
      }

      // Task changed mid-round? The user issued a fresh ARM/ADD/STOP
      // while we were waiting on the LLM. Drop this round's results;
      // the new prompt will rerun next tick.
      if (!this.state.armed || this.state.prompt !== taskAtSnapshot) {
        this._logFn('AgentRewrite: task changed mid-round — discarding rewrite');
        return;
      }

      const live = this.adapter.getText();
      const merged = threeWayMerge(snapshot, rewrite, live);

      const hunkPreview = (h: { aStart: number; aEnd: number; replacement: string }, src: string): string => {
        const orig = src.slice(h.aStart, h.aEnd);
        const fmt = (s: string): string => JSON.stringify(s.length > 30 ? s.slice(0, 27) + '…' : s);
        return `[${h.aStart},${h.aEnd}] ${fmt(orig)} → ${fmt(h.replacement)}`;
      };
      this._logFn(
        `AgentRewrite: merge result (applied=${merged.appliedLlmHunks.length}, dropped=${merged.droppedLlmHunks.length}, userHunks=${merged.userHunks.length})` +
        (merged.appliedLlmHunks.length > 0 ? ` applied=[${merged.appliedLlmHunks.map(h => hunkPreview(h, snapshot)).join(', ')}]` : '') +
        (merged.droppedLlmHunks.length > 0 ? ` dropped=[${merged.droppedLlmHunks.map(h => hunkPreview(h, snapshot)).join(', ')}]` : '')
      );

      if (merged.newText === live) {
        // Either no surviving LLM hunks, or all merged into a no-op.
        return;
      }

      // Anti-oscillation: if the proposed merge would land us in a
      // state we've already been in, skip. Catches the LLM flipping
      // between two valid forms ("you'll" ↔ "you will") on
      // consecutive rounds and stops the visible flicker.
      if (this._recentApplied.includes(merged.newText)) {
        this._logFn(`AgentRewrite: skipping oscillation (rewrite matches recent applied state)`);
        return;
      }

      this.applyMerged(merged.newText, live, merged.appliedLlmHunks, merged.userHunks);
      this._recentApplied.push(merged.newText);
      while (this._recentApplied.length > 3) this._recentApplied.shift();
    } finally {
      this._running = false;
    }
  }

  /**
   * Splice merged.newText into the buffer, translate cursor across the
   * combined user+LLM deltas, and emit one DynDef per applied LLM hunk
   * so the user can cycle (Down) to revert any individual change.
   */
  private applyMerged(
    newText: string,
    live: string,
    appliedLlmHunks: ReadonlyArray<DiffHunk>,
    userHunks: ReadonlyArray<DiffHunk>,
  ): void {
    const cursorBefore = this.adapter.getCursorOffset();
    const cursor = this.translateCursor(cursorBefore, newText, appliedLlmHunks, userHunks);
    this.pushBuffer(newText, cursor);
    this.placeDynDefs(newText, live, appliedLlmHunks, userHunks);
  }

  /**
   * Compute the new cursor position. For each LLM hunk strictly before
   * the live cursor, shift by the hunk's length delta. User hunks already
   * shape the live text — no extra delta to add.
   *
   * Result is clamped to [0, newText.length]: out-of-bounds cursors land
   * at 0 in OpenCode (the host clamps differently from us), visible as
   * "cursor jumped to start of buffer." The clamp is belt-and-braces;
   * the deltas should already be in range.
   */
  private translateCursor(
    cursorBefore: number,
    newText: string,
    appliedLlmHunks: ReadonlyArray<DiffHunk>,
    userHunks: ReadonlyArray<DiffHunk>,
  ): number {
    let cursorAdjusted = cursorBefore;
    for (const h of appliedLlmHunks) {
      const cStart = translateAToC(h.aStart, userHunks, 'start');
      const cEnd = translateAToC(h.aEnd, userHunks, 'end');
      if (cEnd <= cursorBefore) {
        cursorAdjusted += h.replacement.length - (cEnd - cStart);
      }
    }
    const clamped = Math.max(0, Math.min(cursorAdjusted, newText.length));
    if (clamped !== cursorAdjusted) {
      this._logFn(`AgentRewrite: clamping cursor ${cursorAdjusted} → ${clamped} (newText.length=${newText.length})`);
    }
    return clamped;
  }

  /** Hand the new buffer to the host. Prefer pushText (cursor-aware). */
  private pushBuffer(newText: string, cursor: number): void {
    if (this.adapter.pushText) {
      this.adapter.pushText(newText, cursor);
    } else {
      this.adapter.setText(newText);
      this.adapter.forceRender();
    }
  }

  /**
   * Store one DynDef per applied LLM hunk so cycling Down can revert it.
   * Pure insertions are skipped (cycling needs both sides). The def's
   * "originalWord" is drawn from the LIVE buffer (post user edits) —
   * that's the version the user actually had before the agent rewrote.
   */
  private placeDynDefs(
    newText: string,
    live: string,
    appliedLlmHunks: ReadonlyArray<DiffHunk>,
    userHunks: ReadonlyArray<DiffHunk>,
  ): void {
    const newWords = splitWords(newText);
    for (const h of appliedLlmHunks) {
      const cStart = translateAToC(h.aStart, userHunks, 'start');
      const cEnd = translateAToC(h.aEnd, userHunks, 'end');
      if (cStart === cEnd) continue;                 // pure insertion: no "before" to cycle to
      const replEnd = cStart + h.replacement.length;
      // Find new-frame words covered by the replacement's char range.
      let firstWordIdx = -1, lastWordIdx = -1;
      for (let i = 0; i < newWords.length; i++) {
        const w = newWords[i];
        if (w.end <= cStart) continue;
        if (w.start >= replEnd) break;
        if (firstWordIdx === -1) firstWordIdx = i;
        lastWordIdx = i;
      }
      if (firstWordIdx === -1 || lastWordIdx === -1) continue;
      const startWord = newWords[firstWordIdx];
      const endWord = newWords[lastWordIdx];
      const liveOriginalText = live.slice(cStart, cEnd);
      const def: WordDef = {
        originalWord: liveOriginalText,
        alternatives: [liveOriginalText, h.replacement],
        currentIndex: 1,
        spanStart: startWord.start,
        spanEnd: endWord.end,
        blankName: 'agent-task',
      };
      this.dynDefs.set(firstWordIdx, def);
      this.state.recordEditSignature(liveOriginalText, h.replacement);
      this.state.recordEvaluation(firstWordIdx, hashWordText(startWord.word));
    }
  }

  /**
   * Call the LLM with the rewrite prompt. Returns the rewritten buffer
   * text, or null on parse / API failure (caller swallows null and
   * waits for the next tick).
   */
  private async callLLM(text: string, task: string): Promise<string | null> {
    // Insert a [CURSOR] sentinel so the LLM knows where the user is
    // typing. Used by the prompt's "do not auto-terminate the in-flight
    // sentence" rule. The sentinel is stripped before the merge — see
    // parseRewriteOutput.
    const cursor = this.adapter.getCursorOffset();
    const docWithCursor = text.slice(0, cursor) + CURSOR_SENTINEL + text.slice(cursor);
    const userMsg = `TASK: ${task || '(none)'}\nDOCUMENT:\n${docWithCursor}`;
    const body = JSON.stringify({
      model: this.options.defaultModel,
      messages: [
        { role: 'system', content: REWRITE_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      max_tokens: Math.max(1024, Math.ceil(text.length * 1.5) + 256),
      temperature: 0,
      reasoning_effort: 'low',
      seed: 42,
    });
    const agent = this.options.httpAdapter ?? this.getHttpAgent();
    const response = await agent.post(this.options.endpoint, body, {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.options.apiKey}`,
    });
    if (!response || !response.trim()) return null;
    let data: { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    try {
      data = JSON.parse(response);
    } catch (err) {
      this._logFn(`AgentRewrite: response not JSON — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (data.error) {
      this._logFn(`AgentRewrite: API error — ${data.error.message ?? JSON.stringify(data.error)}`);
      return null;
    }
    const out = data.choices?.[0]?.message?.content ?? '';
    if (!out) {
      this._logFn(`AgentRewrite: response had no content`);
      return null;
    }
    return parseRewriteOutput(out);
  }

  private getHttpAgent(): { post(url: string, body: string, headers: Record<string, string>): Promise<string> } {
    if (this._httpAgent) return this._httpAgent;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NodeHttpAdapter } = require('@opencues/core/node-http-adapter');
    this._httpAgent = new NodeHttpAdapter({ maxSockets: 2, timeout: 30000 });
    return this._httpAgent!;
  }
}

/**
 * Extract the rewritten document from the LLM's response.
 *
 * Lenient — accepts:
 *   REWRITTEN:\n<text>\nEND
 *   REWRITTEN:\n<text>             (no END — take rest of response)
 *   <text>                          (no marker at all — assume the whole
 *                                    response is the rewrite, after
 *                                    stripping any leading code fence)
 */
export const CURSOR_SENTINEL = '[CURSOR]';

/**
 * Validate the LLM's rewritten document against four sanity checks.
 * Each was added in response to an actual Groq misbehaviour the
 * harness caught — see `discover-groq.test.ts` for repros.
 *
 *   1. Identical to snapshot → no-op round.
 *   2. Empty / whitespace-only rewrite on a non-empty snapshot → LLM
 *      error (timeout, content filter, parse miss). Don't apply.
 *   3. Rewrite < 30% of snapshot's length on a substantial doc → likely
 *      truncation; the user's content would be wiped.
 *   4. Rewrite is a strict prefix of the snapshot AND > 20% shorter →
 *      "model output got cut off" signature. Skip.
 *
 * Returns `{ ok: false, reason }` on a fail; `{ ok: true }` to proceed.
 * The `reason` string is logged so the trigger is visible in
 * /tmp/opencues.log.
 */
export function validateLLMRewrite(snapshot: string, rewrite: string): { ok: true } | { ok: false; reason: string } {
  if (rewrite === snapshot) {
    return { ok: false, reason: 'rewrite identical to snapshot — no-op round' };
  }
  if (rewrite.trim().length === 0 && snapshot.trim().length > 0) {
    return { ok: false, reason: 'rewrite empty/whitespace-only on non-empty snapshot — discarding' };
  }
  if (rewrite.length < snapshot.length * 0.3 && snapshot.length > 20) {
    return { ok: false, reason: `rewrite suspiciously short (${rewrite.length} vs snapshot ${snapshot.length}) — discarding` };
  }
  if (rewrite.length < snapshot.length * 0.8 && snapshot.startsWith(rewrite)) {
    return { ok: false, reason: `rewrite is a strict prefix of snapshot (truncation; ${rewrite.length}/${snapshot.length}) — discarding` };
  }
  return { ok: true };
}

export function parseRewriteOutput(raw: string): string | null {
  let s = raw.trim();
  // Strip ```...``` code fences if the model emitted them despite our
  // "no fences" instruction.
  s = s.replace(/^```(?:\w+)?\n/, '').replace(/\n```$/, '').trim();
  const startMatch = s.match(/REWRITTEN:\s*\n/i);
  if (startMatch) {
    const start = startMatch.index! + startMatch[0].length;
    let tail = s.slice(start);
    // Strip from the FIRST standalone END line onward — handles the
    // case where the model emits content + END + trailing comment, OR
    // duplicates the END marker. Prevents the "buffer briefly contains
    // END" flicker the user sees when a stricter end-of-response anchor
    // doesn't match.
    const endMatch = tail.match(/^\s*END\s*$/im);
    if (endMatch) tail = tail.slice(0, endMatch.index!);
    s = tail.trim();
  } else if (s.length === 0) {
    return null;
  }
  // Defensive: strip any remaining standalone END line that snuck through
  // (e.g. model emitted no REWRITTEN: marker but still appended END).
  s = s.replace(/\n\s*END\s*$/i, '').trim();
  // Strip the cursor sentinel — input-only, never part of the rewrite.
  s = s.replace(/\[CURSOR\]/g, '').replace(/\[cursor\]/g, '');
  return s;
}

const REWRITE_SYSTEM_PROMPT = `You are an inline editor. The user is composing a document and has given you a TASK. Your job: return the rewritten document with the task applied — making whatever spelling, grammar, capitalisation, punctuation, and content changes the task asks for.

The DOCUMENT contains a [CURSOR] marker showing where the user is currently typing. You MUST omit the [CURSOR] marker from your output (it's input only). Use it to identify the IN-FLIGHT SENTENCE — the sentence containing the cursor — which the user is still composing and may extend at any moment.

Rules:
- Output the ENTIRE rewritten document. Do not truncate, abbreviate, or summarise. Strip the [CURSOR] marker.
- Apply baseline edits even if the TASK doesn't explicitly ask: capitalise sentence-starts and proper nouns, fix obvious typos, collapse duplicated stop-words.
- TERMINAL PUNCTUATION (period, question mark, exclamation): add it ONLY when the sentence has a clear next-sentence after it (paragraph break, OR another sentence starting with a capitalised word). NEVER add terminal punctuation to the IN-FLIGHT SENTENCE — the user may still be typing it. NEVER add it to a sentence at the very end of the document with no following content.
- WHITESPACE STRUCTURE IS SACRED. Reproduce every newline EXACTLY as it appears in the input. A paragraph break (\\n\\n) MUST stay \\n\\n. A single newline MUST stay a single newline. Do NOT collapse \\n\\n into \\n, do NOT remove trailing newlines, do NOT canonicalise spacing. The user's whitespace structure is the user's choice.
- Do NOT add stylistic punctuation (salutation commas, appositive commas, em dashes) unless the TASK explicitly asks for it.
- Do NOT add commentary, explanations, code fences, or markdown decorations. Output the rewritten document and nothing else.

Output format:

REWRITTEN:
<the entire rewritten document, with [CURSOR] stripped>
END`;
