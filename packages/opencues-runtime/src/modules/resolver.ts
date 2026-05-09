// Resolver — debounced LLM-backed cycle population.
//
// Subscribes onTextChange (user-source only). After a quiet period
// (debounceMs, default 500), builds a CueContext from the current text
// and calls opencues-core's resolver with merged sources from cuesConfig +
// blanksConfig. Resolved results populate DynDefs so Cycling can rotate
// LLM-suggested alternatives on Ctrl+Alt+Up/Down.
//
// In-flight cancellation: a generation counter is bumped on every
// scheduleResolve. Resolved batches whose generation no longer matches
// the latest are dropped — prevents stale alts overwriting newer state.
//
// User mid-cycle protection: if a DynDef entry has currentIndex > 0
// (user has cycled past the original), the resolver leaves it alone.

import type { HostAdapter, TextChangeEvent, Unsubscribe } from '../adapter';
import type { ConfigLoader } from './config-loader';
import type { DynDefs, WordDef } from '../state/dyn-defs';
import { reconstructAsTyped, reconstructAsTypedWithMap } from '../state/dyn-defs';
import type { HighlightState } from '../state/highlight-state';
import type { SpanFillState } from '../state/span-fill';
import type { AgentTaskState } from '../state/agent-task';
import { splitWords } from './navigation';

export interface ResolverOptions {
  /** Legacy single-key endpoint. Prefer `apiKeys` for multi-provider. */
  readonly endpoint: string;
  /** Legacy single-key. Plumbed in as GROQ_API_KEY when `apiKeys` is unset. */
  readonly apiKey: string;
  /** Legacy default model when no per-feature override is configured. */
  readonly defaultModel: string;
  /**
   * API keys keyed by provider env-var name. Populated by boot from
   * process.env (or settings UI). Lets cues.md frontmatter pick a
   * non-Groq provider without rebuilding the patch.
   */
  readonly apiKeys?: Readonly<Record<string, string | undefined>>;
  /** Default 500ms — same as v1's auto-submit debounce. */
  readonly debounceMs?: number;
  /** Optional injection seam for tests. When set, runtime uses this instead
   *  of constructing a NodeHttpAdapter. Should expose at least .post(). */
  readonly httpAdapter?: unknown;
  /** Same — inject the resolver build directly (mostly for testing). */
  readonly resolverFactory?: (cuesConfig: unknown, blanksConfig: unknown, opts: unknown) => unknown;
}

interface CuesCoreLike {
  buildSourcesFromConfig(c: unknown, b: unknown, o: unknown): unknown[];
  createResolver(sources: unknown[], opts: unknown): { resolve(ctx: unknown): Promise<{ results: CueResultLike[] }> };
}

interface CueResultLike {
  wordIndex: number;
  word: string;
  alternatives: string[];
  cueTip?: string;
  altCueTips?: Record<string, string>;
  /** Multi-word span in CHARACTER offsets — set by FluidBlankSource WIPE mode. */
  spanStart?: number;
  spanEnd?: number;
  /** Source id — used to detect fluid-blank for auto-substitute. */
  source?: string;
  /** Source-specific metadata. TransformBlank uses taskAction for agent
   *  task commands (TASK_ARM/ADD/STOP/SHOW). */
  metadata?: Record<string, unknown>;
}

/** Duck-typed view of RoutedWordSourceGroup. We don't import the
 *  class — the runtime treats core sources as opaque — but we do
 *  reach in for the public `classify(word)` helper to surface
 *  per-word routing decisions on `resolver.completed`. The only
 *  shape we care about: `id === 'word-cues'` + `classify(word)
 *  → { id: string } | null`. */
interface RoutedWordSourceGroupLike {
  readonly id: string;
  classify(word: string): { id?: string } | null;
}
function isRoutedWordGroup(s: unknown): s is RoutedWordSourceGroupLike {
  return !!s
    && typeof s === 'object'
    && (s as { id?: unknown }).id === 'word-cues'
    && typeof (s as { classify?: unknown }).classify === 'function';
}

export class Resolver {
  private _resolver: { resolve(ctx: unknown): Promise<{ results: CueResultLike[] }> } | null = null;
  private _sources: unknown[] = [];
  private _httpAdapter: unknown = null;
  private _unsubText: Unsubscribe | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _generation = 0;
  /** Last user-typed text — used to detect when `_` was just added so we
   *  can bypass the debounce and fire fluid-blank resolution immediately. */
  private _lastInputText = '';

