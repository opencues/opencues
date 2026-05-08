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

/**
 * Subset of the @opencues/core `ProviderAdapter` shape that
 * AgentRewrite needs. Inlined here (rather than imported) so the
 * runtime can be unit-tested without pulling the core package onto
 * the test runner — the runtime's tests pass mock providers anyway.
 *
 * For real boots, the host loads @opencues/core and passes one of its
 * built-in adapters (groq / openrouter / gemini / openai). Boot also
 * has the option of selecting a per-feature override via cues.md
 * frontmatter (`agent-provider:` / `agent-model:`).
 */
export interface AgentRewriteProviderAdapter {
  readonly id: string;
  readonly defaultModel: string;
  buildRequest(
    req: {
      model: string;
      messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      maxTokens?: number;
      temperature?: number;
      seed?: number;
      reasoningEffort?: 'low' | 'medium' | 'high';
    },
    ctx: { apiKey: string; endpoint?: string },
  ): { url: string; body: string; headers: Record<string, string> };
  parseResponse(rawJson: string): string;
}

export interface ResolvedAgentLLM {
  readonly provider: AgentRewriteProviderAdapter;
  readonly model: string;
  readonly endpoint: string;
  readonly apiKey: string;
  /**
   * Optional auto-fallback target for transient failures (429, 5xx,
   * network errors). When set, AgentRewrite re-issues against this
   * provider on a transient primary failure. Same wire-shape required
   * (OpenAI-compat ↔ OpenAI-compat). Boot-common populates this from
   * `@opencues/core`'s `resolveLLM()`, which auto-pairs groq ↔
   * cerebras when both keys are configured.
   */
  readonly fallback?: ResolvedAgentLLM | null;
}

export interface AgentRewriteOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  /**
   * Lazy resolver for the active provider/model/endpoint/key. Called
   * before each LLM tick so the user can flip `agent-provider:` /
   * `agent-model:` at runtime via cues.md without a restart. When
   * unset (or returns null), AgentRewrite falls back to the static
   * endpoint/apiKey/defaultModel above and the legacy Groq-shaped wire
   * format — preserves back-compat for boot files that haven't
   * migrated to multi-provider.
   */
  readonly resolveLLM?: () => ResolvedAgentLLM | null;
  /** Debounce window between text-change → tick. Reset on every
   *  keystroke; the tick fires only after the user pauses for this long.
   *  Default 1000ms. Accepts a number (static, used by tests) or a thunk
   *  re-read on every scheduleTick (used by boots so the user-overridable
   *  `agent-debounce-ms` setting in OPENCUES.md hot-reloads). Misparses /
   *  non-positive values fall back to the default. */
  readonly cadenceMs?: number | (() => number);
  /** Optional injection seam for tests. */
  readonly httpAdapter?: { post(url: string, body: string, headers: Record<string, string>): Promise<string> };
  /** Optional log function — wires through to adapter.log('debug', ...) by default. */
  readonly log?: (msg: string) => void;
  /**
   * Optional sliding-window mode: when set to a positive integer N, the
   * LLM input is restricted to a window of approximately N words around
   * the cursor (plus paragraph context). Cuts token cost ~10× on long
   * docs at the price of losing global cross-paragraph context.
   * Default 0 (full-buffer mode).
   *
   * Lazy thunk so users can flip the setting at runtime via cues.md.
   */
  readonly windowWords?: () => number;
  /**
   * Optional auditor-prompt thunk. Returns the ordered list of auditor
   * prompt fragments to compose into the rewrite system prompt. Each
   * fragment is one concern — grammar, clarity, jargon, etc. — and they
   * concatenate into ONE LLM call (never one call per auditor).
   *
   * Lazy thunk so the runtime re-reads on every tick: enabling/disabling
   * an auditor or editing AUDITORS.md propagates without restart. The
   * runtime's ConfigLoader exposes `composeAuditorPrompts()` which does
   * the priority sort + disable filter; boots wire it as the thunk.
   *
   * Empty / absent → no auditor section is appended; the rewrite runs
   * with only the baseline editor preamble. See spec/auditor-spec.md.
   */
  readonly auditorPrompts?: () => Array<{ name: string; promptText: string }>;
}

