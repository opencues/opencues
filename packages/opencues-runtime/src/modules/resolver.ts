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
import type { SelectorSatelliteState as SelectorSatelliteStateRef } from '../state/selector-satellite';
import { splitWords } from './navigation';
import type { BlankLoadingAnimator } from './blank-loading';
import { applyMarkdownAwareSplice } from './markdown-substitute';

/** Minimal interface MarkdownRender exposes for rich-text injection.
 *  Keeps Resolver from importing MarkdownRender directly (would create
 *  a layering cycle through boot-common). */
export interface MarkdownStylesProvider {
  getCachedPayload(): {
    readonly text: string;
    readonly bold: ReadonlyArray<{ start: number; end: number }>;
    readonly italic: ReadonlyArray<{ start: number; end: number }>;
    readonly code: ReadonlyArray<{ start: number; end: number }>;
    readonly strike: ReadonlyArray<{ start: number; end: number }>;
    readonly heading: ReadonlyArray<{ start: number; end: number }>;
    readonly list: ReadonlyArray<{ start: number; end: number }>;
  } | null;
}

export interface ResolverOptions {
  /** Legacy single-key endpoint. Prefer `apiKeys` for multi-provider. */
  readonly endpoint: string;
  /** Legacy single-key. Plumbed in as GROQ_API_KEY when `apiKeys` is unset. */
  readonly apiKey: string;
  /** Legacy default model when no per-feature override is configured. */
  readonly defaultModel: string;
  /**
   * API keys keyed by provider env-var name. Populated by boot from
   * process.env (or settings UI). Lets CUES.md frontmatter pick a
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
   *  running so `OPENCUES.md` flag flips take effect on the next
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
    /** Shared loading-animator from boot-common. Drives the per-slot
     *  glyph progression while Fluid/Transform pipelines are in flight.
     *  Optional — when omitted, slots stay static during resolution
     *  (legacy behaviour pre-2026-05-13). */
    private blankLoading?: BlankLoadingAnimator,
    /** Shared MarkdownRender — exposes the last styled-text payload so
     *  the resolver can re-inject markdown markers (`**bold**`,
     *  `*italic*`, etc.) into EXTRACT/APPLY input. Without this, an
     *  LLM rewrite asked to "make it caps" loses any prior bold the
     *  user had on a word — markers were stripped from the buffer at
     *  write time and the LLM never sees them on the next pass.
     *  Optional — when omitted, no rich-text view is built. */
    private markdownRender?: MarkdownStylesProvider,
    /** Shared SelectorSatelliteState — needed by the config-intent
     *  substitution branch to register the same cycling state that
     *  BlankFill registers for the keyword-bound `opencues settings _`
     *  path. Without this, ConfigIntent can paint the satellite shape
     *  but cycling won't act on it. Optional — when omitted, the
     *  config-intent branch falls back to inline paint only (no
     *  cycling). */
    private selectorSatelliteState?: SelectorSatelliteStateRef,
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