  /** Snapshot of the opt-in settings the resolver was last built with.
   *  Re-computed on every resolve; mismatch → rebuildResolver before
   *  running so `opencues.md` flag flips take effect on the next
   *  keystroke (no host restart required). */
  private _lastBuildKey: string | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    private configLoader: ConfigLoader,
    private options: ResolverOptions,
    private spanFillState?: SpanFillState,
    private agentTaskState?: AgentTaskState,
  ) {}

  subscribe(): void {
    this.rebuildResolver();
    this._unsubText = this.adapter.onTextChange(e => this.onTextChange(e));
  }

  /**
   * Handle a TASK_* command from EXTRACT — mutate AgentTaskState and
   * substitute new buffer content. Only the trailing trigger phrase
   * (`agentically <X> _`, `add task <X> _`, `stop task _`, `current task
   * _`) is stripped from the buffer; any prose the user typed before
   * the trigger is preserved so the agent can act on it.
   *
   * - TASK_ARM   → arm a fresh task; strip trigger fragment
   * - TASK_ADD   → append to existing task prompt; strip trigger fragment
   * - TASK_STOP  → clear task; strip trigger fragment
   * - TASK_SHOW  → strip trigger fragment, append current task prompt
   */
  private handleTaskCommand(action: string, payload: string, originalText: string, _liveText: string): void {
    if (!this.agentTaskState) return;
    const state = this.agentTaskState;

    // If the buffer has agent-edited words, the trigger keyword may
    // not be findable directly in `originalText` (the visible buffer).
    // Build the as-typed view + mapping; trim uses asTyped to LOCATE
    // the trigger and the mapping to translate the strip range back
    // to visible chars (preserving the agent's other edits).
    let asTyped: string | undefined;
    let asTypedToVisible: readonly number[] | undefined;
    if (this.dynDefs.size > 0) {
      const recon = reconstructAsTypedWithMap(originalText, this.dynDefs, splitWords);
      if (recon.asTyped !== originalText) {
        asTyped = recon.asTyped;
        asTypedToVisible = recon.asTypedToVisible;
      }
    }
    const prefix = trimTriggerFromText(action, originalText, asTyped, asTypedToVisible);
    let newText: string;
    let newCursor: number;

    switch (action) {
      case 'TASK_ARM':
        state.arm(payload);
        this.adapter.log('info', `AgentTask: ARM (taskId=${state.taskId?.slice(0, 8)}…, prompt="${payload}")`);
        newText = prefix;
        newCursor = newText.length;
        break;
      case 'TASK_ADD':
        if (!state.armed) {
          // Treat add-without-prior-arm as an arm
          state.arm(payload);
          this.adapter.log('info', `AgentTask: ADD-as-ARM (no prior task; taskId=${state.taskId?.slice(0, 8)}…, prompt="${payload}")`);
        } else {
          state.appendToPrompt(payload);
          this.adapter.log('info', `AgentTask: ADD (taskId=${state.taskId?.slice(0, 8)}…, prompt="${state.prompt}")`);
        }
        newText = prefix;
        newCursor = newText.length;
        break;
      case 'TASK_STOP':
        this.adapter.log('info', `AgentTask: STOP (was prompt="${state.prompt}")`);
        state.stop();
        newText = prefix;
        newCursor = newText.length;
        break;
      case 'TASK_SHOW': {
        // Substitute the current prompt at the trigger position. If no
        // task armed, show "(no task armed)".
        const promptText = state.armed ? state.prompt : '(no task armed)';
        newText = prefix ? `${prefix} ${promptText}` : promptText;
        newCursor = newText.length;
        this.adapter.log('info', `AgentTask: SHOW (prompt="${promptText}")`);
        break;
      }
      default:
        return;  // unknown action — defensive no-op
    }

    if (this.adapter.pushText) {
      this.adapter.pushText(newText, newCursor);
    } else {
      this.adapter.setText(newText);
      this.adapter.setCursorOffset(newCursor);
      this.adapter.forceRender();
    }

    // TASK_SHOW emits the substituted prompt as a DynDef span — same
    // mechanic fluid-blank uses for WIPE substitutions. Press
    // Ctrl+Alt+Down on the inserted prompt to cycle back to empty
    // (deletes the whole substitution as a single unit, leaving any
    // surrounding prose intact). Without this, the user would have to
    // backspace each character of the prompt one at a time.
    //
    // We register the def AFTER pushText so the wordIndex is computed
    // against the new text. alternatives[0] is the empty string (revert
    // = remove the substitution) and alternatives[1] is the prompt
    // itself (the currently-displayed value).
    if (action === 'TASK_SHOW') {
      const spanStart = prefix ? prefix.length + 1 : 0;
      const spanEnd = newText.length;
      const newWords = splitWords(newText);
      const firstPromptWord = newWords.find(w => w.start >= spanStart);
      if (firstPromptWord) {
        this.dynDefs.set(firstPromptWord.index, {
          originalWord: '_',
          alternatives: ['', newText.slice(spanStart, spanEnd)],
          currentIndex: 1,
          spanStart,
          spanEnd,
          // Lock against re-resolution by other LLM-driven sources —
          // same flag fluid-blank's substitutions use.
          blankName: 'task-show',
        });
      }
    }
  }

  unsubscribe(): void {
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
  }

  /** Rebuild sources + resolver from current configLoader state. Call after
   *  configLoader.load() resolves and on hot-reload. */
  rebuildResolver(): void {
    // Use merged configs (cwd .md + folder cues/* + folder blanks/*) so the
    // resolver sees prompt sources from both layers in one CueResolver.
    const cuesConfig = this.configLoader.mergedCuesConfig ?? this.configLoader.cuesConfig;
    const blanksConfig = this.configLoader.mergedBlanksConfig ?? this.configLoader.blanksConfig;
    if (!cuesConfig && !blanksConfig) {
      this.adapter.log('info', 'Resolver: no cuesConfig/blanksConfig, skipping build');
      return;
    }

    if (!this._httpAdapter) {
      if (this.options.httpAdapter !== undefined) {
        this._httpAdapter = this.options.httpAdapter;
      } else {
        try {
          // Lazy require so tests without opencues-core/node-http-adapter still load.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { NodeHttpAdapter } = require('@opencues/core/node-http-adapter');
          this._httpAdapter = new NodeHttpAdapter({ maxSockets: 2, timeout: 30000 });
        } catch (err) {
          this.adapter.log('error', 'Resolver: NodeHttpAdapter load failed', err);
          return;
        }
      }
    }

    let cuesCore: CuesCoreLike;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cuesCore = require('@opencues/core');
    } catch (err) {
      this.adapter.log('error', 'Resolver: opencues-core load failed', err);
      return;
    }

    // Endpoint + model precedence: opencues.md `llm-endpoint:` /
    // `llm-model:` > host-supplied default. Lets users switch providers
    // without re-applying the patch.
    //
    // Per-feature settings (resolution order, most → least specific):
    //   per-cue/blank frontmatter (`provider:` / `model:`)
    //     > per-feature (`agent-provider:`, `fluid-blank-model:`, …)
    //       > global (`llm-provider:` / `llm-model:`)
    //         > built-in default (groq / openai/gpt-oss-120b)
    //
    // The build-sources factory does the actual resolution; we just
    // shovel the relevant settings down.
    const settings = this.configLoader.opencuesState.settings;
    const buildOpts = {
      httpAdapter: this._httpAdapter,
      // Multi-provider keys; `apiKey` (legacy) is still passed for the
      // sources that ship-defaulted to Groq before the abstraction.
      apiKeys: this.options.apiKeys,
      apiKey: this.options.apiKey,
      endpoint: settings.get('llm-endpoint') ?? this.options.endpoint,
      defaultModel: settings.get('llm-model') ?? this.options.defaultModel,
      // Global tier (read once per build).
      globalProvider: settings.get('llm-provider'),
      globalModel: settings.get('llm-model') ?? this.options.defaultModel,
      globalEndpoint: settings.get('llm-endpoint') ?? this.options.endpoint,
      // Per-feature tier.
      wordCues: {
        provider: settings.get('word-cues-provider'),
        model: settings.get('word-cues-model'),
        endpoint: settings.get('word-cues-endpoint'),
      },
      fluidBlank: {
        provider: settings.get('fluid-blank-provider'),
        model: settings.get('fluid-blank-model'),
        endpoint: settings.get('fluid-blank-endpoint'),
      },
      transformBlank: {
        provider: settings.get('transform-blank-provider'),
        model: settings.get('transform-blank-model'),
        endpoint: settings.get('transform-blank-endpoint'),
      },
      // Spelling is a regular config-driven cue now (defaults/cues/
      // spelling.md). It inherits per-cue / `word-cues-*` / global LLM
      // routing through the standard ConfigSource path — no per-feature
      // wiring needed here.
      blanks: this.configLoader.folderConfigs?.blankOverrides ?? {},
      // disable lists from CUES.md / BLANKS.md. Each is the union across
      // every search-path layer — ConfigLoader merged them in load().
      disableCues: this.configLoader.folderConfigs?.cuesConfig?.disableCues ?? [],
      disableBlanks: this.configLoader.folderConfigs?.blanksConfig?.disableBlanks ?? [],
      // ALL opt-in: every cue surface defaults to OFF. User flips on via
      // opencues.md. Missing settings → off. Explicit "on" → on.
      // See packages/opencues-core/src/sources/build-sources.ts for what
      // each flag gates.
      enableFluidBlank: settings.get('fluid-blank-mode') === 'on',
      enableTransformBlank: settings.get('transform-blank-mode') === 'on',
      enableWordCues: settings.get('word-cues-mode') === 'on',
      // Debug log sink — surfaces TransformBlankSource pipeline traces
      // when opencues.md `debug-mode: on`. The adapter.log gates 'debug'
      // level via isDebugEnabled (set up in boot-common.ts), so off-mode
      // users get no log spam.
      log: (msg: string) => this.adapter.log('debug', msg),
      // Adapt core's typed source events into the runtime's namespaced
      // event stream. Core owns the event names + body shapes; runtime
      // adds the `<source-id>.` prefix when forwarding to
      // adapter.emitEvent. Silent when emitEvent is undefined (i.e.
      // agentic harness not armed). Each source's event union is
      // imported dynamically because cuesCore is type-erased at the
      // seam (see CuesCoreLike) — the explicit parameter types keep
      // strict-mode happy without re-importing the whole core surface.
      onTransformBlankEvent: (event: import('@opencues/core').TransformBlankEvent) => {
        const { type, ...body } = event;
        this.adapter.emitEvent?.(`transform-blank.${type}`, body);
      },
      onFluidBlankEvent: (event: import('@opencues/core').FluidBlankEvent) => {
        const { type, ...body } = event;
        this.adapter.emitEvent?.(`fluid-blank.${type}`, body);
      },
    };
    let sources: unknown[];
    try {
      sources = (this.options.resolverFactory ?? cuesCore.buildSourcesFromConfig)(
        cuesConfig, blanksConfig, buildOpts,
      ) as unknown[];
    } catch (err) {
      this.adapter.log('error', 'Resolver: buildSourcesFromConfig failed', err);
      return;
    }

    this._sources = sources;
    this._resolver = cuesCore.createResolver(sources, {
      // Parallel: all sources run concurrently. Total latency = max(source
      // times) instead of sum. The merge-by-priority happens after all
      // return so result correctness is unchanged.
      parallel: true,
      timeout: 30000,
      continueOnError: true,
    });
    this._lastBuildKey = this.computeBuildKey();
    // BlankSource isn't in this list — keyword-bound blanks dispatch
    // synchronously through BlankFill, separate from the resolver.
    const ids = sources.map(s => (s as { id?: string }).id ?? '?').join(', ');
    this.adapter.log('info', `Resolver: built with ${sources.length} sources [${ids}]`);
  }

  /** Stable string fingerprint of the source-affecting settings. When this
   *  changes between resolves (user flipped a flag in `opencues.md` and
   *  ConfigLoader hot-reloaded), rebuild the resolver so the new flag
   *  state takes effect without a host restart. */
  private computeBuildKey(): string {
    const s = this.configLoader.opencuesState.settings;
    return [
      s.get('fluid-blank-mode') ?? '',
      s.get('transform-blank-mode') ?? '',
      s.get('word-cues-mode') ?? '',
      s.get('llm-endpoint') ?? '',
      s.get('llm-model') ?? '',
      s.get('llm-provider') ?? '',
      s.get('word-cues-provider') ?? '', s.get('word-cues-model') ?? '', s.get('word-cues-endpoint') ?? '',
      s.get('fluid-blank-provider') ?? '', s.get('fluid-blank-model') ?? '', s.get('fluid-blank-endpoint') ?? '',
      s.get('transform-blank-provider') ?? '', s.get('transform-blank-model') ?? '', s.get('transform-blank-endpoint') ?? '',
    ].join('|');
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private onTextChange(e: TextChangeEvent): void {
    if (e.source !== 'user') return; // ignore our own setText echoes
    if (!this._resolver) return;

    // If opencues.md flags changed since last build, rebuild before
    // dispatching. ConfigLoader hot-reloads opencuesState on text-change
    // but doesn't notify Resolver, so without this check a flag flip
    // (`fluid-blank-mode: off → on`, `word-cues-mode: off → on`, …)
    // would only take effect on next host restart.
    const currentKey = this.computeBuildKey();
    if (currentKey !== this._lastBuildKey) {
      this.adapter.log('info', `Resolver: opencues.md flags changed — rebuilding sources`);
      this.rebuildResolver();
    }

    // Fluid-blank fast-path: when the user just typed `_` (it's at the
    // trailing edge AND wasn't there before), bypass the debounce and
    // resolve immediately. Cuts the magical-helper latency from ~1000ms
    // to ~500ms by skipping the 500ms debounce that exists to coalesce
    // mid-word typing.
    const text = e.text;
    const prev = this._lastInputText;
    this._lastInputText = text;
    const blankJustTyped = text.trimEnd().endsWith('_') && !prev.trimEnd().endsWith('_');
    if (blankJustTyped) {
      if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
      this.adapter.log('debug', 'Resolver: _ trigger — bypassing debounce');
      void this.resolveAndApply(text);
      return;
    }

    this.scheduleResolve(text);
  }

  private scheduleResolve(text: string): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    const delay = this.options.debounceMs ?? 500;
    this._debounceTimer = setTimeout(() => {
      void this.resolveAndApply(text);
    }, delay);
  }

  /** Exposed for tests. */
  async resolveAndApply(text: string): Promise<void> {
    if (!this._resolver) return;
    const generation = ++this._generation;
    const t0 = Date.now();
    this.adapter.log('debug', `Resolver.resolveAndApply: text=${JSON.stringify(text.slice(0, 80))}`);
    this.adapter.emitEvent?.('resolver.started', {
      text: text.slice(0, 200),
      textLen: text.length,
      generation,
    });

    const wordSpans = splitWords(text);
    // Skip words we've already resolved. Empty strings get filtered out
    // by RoutedWordSourceGroup + every other CueSource — no LLM call.
    // Rules:
    //   - Blanks (`_`) always re-resolve — their context determines the
    //     answer and may have changed.
    //   - Words inside an active blank-fill (SpanFillState) are owned
    //     by cycling; re-querying would waste tokens.
    //   - Words inside ANY multi-word static-alt span (DynDefs-derived)
    //     are owned by cycling — origin OR inner positions.
    //   - A DynDef at this index already claims the position. The word
    //     might be:
    //         (a) the def's originalWord (untouched after resolve)
    //         (b) the def's currentAlt (user cycled to a single-word alt)
    //     Both cases mean cycling owns this word and the resolver must
    //     not second-guess it. Without this, cycling attorney → lawyer
    //     would let the resolver re-evaluate "lawyer" as a fresh word
    //     and drift the alt track (lawyer → client → customer → ...).
    const span = this.spanFillState?.current;
    const cleanWords = wordSpans.map((w, i) => {
      const cleaned = w.word.replace(/[\u200B\u200C]/g, '');
      if (cleaned === '_') return cleaned;
      if (span && i >= span.index && i < span.index + span.spanLength) return '';
      if (this.dynDefs.findSpanContaining(i)) return '';
      const existing = this.dynDefs.get(i);
      if (existing && existing.alternatives.length > 1) {
        const currentAlt = existing.alternatives[existing.currentIndex] ?? '';
        const currentFirstWord = currentAlt.split(/\s+/).filter(Boolean)[0] ?? '';
        if (existing.originalWord === cleaned || currentFirstWord === cleaned) return '';
      }
      return cleaned;
    });

    // "As-typed" reconstruction: visible buffer with every agent-edited
    // word reverted to its originalWord. transform-blank's EXTRACT
    // uses this to detect TASK_* triggers against what the user TYPED,
    // not what the agent rendered — so commands work even if the agent
    // edited some of their constituent words.
    //
    // Only build it when there's at least one DynDef (the typical case
    // is empty); skip the work otherwise.
    let asTypedText: string | undefined;
    if (this.dynDefs.size > 0) {
      const reconstructed = reconstructAsTyped(text, this.dynDefs, splitWords);
      if (reconstructed !== text) asTypedText = reconstructed;
    }

    let result;
    try {
      result = await this._resolver.resolve({
        text,
        words: cleanWords,
        domain: 'claude-code',
        asTypedText,
      });
    } catch (err) {
      this.adapter.log('error', 'Resolver.resolve threw', err);
      return;
    }

    this.adapter.log('debug', `Resolver.resolve: got ${result.results.length} result(s) for ${cleanWords.length} cleanWords`);
    // Per-word routing/skipped surfaces which ConfigSource claimed each
    // word — the structural property RoutedWordSourceGroup enforces for
    // prompt-injection isolation. Empty-string entries in cleanWords
    // mean a span/dyndef already owns the position; they're not surfaced
    // here (internal optimisation, not a routing decision). `_` tokens
    // route through the blank handlers, also out of scope. Words with
    // no claiming source land in `skipped` — useful for catching cue
    // configurations with unintended coverage gaps.
    const routing: Array<{ wordIndex: number; word: string; sourceId: string }> = [];
    const skipped: Array<{ wordIndex: number; word: string }> = [];
    const wordCueGroup = this._sources.find(isRoutedWordGroup);
    if (wordCueGroup) {
      for (let i = 0; i < cleanWords.length; i++) {
        const w = cleanWords[i];
        if (!w || w === '_') continue;
        const dest = wordCueGroup.classify(w);
        if (dest && dest.id) routing.push({ wordIndex: i, word: w, sourceId: dest.id });
        else skipped.push({ wordIndex: i, word: w });
      }
    }
    this.adapter.emitEvent?.('resolver.completed', {
      text: text.slice(0, 200),
      textLen: text.length,
      cleanWords: cleanWords.length,
      resultCount: result.results.length,
      latencyMs: Date.now() - t0,
      generation,
      routing,
      skipped,
    });

    // Stale check — a newer scheduleResolve might have run in between.
    if (generation !== this._generation) return;

    let wrote = 0;
    for (const r of result.results) {
      const target = wordSpans[r.wordIndex];
      if (!target) continue;
      const existing = this.dynDefs.get(r.wordIndex);
      // Don't clobber a user mid-cycle on this word.
      if (existing && existing.currentIndex > 0) continue;
      // Don't clobber blank-attributed entries (volume/brightness blank
      // fills, satellite cycles, etc.) — those route through their own
      // cycling path and have a script set/get protocol the LLM alts
      // would silently break.
      if (existing && existing.blankName) continue;
      // Already resolved — same word at the same index, fresh from a
      // prior LLM pass. Without this, every subsequent text-change
      // (typing the next word, adding a space) clobbers the existing
      // DynDef with a new LLM result. Alts can differ slightly across
      // runs, and each write triggers a forceRender → repaint flash.
      // Only re-resolve if the word at this index actually changed
      // (user deleted/replaced the word).
      if (existing && existing.originalWord === target.word) continue;
      // Tip-having words own their own alternatives via the cueMap
      // (the hand-curated `alts` array under cues.md's `## Tips` JSON
      // block). The LLM returning grammar synonyms for `ultrathink`
      // etc. would silently override the curated list. Mirrors the
      // legacy CC cue-engine's `skipFn: word => tipsMap.has(word)`
      // filter on the LLM source.
      const cueMapEntry = this.configLoader.lookup(target.word);
      if (cueMapEntry && cueMapEntry.alternatives && cueMapEntry.alternatives.length > 1) continue;
      const alts = (r.alternatives ?? []).filter(a => a && a !== target.word);
      if (alts.length === 0) continue;
      // FluidBlankSource sets spanStart/spanEnd (character offsets) when
      // it wants the answer to wipe a multi-word lookup phrase, not just
      // the single _ token. Cycling back to alt[0] = `_` clears the
      // lookup phrase to a bare blank.
      const isMultiWordSpan = typeof r.spanStart === 'number'
        && typeof r.spanEnd === 'number'
        && r.spanEnd > r.spanStart;
      const isFluidBlank = r.source === 'fluid-blank';
      const isTransformBlank = r.source === 'transform-blank';
      // Fluid-blank substitutes inline (BlankFill-style). For WIPE mode the
      // text shrinks so the wordIndex shifts — we have to compute the def's
      // FINAL position in the new text and key the def there, not at the
      // resolver's r.wordIndex (which referred to the pre-substitute text).
      // Without this the def is orphaned at an out-of-bounds index and the
      // next resolve generates synonym alts for the answer position.
      if (isFluidBlank && alts.length > 0) {
        // Race guard: BlankFill runs synchronously after
        // its blankScript returns and can populate the `_` BEFORE this
        // LLM-driven path completes. If `_` is no longer in the live text
        // at the expected position, BlankFill already won — skip our
        // substitute so we don't overwrite "nvidia $209.25" with "NVDA".
        const liveText = this.adapter.getText();
        const start = isMultiWordSpan ? r.spanStart! : target.start;
        if (liveText.charAt(start) !== '_' && !liveText.includes('_')) {
          this.adapter.log('info', 'FluidBlank: skipping — _ already substituted by another module');
          continue;
        }
        const answer = alts[0];
        const end = isMultiWordSpan ? r.spanEnd! : target.end;
        const newText = text.slice(0, start) + answer + text.slice(end);
        const newCursor = start + answer.length;

        // Find which word in the new text the answer sits at.
        const newWords = splitWords(newText);
        const newWord = newWords.find(w => w.start === start);
        const newWordIndex = newWord ? newWord.index : r.wordIndex;
        const newSpanEnd = newWord ? newWord.end : newCursor;

        const fluidDef: WordDef = {
          originalWord: '_',
          alternatives: ['_', ...alts],
          currentIndex: 1,
          spanStart: start,
          spanEnd: newSpanEnd,
          // blankName locks this def against re-resolution by the LLM —
          // same mechanism blank-bound entries use to prevent the answer
          // from being clobbered by RoutedWordSourceGroup synonyms.
          blankName: 'fluid-blank',
        };
        this.dynDefs.set(newWordIndex, fluidDef);
        wrote++;

        this.adapter.log('info', `FluidBlank: substituting "${text.slice(start, end)}" → "${answer}" (mode=${isMultiWordSpan ? 'WIPE' : 'FILL'}, range=[${start},${end}), defAt=${newWordIndex})`);
        if (this.adapter.pushText) {
          this.adapter.pushText(newText, newCursor);
        } else {
          this.adapter.setText(newText);
          this.adapter.setCursorOffset(newCursor);
          this.adapter.forceRender();
        }
        continue; // skip the generic def-creation below
      }

      // TransformBlank: imperative-instruction handler. Source returns
      //   alternatives = [originalFullText, rewrittenText]
      //   spanStart=0, spanEnd=originalFullText.length
      // Auto-substitutes the rewrite in place (same magical-helper feel
      // as fluid-blank), then registers a def keyed at index 0 so the
      // user can cycle Down to revert to the original instruction +
      // target text.
      if (isTransformBlank && r.alternatives.length >= 2) {
        const originalText = r.alternatives[0];
        const rewrittenText = r.alternatives[1];
        const liveText = this.adapter.getText();

        // Race guard — if the live text no longer matches what we
        // analyzed, another module already touched it. Skip.
        if (liveText !== originalText) {
          this.adapter.log('info', `TransformBlank: skipping — live text changed since resolve (live len=${liveText.length}, original len=${originalText.length})`);
          continue;
        }

        // TASK COMMAND ROUTING — TASK_ARM/TASK_ADD/TASK_STOP/TASK_SHOW
        // mutate AgentTaskState instead of running the normal substitute
        // path. The rewrittenText is computed from the live state.
        const taskAction = r.metadata?.taskAction as string | undefined;
        const taskPayload = (r.metadata?.taskPayload as string | undefined) ?? '';
        if (taskAction && this.agentTaskState) {
          this.handleTaskCommand(taskAction, taskPayload, originalText, liveText);
          continue;
        }

        // Find which word the rewrite's first word lands at in the new
        // text (for keying the def). Default to index 0 since the entire
        // text is being replaced.
        const newWords = splitWords(rewrittenText);
        const newWordIndex = newWords.length > 0 ? newWords[0].index : 0;
        const newSpanEnd = newWords.length > 0 ? newWords[newWords.length - 1].end : rewrittenText.length;

        const transformDef: WordDef = {
          originalWord: originalText,
          // alternatives[0] = original full text (cycle Down to revert)
          // alternatives[1] = rewritten text (currently showing)
          alternatives: [originalText, rewrittenText],
          currentIndex: 1,            // showing rewrite
          spanStart: 0,
          spanEnd: newSpanEnd,
          // blankName locks this def from re-resolution by the LLM —
          // same mechanism fluid-blank uses.
          blankName: 'transform-blank',
        };
        this.dynDefs.set(newWordIndex, transformDef);
        wrote++;

        const previewLen = 60;
        const origPreview = originalText.length > previewLen ? originalText.slice(0, previewLen) + '…' : originalText;
        const rewritePreview = rewrittenText.length > previewLen ? rewrittenText.slice(0, previewLen) + '…' : rewrittenText;
        this.adapter.log('info', `TransformBlank: substituting "${origPreview}" → "${rewritePreview}" (origLen=${originalText.length}, rewriteLen=${rewrittenText.length}, defAt=${newWordIndex})`);

        const newCursor = rewrittenText.length;
        if (this.adapter.pushText) {
          this.adapter.pushText(rewrittenText, newCursor);
        } else {
          this.adapter.setText(rewrittenText);
          this.adapter.setCursorOffset(newCursor);
          this.adapter.forceRender();
        }
        continue;
      }

      const def: WordDef = isMultiWordSpan ? {
        originalWord: '_',
        alternatives: ['_', ...alts],
        currentIndex: 0,
        spanStart: r.spanStart!,
        spanEnd: r.spanEnd!,
      } : {
        originalWord: target.word,
        alternatives: [target.word, ...alts],
        currentIndex: 0,
        spanStart: target.start,
        spanEnd: target.end,
      };
      this.dynDefs.set(r.wordIndex, def);
      wrote++;
    }
    // Force a paint so DimRender/Statusline pick up the new alts without
    // waiting for the user's next keystroke. Hosts with no idle render
    // loop (e.g. OpenCode's onContentChange-only path) need this.
    if (wrote > 0) this.adapter.forceRender();
  }
}