/**
 * Bounded LRU cap for the (snapshot, task) → rewrite cache. Each entry
 * is roughly one buffer's worth of text; 64 covers backspace+retype and
 * re-arming the same task on the same buffer without growing forever
 * during a long writing session.
 */
const REWRITE_CACHE_MAX = 64;

export class AgentRewrite {
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _unsubText: (() => void) | null = null;
  private _running = false;
  private _started = false;
  private _httpAgent: { post(url: string, body: string, headers: Record<string, string>): Promise<string> } | null = null;
  private _logFn: (msg: string) => void;
  /**
   * Recent applied buffer states. Anti-oscillation guard.
   */
  private _recentApplied: string[] = [];
  /**
   * Cache of `(snapshot, task, cursor, window) → rewrite` results. Groq
   * at temp=0+seed=42 is effectively deterministic, so identical input
   * produces identical output. Caching means:
   *   - Idle ticks (event-driven scheduler still fires once on arm):
   *     snapshot equals last seen → cache hit, no LLM call.
   *   - Backspace+retype: returning to a known state → cache hit.
   *   - Re-arming the same task on the same buffer → cache hit.
   * Bounded LRU; oldest entry drops on overflow. Insertion order =
   * recency since Map preserves insertion order and we delete+reinsert
   * on hit.
   */
  private _rewriteCache = new Map<string, string>();
  /**
   * Last (snapshot, task, cursor) tuple we saw stable across a tick (no
   * surviving LLM hunks AFTER the merge dropped overlaps). Skipping the
   * LLM call when the current state matches this is the bulk of the
   * cost savings on idle keystrokes — no cache lookup, no token
   * accounting, no I/O. Cursor is part of the key because the cursor
   * sentinel changes the LLM input — same buffer with cursor in a
   * different sentence may flip the terminal-punctuation decision.
   */
  private _lastStableSnapshot: string | null = null;
  private _lastStableTask: string | null = null;
  private _lastStableCursor: number = -1;

  constructor(
    private adapter: HostAdapter,
    private dynDefs: DynDefs,
    private state: AgentTaskState,
    private options: AgentRewriteOptions,
  ) {
    this._logFn = options.log ?? ((msg) => this.adapter.log('debug', msg));
  }

  /**
   * Subscribe to text-change events so ticks fire only when the buffer
   * has actually moved. A debounce window (cadenceMs, default 1000) lets
   * a burst of typing settle before the LLM call. Idle = no calls at
   * all — the previous setInterval design burned an LLM call every
   * 1.5 s even when the user wasn't typing.
   *
   * The first tick still fires on start() so the agent reacts to ARM
   * even on a static buffer (the user typed before arming).
   */
  /**
   * Read the configured cadence as a positive integer ms. Falls back to
   * 1000ms on:
   * - undefined (no option set)
   * - thunk that returns a non-finite or non-positive value
   * - parseInt-style misparse (NaN)
   */
  private getCadenceMs(): number {
    const raw = typeof this.options.cadenceMs === 'function'
      ? this.options.cadenceMs()
      : this.options.cadenceMs;
    if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 1000;
    return raw;
  }

  start(): void {
    if (this._started) return;
    this._started = true;
    const cadence = this.getCadenceMs();
    this._unsubText = this.adapter.onTextChange(() => this.scheduleTick());
    // Kick a first tick: the user may have armed without typing.
    this.scheduleTick();
    this._logFn(`AgentRewrite: started (event-driven, debounce=${cadence} ms)`);
  }