    // Endpoint + model precedence: OPENCUES.md `llm-endpoint:` /
    // `llm-model:` > host-supplied default. Lets users switch providers
    // without re-applying the patch.
    //
    // Per-feature settings (resolution order, most → least specific):
    //   per-cue/blank frontmatter (`provider:` / `model:`)
    //     > per-feature (`agent-provider:`, `fluid-blank-model:`, …)
    //       > global (`llm-provider:` / `llm-model:`)
    //         > built-in default (cerebras / gpt-oss-120b)
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
      configIntent: {
        provider: settings.get('fluid-config-provider'),
        model: settings.get('fluid-config-model'),
        endpoint: settings.get('fluid-config-endpoint'),
      },
      sentenceCues: {
        provider: settings.get('sentence-cues-provider'),
        model: settings.get('sentence-cues-model'),
        endpoint: settings.get('sentence-cues-endpoint'),
      },
      // Pipeline mode for TransformBlank — `auto` (default) picks per
      // provider via pickTransformBlankMode(); `fused` / `3-pass` force
      // it. Set in CUES.md frontmatter as `transform-blank-mode:`.
      transformBlankMode: settings.get('transform-blank-mode'),
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
      // OPENCUES.md. Missing settings → off. Explicit "on" → on.
      // See packages/opencues-core/src/sources/build-sources.ts for what
      // each flag gates.
      enableFluidBlank: settings.get('fluid-blank-mode') === 'on',
      enableTransformBlank: settings.get('transform-blank-mode') === 'on',
      enableConfigIntent: settings.get('fluid-config-mode') === 'on',
      enableSentenceCues: settings.get('sentence-cues-mode') === 'on',
      enableWordCues: settings.get('word-cues-mode') === 'on',
      // applyOpencuesScalar — ConfigIntentSource's side-effect callback.
      //
      // Does TWO things, matching the pair that satellite cycling
      // always does together (cycling.ts:cycleSelectorSatellite):
      //   1. ConfigLoader.applyOpenCuesScalar — updates in-memory
      //      state + arms 2.5s reload suppression.
      //   2. invokeOrSpawn opencues blank with `set <setting> <value>`
      //      — actually writes the file. Without this the in-memory
      //      flip reverts the next time reload-suppression expires and
      //      ConfigLoader reads the un-modified file (caught 2026-05-19
      //      via the agentic harness — `turn on voice mode _` showed
      //      `voice-mode active` for ~2.5s then snapped back to
      //      inactive). Cycling's path always pairs the in-memory
      //      update with a `set` invocation; ConfigIntent was missing
      //      the second half.
      applyOpencuesScalar: (setting: string, value: string) => {
        this.configLoader.applyOpenCuesScalar(setting, value);
        // Fire-and-forget the file write via the opencues blank's
        // script. Looked up at call time so a missing blank entry
        // (degraded install) degrades gracefully — the in-memory
        // flip still takes effect, just with no persistence.
        const oc = this.configLoader.lookupBlank('opencues');
        const scriptPath = oc?.blank.blankScript;
        if (!scriptPath && !this.adapter.blankInvoke) return;
        try {
          const native = this.adapter.blankInvoke?.({
            blankName: 'opencues',
            action: 'set',
            args: [setting, value],
            timeoutMs: 4000,
          });
          if (native) return;
          if (!scriptPath) return;
          if (!this.adapter.capabilities.includes('spawn-process')) return;
          this.adapter.spawnProcess({
            command: 'bash',
            args: [scriptPath, 'set', setting, value],
            detached: true,
            timeoutMs: 4000,
          });
        } catch (err) {
          this.adapter.log('error', `ConfigIntent: file write failed for ${setting}=${value}`, err);
        }
      },
      // Debug log sink — surfaces TransformBlankSource pipeline traces
      // when OPENCUES.md `debug-mode: on`. The adapter.log gates 'debug'
      // level via isDebugEnabled (set up in boot-common.ts), so off-mode
      // users get no log spam.
      log: (msg: string) => this.adapter.log('debug', msg),
      // Info-level companion for FluidBlankSource's user-visible
      // lines (ambient-context decision). Routed at info so chrome's
      // default console shows it without enabling the Verbose filter.
      logInfo: (msg: string) => this.adapter.log('info', msg),
      // Adapt core's typed source events into the runtime's namespaced
      // event stream. Core owns the event names + body shapes; runtime
      // adds the `<source-id>.` prefix when forwarding to
      // adapter.emitEvent. Silent when emitEvent is undefined (no
      // event-bridge subscribed). Each source's event union is
      // imported dynamically because cuesCore is type-erased at the
      // seam (see CuesCoreLike) — the explicit parameter types keep
      // strict-mode happy without re-importing the whole core surface.
      // TransformBlank + FluidBlank lifecycle events go through the
      // event-bridge for runtime consumers (debug-mode visualisers,
      // event-stream taps, etc.). The `started` events ALSO get an
      // info-level log line — they carry the resolved provider/model
      // (and mode, for transform-blank), and surfacing that without
      // requiring "Verbose" console filter is worth the once-per-
      // substitution noise. Per-pass diagnostic logs from the source
      // (e.g. `TransformBlank P1 EXTRACT (...)`) stay at debug level.
      onTransformBlankEvent: (event: import('@opencues/core').TransformBlankEvent) => {
        const { type, ...body } = event;
        if (event.type === 'started') {
          this.adapter.log('info', `TransformBlank: starting (textLen=${event.textLen}, blankIdx=${event.blankIdx}, mode=${event.mode}, llm=${event.llm})`);
        }
        this.adapter.emitEvent?.(`transform-blank.${type}`, body);
      },
      onFluidBlankEvent: (event: import('@opencues/core').FluidBlankEvent) => {
        const { type, ...body } = event;
        if (event.type === 'started') {
          this.adapter.log('info', `FluidBlank: starting (textLen=${event.textLen}, blankIdx=${event.blankIdx}, llm=${event.llm})`);
        }
        this.adapter.emitEvent?.(`fluid-blank.${type}`, body);
      },
      // Universal-Integration profile: when the adapter reports the
      // current focused target has no cycling surface (chrome's normal-
      // `<input>` branch, future read-only contexts), prune every
      // cycleable source + cycleable BlankConfig entry. See
      // build-sources.ts for the full filter contract. Adapters that
      // don't implement supportsCycling default to true — every
      // pre-existing host has cycling.
      supportsCycling: this.adapter.supportsCycling?.() ?? true,
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
   *  changes between resolves (user flipped a flag in `OPENCUES.md` and
   *  ConfigLoader hot-reloaded), rebuild the resolver so the new flag
   *  state takes effect without a host restart. */
  private computeBuildKey(): string {
    const s = this.configLoader.opencuesState.settings;
    return [
      s.get('fluid-blank-mode') ?? '',
      s.get('transform-blank-mode') ?? '',
      s.get('fluid-config-mode') ?? '',
      s.get('sentence-cues-mode') ?? '',
      s.get('word-cues-mode') ?? '',
      s.get('llm-endpoint') ?? '',
      s.get('llm-model') ?? '',
      s.get('llm-provider') ?? '',
      s.get('word-cues-provider') ?? '', s.get('word-cues-model') ?? '', s.get('word-cues-endpoint') ?? '',
      s.get('fluid-blank-provider') ?? '', s.get('fluid-blank-model') ?? '', s.get('fluid-blank-endpoint') ?? '',
      s.get('transform-blank-provider') ?? '', s.get('transform-blank-model') ?? '', s.get('transform-blank-endpoint') ?? '',
      s.get('fluid-config-provider') ?? '', s.get('fluid-config-model') ?? '', s.get('fluid-config-endpoint') ?? '',
      s.get('sentence-cues-provider') ?? '', s.get('sentence-cues-model') ?? '', s.get('sentence-cues-endpoint') ?? '',
      // Universal-Integration: chrome's adapter answers per-current-target.
      // When focus moves between a contenteditable (cycling) and a normal
      // input (no cycling), the build key flips and sources rebuild on
      // the next text-change — pruning/restoring cycleable sources without
      // an explicit reload.
      this.adapter.supportsCycling?.() ?? true ? '1' : '0',
    ].join('|');
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private onTextChange(e: TextChangeEvent): void {
    if (e.source !== 'user') return; // ignore our own setText echoes
    if (!this._resolver) return;

    // If OPENCUES.md flags changed since last build, rebuild before
    // dispatching. ConfigLoader hot-reloads opencuesState on text-change
    // but doesn't notify Resolver, so without this check a flag flip
    // (`fluid-blank-mode: off → on`, `word-cues-mode: off → on`, …)
    // would only take effect on next host restart.
    const currentKey = this.computeBuildKey();
    if (currentKey !== this._lastBuildKey) {
      this.adapter.log('info', `Resolver: OPENCUES.md flags changed — rebuilding sources`);
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
    // Trigger detection — gated by blank-trigger-mode.
    //
    // - `immediate` (default): bypass debounce the instant `_` becomes
    //   the buffer's last non-whitespace char (current behaviour since v0.1).
    // - `spaced`: bypass only when the buffer ends with `_` + at least one
    //   trailing whitespace. Lets users type markdown `_italic_` without
    //   the first `_` immediately substituting; firing waits for the
    //   space that confirms blank intent.
    const triggerMode = this.configLoader.opencuesState.blankTriggerMode;
    let blankJustTyped: boolean;
    if (triggerMode === 'spaced') {
      // Buffer ends with `_` then whitespace, AND the prior text didn't
      // already satisfy that condition (so we don't re-fire on every space).
      blankJustTyped = /_\s+$/.test(text) && !/_\s+$/.test(prev);
    } else {
      blankJustTyped = text.trimEnd().endsWith('_') && !prev.trimEnd().endsWith('_');
    }
    if (blankJustTyped) {
      if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
      this.adapter.log('debug', `Resolver: _ trigger — bypassing debounce (mode=${triggerMode})`);
      void this.resolveAndApply(text);
      return;
    }

    // In spaced mode, an unconfirmed lone `_` at end of buffer should
    // never fire blanks — not via bypass (handled above) AND not via
    // the debounced fall-through (handled here). Skip scheduling so a
    // user pausing after `_` doesn't end up substituted. The next
    // text-change (typing more or the confirming space) re-evaluates.
    if (triggerMode === 'spaced' && text.trimEnd().endsWith('_') && !/_\s+$/.test(text)) {
      if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
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

    // Rich-text view: re-inject any markdown markers MarkdownRender has
    // cached. The LLM sees this when EXTRACT runs and can preserve
    // markers on its rewrite. Without it, asking "make it caps" on a
    // word that's already bold loses the bold — markers don't exist
    // in the visible buffer (stripped at write time).
    //
    // Cache-prefix match is TRAILING-WHITESPACE-TOLERANT: the cached
    // text often carries preserved separators (newlines after a
    // substitution) that the user has since typed over. We compare on
    // the body — everything up to and including the last styled range —
    // and accept the user's new typing as suffix.
    let richText: string | undefined;
    if (this.markdownRender) {
      const cached = this.markdownRender.getCachedPayload();
      if (cached) {
        const allRanges = [
          ...cached.bold, ...cached.italic, ...cached.code,
          ...cached.strike, ...cached.heading, ...cached.list,
        ];
        const bodyEnd = allRanges.length === 0
          ? cached.text.replace(/\s+$/, '').length
          : Math.max(...allRanges.map(r => r.end));
        const cachedBody = cached.text.slice(0, bodyEnd);
        if (text.startsWith(cachedBody)) {
          // Markers index into cached.text — re-inject them into
          // cachedBody (a prefix), then append whatever the user has
          // typed past that point.
          richText = injectMarkdownMarkers(cachedBody, cached) + text.slice(cachedBody.length);
        }
      }
    }

    // Loading animation: start animating every `_` slot before dispatch
    // and stop them all after the pipeline returns (success, error, or
    // empty result). Idempotent: BlankFill may have already started
    // animating a keyword-bound `_`, in which case start() is a no-op.
    // stop() restores each slot to `_` so the substitution path's
    // `target.word === '_'` check still passes.
    const animatedSlots: number[] = [];
    if (this.blankLoading) {
      for (let i = 0; i < cleanWords.length; i++) {
        if (cleanWords[i] === '_') {
          this.blankLoading.start(i);
          animatedSlots.push(i);
        }
      }
    }
    const stopAllAnimations = (): void => {
      if (!this.blankLoading) return;
      for (const i of animatedSlots) this.blankLoading.stop(i);
    };

    // Capture resolve-start so we can surface end-to-end pipeline
    // latency on the substituting log lines below. Useful for
    // diagnosing "why is this slow" without trawling per-pass debug
    // timing from the LLM source.
    const __resolveStart = Date.now();
    let result;
    try {
      result = await this._resolver.resolve({
        text,
        words: cleanWords,
        domain: 'claude-code',
        asTypedText,
        richText,
        // User's caret position. TransformBlank's APPLY pass injects
        // a [CURSOR] sentinel here so the LLM can anchor positional
        // instructions ("insert X here _") at the user's actual
        // position. Sources that don't care about cursor (FluidBlank,
        // RoutedWordSourceGroup) ignore it. -1 means "no info".
        cursor: this.adapter.getCursorOffset?.() ?? -1,
        // Optional ambient field/page context. Gated FIRST by the
        // `ambient-context-mode` scalar (off by default) — when off,
        // the host adapter is not even consulted, so a misbehaving
        // host can't accidentally leak metadata.
        //
        // When on: ask the host. The host still returns null when it
        // can't gather (e.g. CC/OC native hosts have no DOM) OR when
        // the focused field is sensitive (password/CC/OTP).
        //
        // Only FluidBlankSource consumes this — see AmbientContext
        // for the full security contract. The runtime is intentionally
        // not plugged into any tool-handling or exec layer for fluid-
        // blank prompts, so the ambient block can only land in text
        // the user sees before submitting.
        ambient: this.configLoader.opencuesState.ambientContextMode === 'on'
          ? (this.adapter.getAmbientContext?.() ?? undefined)
          : undefined,
        // Optional user-context (sentinel-mode personal data). Gated by
        // `user-context-mode` in OPENCUES.md (`off` by default — when
        // `off` we don't even forward the parsed catalog, so a future
        // misconfigured source can't accidentally read it). When on,
        // ship the catalog + mode through to FluidBlankSource; no
        // other source consumes this field today by design.
        userContext: this.configLoader.opencuesState.userContextMode !== 'off'
          ? {
              fields: this.configLoader.userContext.fields,
              catalog: this.configLoader.userContext.catalog,
              mode: this.configLoader.opencuesState.userContextMode,
            }
          : undefined,
      });
    } catch (err) {
      stopAllAnimations();
      this.adapter.log('error', 'Resolver.resolve threw', err);
      return;
    }
    stopAllAnimations();

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
    // Sentence-cue suppression state. When any `sentence-cue:*` result
    // applies, subsequent word-cue results whose wordIndex falls within
    // the applied sentence's word range get suppressed (design rule:
    // sentence wins outright). v1 also caps at ONE sentence-cue per
    // resolve to avoid the word-index shift cascading when multiple
    // sentences splice in the same pass (each splice changes downstream
    // word offsets; subsequent sentence-cue results carry the
    // pre-splice spanStart and would splice at the wrong location).
    // Multi-sentence-cue handling is a v2 followup (process in reverse
    // span-order, or apply via a single batched splice).
    let sentenceCueApplied = false;
    let sentenceClaimWordStart = -1;
    let sentenceClaimWordEnd = -1;
    for (const r of result.results) {
      const isSentenceCue = typeof r.source === 'string' && r.source.startsWith('sentence-cue:');
      // ── Suppression check: word-cue (or any non-LLM-blank result)
      //    inside an applied sentence's word range is dropped.
      const isLlmBlank = r.source === 'fluid-blank' || r.source === 'transform-blank' || r.source === 'config-intent';
      if (sentenceCueApplied && !isSentenceCue && !isLlmBlank) {
        if (r.wordIndex >= sentenceClaimWordStart && r.wordIndex <= sentenceClaimWordEnd) {
          this.adapter.log('debug', `Resolver: suppressing word-cue at wordIndex=${r.wordIndex} — inside sentence-cue span [${sentenceClaimWordStart},${sentenceClaimWordEnd}]`);
          continue;
        }
      }
      // v1: only the first sentence-cue per resolve applies (see comment above).
      if (isSentenceCue && sentenceCueApplied) {
        this.adapter.log('debug', `Resolver: skipping additional sentence-cue at wordIndex=${r.wordIndex} — v1 caps at one per resolve`);
        continue;
      }
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
      // (the hand-curated `alts` array under CUES.md's `## Tips` JSON
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
      // ConfigIntent emits the same FluidBlank-style shape
      // (alternatives = ['_', confirmation]) — splice the
      // confirmation in at the `_`, register a DynDef for
      // cycling-Down revert. blankName below differs so the def
      // isn't re-resolved as a fluid-blank lookup.
      const isConfigIntent = r.source === 'config-intent';
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
        // Splice the answer into [start, end) — the canonical
        // FluidBlank shape. applyMarkdownAwareSplice handles strip +
        // write + markdown.styled emit with ranges shifted into
        // final-buffer coords. Same primitive TransformBlank uses
        // below; the only difference is which range we hand it.
        const end = isMultiWordSpan ? r.spanEnd! : target.end;
        const sub = applyMarkdownAwareSplice(this.adapter, text, start, end, alts[0]);
        const newText = sub.newText;
        const answer = sub.stripped;

        // Find which word in the new text the answer sits at.
        const newWords = splitWords(newText);
        const newWord = newWords.find(w => w.start === start);
        const newWordIndex = newWord ? newWord.index : r.wordIndex;
        const newSpanEnd = newWord ? newWord.end : sub.newCursor;

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

        this.adapter.log('info', `FluidBlank: substituting "${text.slice(start, end)}" → "${answer}" (mode=${isMultiWordSpan ? 'WIPE' : 'FILL'}, range=[${start},${end}), defAt=${newWordIndex}, totalMs=${Date.now() - __resolveStart})`);
        continue; // skip the generic def-creation below
      }

      // ConfigIntent: emits a selector-satellite-shaped result.
      // alternatives=[<setting>], metadata.selectorBlank=true,
      // metadata.satelliteValue=<value>, metadata.displaySeparator,
      // metadata.blankName='opencues', spanStart/spanEnd cover the
      // user's full summon-words + `_` range to wipe. Splice
      // "<setting><sep><value>" into [spanStart, spanEnd) and register
      // a SelectorSatelliteEntry so standard cycling works on it
      // (mirrors the wiring BlankFill does for keyword-bound
      // `opencues settings _`).
      if (isConfigIntent && alts.length > 0 && isMultiWordSpan) {
        const liveText = this.adapter.getText();
        // Race guard: bail if the `_` we classified against is no
        // longer in the live buffer. ConfigIntent's wipe is more
        // aggressive than FluidBlank's localized splice (we wipe
        // [0, text.length)), so any sign the user moved past or
        // typed away from the original prompt should abort —
        // otherwise unrelated edits silently get destroyed.
        if (!liveText.includes('_')) {
          this.adapter.log('info', `ConfigIntent: skipping — _ no longer in live text (len=${liveText.length})`);
          continue;
        }
        // Stricter check: the range we're about to wipe must still
        // match the analyzed text byte-for-byte. If the user typed in
        // the prefix, we'd otherwise wipe their edit.
        if (liveText.slice(r.spanStart!, r.spanEnd!) !== text.slice(r.spanStart!, r.spanEnd!)) {
          this.adapter.log('info', `ConfigIntent: skipping — wipe range no longer matches analyzed text`);
          continue;
        }
        const selector = alts[0];
        const meta = r.metadata as Record<string, unknown> | undefined;
        const satellite = String(meta?.satelliteValue ?? '');
        const sep = String(meta?.displaySeparator ?? ' ');
        const blankName = String(meta?.blankName ?? 'opencues');
        if (!satellite) {
          this.adapter.log('info', 'ConfigIntent: skipping — metadata.satelliteValue missing');
          continue;
        }
        const start = r.spanStart!;
        const end = r.spanEnd!;
        const pair = `${selector}${sep}${satellite}`;
        const newText = liveText.slice(0, start) + pair + liveText.slice(end);
        const newCursor = start + pair.length;
        if (this.adapter.pushText) {
          this.adapter.pushText(newText, newCursor);
        } else {
          this.adapter.setText(newText);
          this.adapter.setCursorOffset(newCursor);
          this.adapter.forceRender();
        }

        // Register the satellite-cycling state so cycling Up/Down at
        // either word triggers applyOpenCuesScalar via the existing
        // path (cycling.ts:cycleSelectorSatellite). Same shape that
        // BlankFill.applySatelliteFill builds.
        if (this.selectorSatelliteState) {
          const newWords = splitWords(newText);
          const selStartWord = newWords.find(w => w.start === start);
          if (selStartWord) {
            const selectorLength = Math.max(1, selector.split(/\s+/).filter(Boolean).length);
            const satelliteLength = Math.max(1, satellite.split(/\s+/).filter(Boolean).length);
            this.selectorSatelliteState.set({
              blankName,
              scriptPath: '',
              selectorIndex: selStartWord.index,
              selectorLength,
              satelliteIndex: selStartWord.index + selectorLength,
              satelliteLength,
              currentSetting: selector,
              currentValue: satellite,
              separator: sep,
              // clearOnEdit: true — backspacing into either word wipes
              // the whole pair in one go via applyClearOnEdit. The
              // user typed a natural-language summon ("enable debug
              // logging _"); the satellite pair is just the
              // visual confirmation of the resulting state, so it
              // should behave as a single span on cleanup (not as two
              // independent words requiring per-char backspace).
              clearOnEdit: true,
              pairCharStart: start,
              pairCharEnd: start + pair.length,
            }, newText);
          }
        }

        wrote++;
        this.adapter.log('info', `ConfigIntent: substituting "${text.slice(start, end)}" → "${pair}" (range=[${start},${end}), totalMs=${Date.now() - __resolveStart})`);
        continue;
      }

      // Sentence-cue: scope:'sentence' cue from CUES.md / CUE.md.
      // Source returns:
      //   alternatives = [originalSentence, rewrite1, rewrite2, ...]
      //   spanStart/spanEnd = char range of the sentence in the buffer
      //
      // Behaves as a PASSIVE cue (like word-cues, just at sentence span
      // granularity): the original sentence stays in the buffer, a
      // DynDef is registered at currentIndex=0 so the existing cycling
      // path (Ctrl+Alt+Up) swaps in alts[1+] on user keystroke. The
      // sentence's word range is "claimed" so subsequent word-cue
      // results inside it are suppressed (design 4a — sentence wins).
      //
      // Earlier versions auto-spliced alts[1] the moment the LLM
      // returned (TransformBlank-style). That was agent-like — the
      // user's prose was rewritten in the background without any
      // keystroke. Sentence-cues are CUES, not agents; the user must
      // explicitly cycle to apply.
      if (isSentenceCue && r.alternatives.length >= 2 && isMultiWordSpan) {
        const originalSentence = r.alternatives[0];
        const liveText = this.adapter.getText();
        const start = r.spanStart!;
        const end = r.spanEnd!;
        // Race guard: the sentence span we're about to claim must still
        // match what we analyzed. If the user typed elsewhere or edited
        // this sentence, abandon — the cue would point at stale chars.
        if (liveText.slice(start, end) !== originalSentence) {
          this.adapter.log('info', `SentenceCue[${r.source}]: skipping — buffer edit at [${start},${end}) changed the sentence since resolve`);
          continue;
        }
        // Managed-span overlap guard. SentenceCueSource segments the
        // WHOLE buffer regardless of any active selector/satellite pair
        // or other span-bound DynDef (fluid-blank substitute, transform
        // rewrite). A sentence-cue cycling Up across one of those would
        // mid-overwrite the span — refuse to register the def at all if
        // there's overlap.
        const sat = this.selectorSatelliteState?.current;
        const overlapsSatellite = sat ? (start < sat.pairCharEnd && sat.pairCharStart < end) : false;
        let overlapsDynDef = false;
        for (const [idx, def] of this.dynDefs.entries()) {
          if (!def.blankName) continue;
          if (typeof def.spanStart !== 'number' || typeof def.spanEnd !== 'number') continue;
          if (def.spanEnd <= def.spanStart) continue;
          if (idx === r.wordIndex && typeof def.blankName === 'string' && def.blankName.startsWith('sentence-cue:')) continue; // refreshing our own def is fine
          if (start < def.spanEnd && def.spanStart < end) { overlapsDynDef = true; break; }
        }
        if (overlapsSatellite || overlapsDynDef) {
          this.adapter.log('info', `SentenceCue[${r.source}]: skipping — sentence span [${start},${end}) overlaps an active managed span (satellite=${overlapsSatellite}, dyndef=${overlapsDynDef})`);
          continue;
        }

        // Register the DynDef passively. No splice; the buffer keeps
        // the original sentence. alts[0] === originalSentence so cycling
        // Up to currentIndex=1 swaps in the first rewrite via the
        // existing applyAltCycle path.
        this.dynDefs.set(r.wordIndex, {
          originalWord: originalSentence,
          alternatives: r.alternatives, // [original, ...rewrites]
          currentIndex: 0, // passive — buffer shows alts[0] (the original)
          spanStart: start,
          spanEnd: end,
          // blankName uses the source id (sentence-cue:<name>) so the
          // entry is locked against re-resolution AND distinguishable
          // from other span-bearing defs in logs / event traces.
          blankName: r.source,
        });
        wrote++;

        // Record claim for downstream word-cue suppression. Uses the
        // ORIGINAL word indices (the result list is in original-buffer
        // coords since we didn't splice).
        sentenceClaimWordStart = r.wordIndex;
        sentenceClaimWordEnd = r.wordIndex + originalSentence.split(/\s+/).filter(Boolean).length - 1;
        sentenceCueApplied = true;

        this.adapter.log('info', `SentenceCue[${r.source}]: cue ready [${start},${end}) "${originalSentence.slice(0, 50)}…" (alts=${r.alternatives.length - 1}, defAt=${r.wordIndex}, claimWords=[${sentenceClaimWordStart},${sentenceClaimWordEnd}])`);
        continue;
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

        // Compute the surgical splice range: find the TARGET in
        // originalText (the body the LLM rewrote) and the TRIGGER (the
        // instruction phrase + `_`). The splice replaces a contiguous
        // range and preserves everything outside.
        //
        // Three layouts:
        //   1. Target contiguous BEFORE trigger or AFTER trigger:
        //        [ prefix ][ target ][ sep ][ instr _ ][ trail ]
        //        Splice = [target_start, trigger_end), separator folded
        //        into rewrite so trail survives via slice(end).
        //
        //   2. Target SANDWICHED around trigger (EXTRACT emits the
        //      two halves joined by "\n"):
        //        [ pt1 ][ sep ][ instr _ ][ sep ][ pt2 ]
        //        Splice = [pt1_start, pt2_end), rewrite replaces the
        //        ENTIRE composite span.
        //
        //   3. Target not found at all (LLM reworded it heavily):
        //        Whole-body replace fallback.
        // transformTarget may contain markdown markers when EXTRACT
        // ran against the rich-text view (re-injected markers from
        // MarkdownRender's cache). Strip them before locating the
        // target in originalText (the unmarked visible buffer) —
        // otherwise indexOf finds nothing and we drop to whole-body
        // fallback even on a clean target match.
        const transformTargetRaw = r.metadata?.transformTarget as string | undefined;
        const transformTarget = transformTargetRaw !== undefined
          ? stripMarkdownMarkers(transformTargetRaw)
          : undefined;
        const transformInstruction = r.metadata?.transformInstruction as string | undefined;
        let spliceStart = 0;
        let spliceEnd = originalText.length;
        let rewriteWithSeparator = rewrittenText;
        if (transformTarget && transformTarget.length > 0) {
          const targetIdx = originalText.indexOf(transformTarget);
          if (targetIdx >= 0) {
            // Locate the trigger phrase (instruction + `_`) too. The
            // splice must cover BOTH target and trigger; everything
            // else is preservedPrefix/trailing.
            const targetEnd = targetIdx + transformTarget.length;
            const trigger = locateTrigger(originalText, transformInstruction, targetIdx, targetEnd);
            if (trigger) {
              // Span from earliest-of(target, trigger) → latest-of(target, trigger).
              spliceStart = Math.min(targetIdx, trigger.start);
              spliceEnd = Math.max(targetEnd, trigger.end);
              // Separator = anything between target and trigger that
              // wasn't part of either. Preserve newlines; drop spaces
              // (a space between target and trigger is just a word
              // boundary, not user-intended structure).
              const gapStart = Math.min(targetEnd, trigger.end);
              const gapEnd = Math.max(targetIdx, trigger.start);
              const separator = gapStart < gapEnd
                ? originalText.slice(gapStart, gapEnd).replace(/[ \t]+$/, '').replace(/^[ \t]+/, '')
                : '';
              rewriteWithSeparator = rewrittenText + separator;
            } else {
              // Trigger not located via instruction phrase. Conservative
              // fallback: splice from target onward, preserving leading
              // whitespace as separator. Splice covers target end → EOL.
              spliceStart = targetIdx;
              const remainder = originalText.slice(targetEnd);
              const separator = (remainder.match(/^\s*/)?.[0] ?? '').replace(/[ \t]+$/, '');
              spliceEnd = originalText.length;
              rewriteWithSeparator = rewrittenText + separator;
            }
          } else {
            // Sandwiched target — EXTRACT joined two halves with "\n"
            // but in originalText they're separated by the trigger
            // phrase. We replace ONLY the trigger phrase with "" and
            // each half with its modified rewrite — surrounding
            // structural whitespace (paragraph breaks) is preserved
            // exactly, including the now-empty trigger LINE itself.
            // Compose the final buffer here and splice it as one
            // [pt1Start, pt2End) operation.
            const sandwich = findSandwichedTarget(originalText, transformTarget, transformInstruction);
            if (sandwich) {
              spliceStart = sandwich.pt1Start;
              spliceEnd = sandwich.pt2End;
              // Split the LLM rewrite on its first `\n` — EXTRACT
              // joined pt1+pt2 with a single newline, APPLY preserves
              // that join. Falls back to "whole rewrite is pt1, pt2
              // unchanged" when the rewrite has no \n.
              const rewriteSplitIdx = rewrittenText.indexOf('\n');
              const pt1Mod = rewriteSplitIdx >= 0
                ? rewrittenText.slice(0, rewriteSplitIdx)
                : rewrittenText;
              const pt2Mod = rewriteSplitIdx >= 0
                ? rewrittenText.slice(rewriteSplitIdx + 1)
                : originalText.slice(sandwich.pt2Start, sandwich.pt2End);
              const sepBeforeTrigger = originalText.slice(sandwich.pt1End, sandwich.triggerStart);
              const sepAfterTrigger = originalText.slice(sandwich.triggerEnd, sandwich.pt2Start);
              // Compose: pt1_mod + sep_before + (trigger consumed: empty) + sep_after + pt2_mod.
              // The trigger LINE remains structurally — its surrounding
              // whitespace is intact and its text is just empty now.
              rewriteWithSeparator = pt1Mod + sepBeforeTrigger + sepAfterTrigger + pt2Mod;
            }
            // else: fall through to whole-body replace.
          }
        }

        // Cursor lands at the END OF THE FULL NEW BUFFER. The user
        // was typing past the trigger (after `_`), past any preserved
        // separator (\n\n) between target and trigger. A targeted
        // modification shouldn't yank the caret BACKWARDS across that
        // preserved structure — they intentionally typed past it.
        // End-of-buffer keeps continuity with where they were.
        //
        // Implementation: pass a huge cursor; the helper clamps to
        // newText.length internally. Saves recomputing newText.length
        // here.
        const sub = applyMarkdownAwareSplice(
          this.adapter, originalText, spliceStart, spliceEnd, rewriteWithSeparator,
          { cursor: Number.MAX_SAFE_INTEGER },
        );
        const bufferText = sub.newText;

        // Find which word the rewrite's first word lands at in the new
        // text (for keying the def). Defaults to wherever the splice
        // inserted (spliceStart), which becomes the first word position
        // in the post-substitution text.
        const newWords = splitWords(bufferText);
        const firstSpliceWord = newWords.find(w => w.start >= spliceStart);
        const newWordIndex = firstSpliceWord ? firstSpliceWord.index : 0;
        const newSpanEnd = newWords.length > 0 ? newWords[newWords.length - 1].end : bufferText.length;

        const transformDef: WordDef = {
          originalWord: originalText,
          // alternatives[0] = original full text (cycle Down to revert)
          // alternatives[1] = the post-substitution buffer (cycle Up returns here)
          alternatives: [originalText, bufferText],
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
        const rewritePreview = bufferText.length > previewLen ? bufferText.slice(0, previewLen) + '…' : bufferText;
        const markerNote = sub.hadMarkdown ? ', markdown stripped' : '';
        this.adapter.log('info', `TransformBlank: substituting "${origPreview}" → "${rewritePreview}" (origLen=${originalText.length}, rewriteLen=${bufferText.length}${markerNote}, defAt=${newWordIndex}, totalMs=${Date.now() - __resolveStart})`);
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

/** Strip inline markdown markers from a string. Mirrors a subset of
 *  the markdown-strip module; kept local so callers don't have to
 *  invoke the full Range-returning version when they just want the
 *  plain text (e.g. for indexOf lookups). */
function stripMarkdownMarkers(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * Re-insert markdown markers into `plain` at the positions described
 * by `cached`. Used to feed the LLM a "rich-text" view of the buffer
 * so it can preserve existing styling across transforms. Inverse of
 * the stripMarkdown step that runs at write time.
 *
 * Insertion is order-preserving: we walk the bounded list of
 * insertions sorted by visible offset, walking the plain text once.
 */
function injectMarkdownMarkers(
  plain: string,
  cached: {
    bold: ReadonlyArray<{ start: number; end: number }>;
    italic: ReadonlyArray<{ start: number; end: number }>;
    code: ReadonlyArray<{ start: number; end: number }>;
    strike: ReadonlyArray<{ start: number; end: number }>;
    heading: ReadonlyArray<{ start: number; end: number }>;
    list: ReadonlyArray<{ start: number; end: number }>;
  },
): string {
  type Ins = { at: number; mark: string; order: number };
  const inserts: Ins[] = [];
  const add = (rs: ReadonlyArray<{ start: number; end: number }>, open: string, close: string): void => {
    for (const r of rs) {
      inserts.push({ at: r.start, mark: open, order: 0 });
      inserts.push({ at: r.end, mark: close, order: 1 });
    }
  };
  add(cached.bold, '**', '**');
  add(cached.italic, '*', '*');
  add(cached.code, '`', '`');
  add(cached.strike, '~~', '~~');
  // heading + list are line-level and rarely round-trip through this
  // path (LLM rewrites usually preserve them as text shape), but pin
  // them too so we don't regress: heading prefixes the line with `# `,
  // list prefixes each item with `- `. Implemented as just open markers
  // (no close).
  for (const r of cached.heading) inserts.push({ at: r.start, mark: '# ', order: 0 });
  for (const r of cached.list) inserts.push({ at: r.start, mark: '- ', order: 0 });
  if (inserts.length === 0) return plain;
  inserts.sort((a, b) => a.at - b.at || a.order - b.order);
  let out = '';
  let cursor = 0;
  for (const ins of inserts) {
    if (ins.at > cursor) out += plain.slice(cursor, ins.at);
    out += ins.mark;
    cursor = ins.at;
  }
  if (cursor < plain.length) out += plain.slice(cursor);
  return out;
}

/**
 * Locate the trigger phrase (instruction text + `_`) in `originalText`.
 * The trigger may sit BEFORE the target (layout: instruction first) or
 * AFTER it (layout: instruction trailing). We pick the trigger nearest
 * the target to handle the case where the instruction phrase
 * coincidentally appears inside the target itself (e.g. APPLY's
 * "make wilfred bold" instruction matches a phrase in a long paragraph).
 *
 * Returns the inclusive [start, end) span of the trigger phrase, or
 * null when we can't find it (e.g. instruction phrase missing /
 * trailing `_` not where we expect).
 */
function locateTrigger(
  originalText: string,
  instruction: string | undefined,
  targetIdx: number,
  targetEnd: number,
): { start: number; end: number } | null {
  if (!instruction || instruction.length === 0) return null;
  // Search BOTH sides of the target. Prefer the side where the
  // instruction phrase appears AND a `_` follows immediately (modulo
  // whitespace).
  const sides: Array<{ from: number; end: number }> = [
    { from: targetEnd, end: originalText.length },     // after target
    { from: 0, end: targetIdx },                        // before target
  ];
  for (const side of sides) {
    const region = originalText.slice(side.from, side.end);
    const idx = region.indexOf(instruction);
    if (idx < 0) continue;
    const instrEndInRegion = idx + instruction.length;
    // Find next `_` after the instruction phrase in this region.
    const underscoreInRegion = region.indexOf('_', instrEndInRegion);
    if (underscoreInRegion < 0) continue;
    return {
      start: side.from + idx,
      end: side.from + underscoreInRegion + 1,
    };
  }
  return null;
}

/**
 * Locate a sandwiched target — two halves joined by "\n" in EXTRACT's
 * output, but in originalText separated by the trigger phrase. Returns
 * the [pt1Start, pt2End) span the splice should replace, or null when
 * the pattern doesn't fit.
 *
 * Splitting on the FIRST newline keeps the two halves recoverable
 * (multi-line halves are uncommon in practice and a trade-off for the
 * sandwich path).
 */
interface SandwichLayout {
  pt1Start: number;
  pt1End: number;
  triggerStart: number;     // start of instruction phrase
  triggerEnd: number;       // position just after the `_`
  pt2Start: number;
  pt2End: number;
}

function findSandwichedTarget(
  originalText: string,
  target: string,
  instruction: string | undefined,
): SandwichLayout | null {
  if (!instruction) return null;
  const splitIdx = target.indexOf('\n');
  if (splitIdx < 0) return null;     // EXTRACT didn't emit a sandwich
  const pt1 = target.slice(0, splitIdx);
  const pt2 = target.slice(splitIdx + 1);
  if (pt1.length === 0 || pt2.length === 0) return null;
  const pt1Idx = originalText.indexOf(pt1);
  if (pt1Idx < 0) return null;
  const pt1End = pt1Idx + pt1.length;
  // The instruction phrase + `_` MUST sit between pt1 and pt2.
  const instrInBetween = originalText.indexOf(instruction, pt1End);
  if (instrInBetween < 0) return null;
  const triggerEnd = originalText.indexOf('_', instrInBetween + instruction.length);
  if (triggerEnd < 0) return null;
  const pt2Idx = originalText.indexOf(pt2, triggerEnd + 1);
  if (pt2Idx < 0) return null;
  return {
    pt1Start: pt1Idx,
    pt1End,
    triggerStart: instrInBetween,
    triggerEnd: triggerEnd + 1,    // exclusive: just past the `_`
    pt2Start: pt2Idx,
    pt2End: pt2Idx + pt2.length,
  };
}

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