// Trigger keywords that EXTRACT pattern-matches to produce each TASK_*
// verdict. Used at apply time to find where in the buffer the trailing
// trigger fragment starts so we can strip ONLY that fragment instead of
// wiping any prose the user typed before it. Source-of-truth for the
// patterns lives in transform-blank-source.ts's EXTRACT prompt.
//
// Exported as the canonical trigger map; agent-rewrite uses its
// presence in the prompt's task instructions but doesn't need explicit
// "protection" — its full-rewrite + three-way-merge architecture
// can't accidentally translate these keywords mid-stream the way the
// legacy per-keystroke AgentLoop could.
export const TASK_TRIGGER_KEYWORDS: Record<string, string> = {
  TASK_ARM: 'agentically',
  TASK_ADD: 'add task',
  TASK_STOP: 'stop task',
  TASK_SHOW: 'current task',
};

function trimTriggerFromText(
  action: string,
  visibleText: string,
  asTyped?: string,
  asTypedToVisible?: readonly number[],
): string {
  const kw = TASK_TRIGGER_KEYWORDS[action];
  if (!kw) return '';

  // Locate the trigger keyword. Prefer the as-typed view when one is
  // supplied — it's robust to agent-edited trigger words (e.g. agent
  // translated `agentically` → `agentisch` in the visible buffer; the
  // user's typed `agentically` is still in `asTyped`). When the user's
  // trigger keyword survives in visible (the typical case), the visible
  // search succeeds the same way it always did.
  let start: number;
  let blankIdx: number;
  if (asTyped && asTypedToVisible) {
    const asTypedKwStart = asTyped.toLowerCase().lastIndexOf(kw);
    if (asTypedKwStart < 0) {
      // Fall through to visible search as a fallback.
      start = visibleText.toLowerCase().lastIndexOf(kw);
      blankIdx = start >= 0 ? visibleText.indexOf('_', start) : -1;
    } else {
      const asTypedBlankIdx = asTyped.indexOf('_', asTypedKwStart);
      // Map both anchors back to visible char positions.
      start = asTypedToVisible[asTypedKwStart] ?? visibleText.toLowerCase().lastIndexOf(kw);
      blankIdx = asTypedBlankIdx >= 0
        ? (asTypedToVisible[asTypedBlankIdx] ?? visibleText.indexOf('_', start))
        : -1;
    }
  } else {
    start = visibleText.toLowerCase().lastIndexOf(kw);
    blankIdx = start >= 0 ? visibleText.indexOf('_', start) : -1;
  }
  // Defensive fallback: if the keyword still isn't findable, preserve
  // the pre-fix legacy behaviour of wiping the buffer.
  if (start < 0) return '';
  if (blankIdx < 0) {
    return visibleText.slice(0, start).replace(/ +$/, '');
  }
  // Strip [start, blankIdx+1] from visible. Trim ONLY space chars on
  // each flank — preserving newlines so paragraph structure
  // ("para1\n\nstop task _\n\npara2") survives. Insert ONE space at the
  // join only when both sides end up non-whitespace (mid-sentence
  // trigger) so we don't run words together.
  const before = visibleText.slice(0, start).replace(/ +$/, '');
  const after = visibleText.slice(blankIdx + 1).replace(/^ +/, '');
  const needsSpace = before.length > 0 && after.length > 0
    && !/\s$/.test(before) && !/^\s/.test(after);
  return needsSpace ? `${before} ${after}` : `${before}${after}`;
}