  stop(): void {
    if (!this._started) return;
    this._started = false;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._unsubText) {
      this._unsubText();
      this._unsubText = null;
    }
    this._logFn('AgentRewrite: stopped');
  }

  /**
   * Schedule a tick after the debounce window. Resetting the timer on
   * every text-change event collapses a burst of keystrokes into one
   * LLM call after the user pauses.
   */
  private scheduleTick(): void {
    if (!this._started) return;
    const cadence = this.getCadenceMs();
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      void this.tick();
    }, cadence);
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

      // Skip-on-stable: if this exact (snapshot, task, cursor) was the
      // result of our last applied round, the LLM has already converged
      // on this state. No call, no merge, no further work.
      if (
        snapshot === this._lastStableSnapshot
        && taskAtSnapshot === this._lastStableTask
        && cursorAtSnapshot === this._lastStableCursor
      ) {
        this._logFn(`AgentRewrite: skipping (buffer stable since last round)`);
        return;
      }

      this._logFn(`AgentRewrite: round start (textLen=${snapshot.length}, cursor=${cursorAtSnapshot}, taskId=${this.state.taskId?.slice(0, 8)}…)`);

      const windowWords = this.options.windowWords?.() ?? 0;
      const cacheKey = makeCacheKey(snapshot, taskAtSnapshot, cursorAtSnapshot, windowWords);
      let rewrite: string | null;
      const cached = this._rewriteCache.get(cacheKey);
      if (cached !== undefined) {
        // Refresh LRU order: re-insert moves the entry to most-recent.
        this._rewriteCache.delete(cacheKey);
        this._rewriteCache.set(cacheKey, cached);
        this._logFn(`AgentRewrite: cache hit (${this._rewriteCache.size} entries) — skipping LLM call`);
        rewrite = cached;
      } else {
        try {
          rewrite = await this.callLLM(snapshot, taskAtSnapshot);
        } catch (err) {
          this._logFn(`AgentRewrite: LLM call failed — ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (rewrite !== null) {
          this._rewriteCache.set(cacheKey, rewrite);
          while (this._rewriteCache.size > REWRITE_CACHE_MAX) {
            const oldest = this._rewriteCache.keys().next().value;
            if (oldest === undefined) break;
            this._rewriteCache.delete(oldest);
          }
        }
      }
      if (rewrite === null) return;

      const validation = validateLLMRewrite(snapshot, rewrite);
      if (!validation.ok) {
        this._logFn(`AgentRewrite: ${validation.reason}`);
        // Identical-rewrite IS the stable signal — record it so future
        // ticks can short-circuit. Other validation failures (truncation
        // etc.) are LLM glitches, not stability signals.
        if (rewrite === snapshot) {
          this._lastStableSnapshot = snapshot;
          this._lastStableTask = taskAtSnapshot;
          this._lastStableCursor = cursorAtSnapshot;
        }
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
        // Record stable so the next tick on the same buffer skips
        // entirely (cache lookup avoided).
        this._lastStableSnapshot = live;
        this._lastStableTask = taskAtSnapshot;
        this._lastStableCursor = this.adapter.getCursorOffset();
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
      // Buffer changed — old stability marker is invalid. Next tick
      // will hit the LLM (or cache) for the new snapshot.
      this._lastStableSnapshot = null;
      this._lastStableTask = null;
      this._lastStableCursor = -1;
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
   * text (always FULL-buffer-shaped — windowed mode splices the window
   * rewrite back into the unchanged surrounding text before returning),
   * or null on parse / API failure (caller swallows null and waits for
   * the next tick).
   */
  private async callLLM(text: string, task: string): Promise<string | null> {
    // Insert a [CURSOR] sentinel so the LLM knows where the user is
    // typing. Used by the prompt's "do not auto-terminate the in-flight
    // sentence" rule. The sentinel is stripped before the merge — see
    // parseRewriteOutput.
    const cursor = this.adapter.getCursorOffset();
    const windowWords = this.options.windowWords?.() ?? 0;
    const window = computeWindow(text, cursor, windowWords);
    const windowedText = text.slice(window.start, window.end);
    const windowedCursor = cursor - window.start;
    const docWithCursor = windowedText.slice(0, windowedCursor) + CURSOR_SENTINEL + windowedText.slice(windowedCursor);
    if (window.start > 0 || window.end < text.length) {
      this._logFn(`AgentRewrite: window mode (chars ${window.start}–${window.end} of ${text.length}, ~${windowWords} words)`);
    }
    const userMsg = `TASK: ${task || '(none)'}\nDOCUMENT:\n${docWithCursor}`;
    const resolved = this.options.resolveLLM?.() ?? null;
    const provider = resolved?.provider ?? null;
    const model = resolved?.model ?? this.options.defaultModel;
    const endpoint = resolved?.endpoint ?? this.options.endpoint;
    const apiKey = resolved?.apiKey ?? this.options.apiKey;
    // Compose auditor prompts into the system message. Each auditor
    // contributes one concern; they concatenate into ONE LLM call. The
    // runtime owns the wrapping (heading delimiter); each AUDITOR.md
    // body declares only its concern. See spec/auditor-spec.md.
    const auditors = this.options.auditorPrompts?.() ?? [];
    const systemContent = auditors.length === 0
      ? REWRITE_SYSTEM_PROMPT
      : `${REWRITE_SYSTEM_PROMPT}\n\nApply the following auditors in order. Each declares one concern; act on all of them in a single rewrite.\n\n${auditors.map(a => `## ${a.name}\n${a.promptText}`).join('\n\n')}`;
    const chatRequest = {
      model,
      messages: [
        { role: 'system' as const, content: systemContent },
        { role: 'user' as const, content: userMsg },
      ],
      maxTokens: Math.max(1024, Math.ceil(windowedText.length * 1.5) + 256),
      temperature: 0,
      reasoningEffort: 'low' as const,
      seed: 42,
    };
    let url: string;
    let body: string;
    let headers: Record<string, string>;
    if (provider) {
      const built = provider.buildRequest(chatRequest, { apiKey, endpoint });
      url = built.url;
      body = built.body;
      headers = built.headers;
    } else {
      // Legacy Groq-shaped path. Kept inline (rather than always going
      // through a provider adapter) so the runtime has zero hard
      // dependency on @opencues/core for boot files that haven't
      // migrated to passing a provider thunk.
      url = endpoint;
      body = JSON.stringify({
        model: chatRequest.model,
        messages: chatRequest.messages,
        max_tokens: chatRequest.maxTokens,
        temperature: chatRequest.temperature,
        reasoning_effort: chatRequest.reasoningEffort,
        seed: chatRequest.seed,
      });
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    }
    const agent = this.options.httpAdapter ?? this.getHttpAgent();
    // Auto-fallback on transient failures (429, 5xx, network). Same
    // wire-shape required — `resolveLLM()` only attaches a fallback
    // when it's safe (groq ↔ cerebras at the moment).
    const response = await postWithFallback(agent, { url, body, headers }, resolved?.fallback ?? null);
    if (!response || !response.trim()) return null;
    let out: string;
    if (provider) {
      try {
        out = provider.parseResponse(response);
      } catch (err) {
        this._logFn(`AgentRewrite: provider error — ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    } else {
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
      out = data.choices?.[0]?.message?.content ?? '';
    }
    if (!out) {
      this._logFn(`AgentRewrite: response had no content`);
      return null;
    }
    const windowedRewrite = parseRewriteOutput(out);
    if (windowedRewrite === null) return null;
    // Splice the window rewrite back into the surrounding (unchanged)
    // text so the merge layer sees a full-buffer rewrite. The merge's
    // diff against the snapshot will only produce hunks within the
    // window region (outside-window slices match exactly), so this is
    // structurally identical to non-windowed mode from the merge's POV.
    if (window.start > 0 || window.end < text.length) {
      return text.slice(0, window.start) + windowedRewrite + text.slice(window.end);
    }
    return windowedRewrite;
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
 * Heuristic — does `raw` look like a transient failure (rate-limit,
 * server overload, network blip)? Conservative: false positives just
 * waste a retry, false negatives mean the user sees the error.
 *
 * Mirrors the same check in `@opencues/core`'s `withFallback`. Inlined
 * here so AgentRewrite keeps its zero-dep promise to the runtime.
 */
function looksTransientResponse(raw: string): boolean {
  if (!raw || raw.trim().length === 0) return true;
  if (/"code"\s*:\s*"?(429|5\d{2})"?/.test(raw)) return true;
  if (/too[_ -]?many[_ -]?requests|rate[_ -]?limit/i.test(raw)) return true;
  if (/server[_ -]?error|service[_ -]?unavailable|overloaded|timeout/i.test(raw)) return true;
  if (/queue[_ -]?exceeded|queue[_ -]?full/i.test(raw)) return true;
  return false;
}

/**
 * POST + optionally retry against a fallback target on transient
 * failure. Returns the primary's response when it's healthy, or
 * the fallback's response when the primary returned a 429 / 5xx /
 * empty body / network error.
 *
 * The fallback's wire shape must match the primary's (OpenAI-compat
 * ↔ OpenAI-compat) — boot-common only sets `resolved.fallback` when
 * that holds. The body is rewritten on retry to swap the model name
 * (groq's `openai/gpt-oss-120b` ↔ cerebras's `gpt-oss-120b`); URL
 * and bearer-auth header swap to the fallback's.
 */
async function postWithFallback(
  agent: { post(url: string, body: string, headers: Record<string, string>): Promise<string> },
  primary: { url: string; body: string; headers: Record<string, string> },
  fallback: ResolvedAgentLLM | null,
): Promise<string> {
  const tryFallback = async (): Promise<string> => {
    if (!fallback) throw new Error('postWithFallback: no fallback configured');
    let fallbackBody = primary.body;
    try {
      const parsed = JSON.parse(primary.body) as { model?: string };
      if (parsed.model && parsed.model !== fallback.model) {
        parsed.model = fallback.model;
        fallbackBody = JSON.stringify(parsed);
      }
    } catch { /* non-JSON body — pass through unchanged */ }
    const fbHeaders = { ...primary.headers, Authorization: `Bearer ${fallback.apiKey}` };
    return agent.post(fallback.endpoint, fallbackBody, fbHeaders);
  };
  let primaryRaw: string;
  try {
    primaryRaw = await agent.post(primary.url, primary.body, primary.headers);
  } catch (err) {
    if (!fallback) throw err;
    try { return await tryFallback(); } catch { throw err; }
  }
  if (fallback && looksTransientResponse(primaryRaw)) {
    try { return await tryFallback(); } catch { return primaryRaw; }
  }
  return primaryRaw;
}

/**
 * Build a stable cache key for `(snapshot, task, cursor, window)`. The
 * cursor is part of the key because the cursor sentinel changes the
 * LLM's input — same buffer with cursor in a different sentence gets a
 * different terminal-punctuation decision. Window size is keyed too so
 * flipping the setting at runtime invalidates entries naturally.
 *
 * `\u0000`-separated to keep the components disambiguated without an
 * expensive escape pass.
 */
function makeCacheKey(snapshot: string, task: string, cursor: number, windowWords: number): string {
  return `${windowWords}\u0000${cursor}\u0000${task}\u0000${snapshot}`;
}

/**
 * Compute the windowed slice of the buffer to send to the LLM. Returns
 * the original full range [0, text.length] when:
 *   - windowWords is 0 (window mode disabled), OR
 *   - the buffer has fewer words than the window (no point slicing).
 *
 * Otherwise returns the cursor's containing paragraph (chars between
 * the nearest \n\n breaks, or buffer edges). Paragraph is the atomic
 * unit because:
 *   - Terminal-punctuation decisions depend on what comes after a
 *     sentence; sending half a paragraph would mislead the LLM.
 *   - Real writing flows paragraph-by-paragraph; the user is editing
 *     ONE paragraph at any given moment.
 *
 * `windowWords` is a TOGGLE-with-threshold: any positive value enables
 * paragraph mode once the buffer crosses that word count. The number
 * itself doesn't slice mid-paragraph.
 */
export function computeWindow(text: string, cursor: number, windowWords: number): { start: number; end: number } {
  if (windowWords <= 0) return { start: 0, end: text.length };
  const words = splitWords(text);
  if (words.length <= windowWords) return { start: 0, end: text.length };
  const probe = Math.max(0, cursor - 1);
  const prevBreak = text.lastIndexOf('\n\n', probe);
  const start = prevBreak === -1 ? 0 : prevBreak + 2;
  const nextBreak = text.indexOf('\n\n', cursor);
  const end = nextBreak === -1 ? text.length : nextBreak;
  return { start, end };
}

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
