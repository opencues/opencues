// Resolver â debounced LLM-backed cycle population.
//
// Subscribes onTextChange (user-source only). After a quiet period
// (debounceMs, default 500), builds a CueContext from the current text
// and calls opencues-core's resolver with merged sources from cuesConfig +
// blanksConfig. Resolved results populate DynDefs so Cycling can rotate
// LLM-suggested alternatives on Ctrl+Alt+Up/Down.
//
// In-flight cancellation: a generation counter is bumped on every
// scheduleResolve. Resolved batches whose generation no longer matches
// the latest are dropped â prevents stale alts overwriting newer state.
//
// User mid-cycle protection: if a DynDef entry has currentIndex > 0
// (user has cycled past the original), the resolver leaves it alone.

import type { HostAdapter, KeyEvent, TextChangeEvent, Unsubscribe } from '../adapter';
import type { ConfigLoader } from './config-loader';
import type { DynDefs, WordDef } from '../state/dyn-defs';
import { reconstructAsTyped, reconstructAsTypedWithMap } from '../state/dyn-defs';
import type { HighlightState } from '../state/highlight-state';
import type { SpanFillState } from '../state/span-fill';
import type { AgentTaskState } from '../state/agent-task';
import type { SelectorSatelliteState as SelectorSatelliteStateRef } from '../state/selector-satellite';
import { splitWords } from './navigation';
import type { BlankLoadingAnimator } from './blank-loading';
import { findUnderscoreAtChar } from './blank-fill';
import { applyMarkdownAwareSplice, applyMarkdownAwareSubstitution } from './markdown-substitute';
import { threeWayMerge } from './word-diff';
import { applyScalarAndPersist } from '../util/apply-scalar';
import { diffSplice, fillSplice, type PendingTransaction, type UndoJournal } from '../state/undo-journal';
import { UndoApplier } from './undo';

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
   * Provider override from a host-level UI (chrome popup's Provider
   * dropdown). When set, takes precedence over the `llm-provider:`
   * scalar in OPENCUES.md. Empty / undefined â no override and the
   * settings scalar (or auto-route) wins.
   */
  readonly providerOverride?: string;
  /**
   * Endpoint override from a host-level UI (chrome popup's API URL
   * field). When non-empty, takes precedence over OPENCUES.md's
   * `llm-endpoint:` scalar AND the legacy `endpoint` fallback.
   * Empty / undefined falls through to the settings scalar then the
   * static default. Mirrors providerOverride's role.
   */
  readonly endpointOverride?: string;
  /**
  /**
   * Host-ingested calendar-context snapshot (calendar events). Written on a
   * cadence by the host's background poller (or a fixture); the resolver
   * reads it fresh each pass so a re-ingest propagates without restart —
   * the ingest-on-a-timer model (NOT a network fetch in the keystroke path).
   * Forwarded to fluid-blank only when `calendar-context-mode: on`. Structurally
   * mirrors `@opencues/core`'s CalendarContextSnapshot. Event times are in the
   * clear; titles are `[EVENT N]` tokens hydrated locally.
   */
  readonly calendarContext?: {
    readonly events: ReadonlyArray<{ token: string; title: string; start: string; end: string; allDay?: boolean; location?: string }>;
    readonly catalog: ReadonlyMap<string, string>;
    readonly ingestedAt?: string;
  };
  /**
   * Default-model override from a host-level UI (chrome popup's Model
   * dropdown). When non-empty, takes precedence over OPENCUES.md's
   * `llm-model:` scalar AND the legacy `defaultModel` fallback.
   * Mirrors providerOverride's role.
   */
  readonly modelOverride?: string;
  /**
   * API keys keyed by provider env-var name. Populated by boot from
   * process.env (or settings UI). Lets CUES.md frontmatter pick a
   * non-Groq provider without rebuilding the patch.
   */
  readonly apiKeys?: Readonly<Record<string, string | undefined>>;
  /** Default 500ms â same as v1's auto-submit debounce. */
  readonly debounceMs?: number;
  /** Optional injection seam for tests. When set, runtime uses this instead
   *  of constructing a NodeHttpAdapter. Should expose at least .post(). */
  readonly httpAdapter?: unknown;
  /** Same â inject the resolver build directly (mostly for testing). */
  readonly resolverFactory?: (cuesConfig: unknown, blanksConfig: unknown, opts: unknown) => unknown;
  /**
   * Host-specific in-buffer message shown when no LLM source could be
   * wired (no working API keys). Chrome passes "open the extension
   * popup", native hosts (CC/OC) mention `~/.cues/.env`. Omit to keep
   * the silent-no-op (e.g. when the host shows the warning elsewhere).
   */
  readonly missingKeyFallbackMessage?: string;
  /**
   * Host-specific formatter for user-actionable LLM call failures
   * (401/404/429/network). Wired into FluidBlankSource so the buffer
   * shows a useful message instead of silent no-op. Host decides the
   * wording (chrome â "open the extension popup", native â "edit
   * ~/.cues/.env"). Omit to keep the silent failure.
   */
  readonly formatLLMErrorAsSubstitute?: (
    reason: 'invalid-api-key' | 'network' | 'rate-limit' | 'endpoint-not-found' | 'model-not-found' | 'insufficient-credits' | 'bad-request',
    err?: Error,
  ) => string;
  /**
   * Word-indices of `_` slots claimed by keyword-bound BlankFill blanks
   * (volume / brightness / weather / stocks-ticker / etc.) for the given
   * text. When every `_` in the buffer is in this set, the resolver
   * skips the `blankContextProvider()` fetch â none of the sources that
   * consume the catalog (FluidBlank, TransformBlank) will fire because
   * they all cede to keyword-bound BlankFill. Wired in `boot-common`
   * from `BlankFill.scan(text)`. Omitting it leaves the catalog fetch
   * unchanged (legacy behaviour). Saves ~5 sequential script/network
   * calls (1+ s) on every `volume _` / `brightness _` / `weather _`.
   */
  readonly keywordBoundSlotIndices?: (text: string) => readonly number[];
  /**
   * Modal-override gate. When this returns true for the incoming text,
   * the resolver skips the entire dispatch (no cue/blank/LLM work) for
   * that change â pending debounce is cancelled too. Wired by boots
   * that mount a modal module (KataCoach today): while a kata
   * is active, tutorial mode overrides all normal cue/blank behaviour,
   * and control phrases (`start kata 1 _`) must never race
   * fluid-blank's `_` fast-path. Omit for normal behaviour.
   */
  readonly externallySuppressed?: (text: string) => boolean;
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
  /** Multi-word span in CHARACTER offsets â set by FluidBlankSource WIPE mode. */
  spanStart?: number;
  spanEnd?: number;
  /** Source id â used to detect fluid-blank for auto-substitute. */
  source?: string;
  /** Source-specific metadata. TransformBlank uses taskAction for agent
   *  task commands (TASK_ARM/ADD/STOP/SHOW). */
  metadata?: Record<string, unknown>;
}

/** Duck-typed view of RoutedWordSourceGroup. We don't import the
 *  class â the runtime treats core sources as opaque â but we do
 *  reach in for the public `classify(word)` helper to surface
 *  per-word routing decisions on `resolver.completed`. The only
 *  shape we care about: `id === 'word-cues'` + `classify(word)
 *  â { id: string } | null`. */
interface RoutedWordSourceGroupLike {
  readonly id: string;
  classify(word: string): { id?: string } | null;
}
/**
 * Build the per-feature LLM-routing block from OPENCUES.md scalars.
 * Each feature reads `<feature>-provider`, `<feature>-model`,
 * `<feature>-endpoint`, `<feature>-max-tokens`, `<feature>-temperature`
 * and surfaces them as a FeatureLLMSetting that build-sources.ts
 * threads into the source class. Source-class defaults still hold
 * when a scalar is absent.
 */
function featureLLM(settings: { get(k: string): string | undefined }, prefix: string): {
  provider?: string; model?: string; endpoint?: string;
  maxTokens?: number; temperature?: number;
} {
  const maxStr = settings.get(`${prefix}-max-tokens`);
  const tempStr = settings.get(`${prefix}-temperature`);
  const maxN = maxStr !== undefined ? parseInt(maxStr, 10) : NaN;
  const tempN = tempStr !== undefined ? parseFloat(tempStr) : NaN;
  return {
    provider: settings.get(`${prefix}-provider`),
    model: settings.get(`${prefix}-model`),
    endpoint: settings.get(`${prefix}-endpoint`),
    maxTokens: Number.isFinite(maxN) && maxN > 0 ? maxN : undefined,
    temperature: Number.isFinite(tempN) && tempN >= 0 && tempN <= 2 ? tempN : undefined,
  };
}

/**
 * Translate a `*-llm-model` scalar's raw value into a model id or
 * undefined. The literal `default` (used as the first cycleable
 * value in the `*-llm-model` FEATURES entries) means "fall through
 * to the provider's defaultModel" â semantically identical to the
 * scalar being absent. Keeping `default` as an explicit value (rather
 * than deleting the line from OPENCUES.md) lets the cycling menu
 * express "reset to provider default" without a delete-scalar code
 * path.
 */
function normalizeModelScalar(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  const lc = t.toLowerCase();
  // `inherit` accepted alongside `default` (July 2026): doctor already
  // read a hand-written `*-llm-model: inherit` as fall-through while
  // this path shipped the literal string as a model name — keep the
  // sentinel set identical to core's normalizeModelScalar
  // (effective-routing.ts), which is the canonical definition.
  if (t === '' || lc === 'default' || lc === 'inherit') return undefined;
  return t;
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

function isRoutedWordGroup(s: unknown): s is RoutedWordSourceGroupLike {
  return !!s
    && typeof s === 'object'
    && (s as { id?: unknown }).id === 'word-cues'
    && typeof (s as { classify?: unknown }).classify === 'function';
}

/** True when no `_` slot will be available to a catalog-consuming source.
 *  Two cases collapse: (1) buffer has no `_` at all â neither FluidBlank
 *  nor TransformBlank fires (both need `_`); (2) every `_` is claimed by
 *  a keyword-bound BlankFill slot â both sources cede in that case. In
 *  either case the per-resolve blank-context provider fetch (N sequential
 *  script/network calls) is pure waste. */
function noBlankContextConsumer(
  cleanWords: readonly string[],
  claimed: readonly number[],
): boolean {
  const claimedSet = new Set(claimed);
  let sawBlank = false;
  for (let i = 0; i < cleanWords.length; i++) {
    if (cleanWords[i] !== '_') continue;
    sawBlank = true;
    if (!claimedSet.has(i)) return false;  // free `_` â fluid/transform may consume
  }
  // Either no `_` at all, or every `_` was keyword-bound â either way no
  // catalog-consuming source will fire.
  return true;
}

/**
 * Synthetic DynDefs key base for sentence-cues that collide on a whitespace
 * word (spaceless CJK: two `ã`-separated sentences share one word). The
 * word-keyed DynDefs map can't hold two cues at the natural index, so the
 * later sentence registers at `BASE + spanStart` â far out of the real
 * word-index range (a buffer would need 2M+ chars to reach it), unique per
 * sentence, and stable across re-resolves. Synthetic-keyed defs are invisible
 * to the word-iterating consumers (dim word-loop, navigation), so DimRender
 * runs a dedicated sentence-cue pass and Cycling resolves by cursor char
 * position; see `DynDefs.sentenceCueDefs()`.
 */
export const SENTENCE_CUE_SYNTHETIC_KEY_BASE = 2_000_000;

export class Resolver {
  private _resolver: { resolve(ctx: unknown): Promise<{ results: CueResultLike[] }> } | null = null;
  private _sources: unknown[] = [];
  private _httpAdapter: unknown = null;
  private _unsubText: Unsubscribe | null = null;
  private _unsubKey: Unsubscribe | null = null;
  /** One-shot flag: set TRUE when a plain `_` keystroke arrives, cleared
   *  at the END of the next `onTextChange`. Gates blank activation on
   *  EXPLICIT user intent â a `_` that appears in the buffer without a
   *  corresponding keystroke (paste, programmatic setText, cursor-
   *  relocation exposing an attached `_`, e.g. typing `monologue_` then
   *  splitting to `monologue _`) MUST NOT fire FluidBlank /
   *  TransformBlank / ConfigIntent.
   *
   *  Why one-shot (not a time window): a 1500ms timestamp window leaves a
   *  hole for fast cursor-splits â type `monologue_`, move cursor and
   *  press space in <1500ms, and the gate still reads "fresh". One-shot
   *  ties freshness to the SPECIFIC onTextChange that paired with the
   *  keystroke; the cursor-split's onTextChange happens AFTER the flag
   *  has been consumed and cleared. The falls-through `scheduleResolve`
   *  captures the flag at change time, so the debounce can't open a hole. */
  private _underscoreKeyArmed = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _generation = 0;
  /** AbortController for the currently in-flight `resolveAndApply`. Each
   *  resolveAndApply call creates a fresh controller; when a NEWER call
   *  fires and bumps `_generation`, we abort the prior controller so
   *  every in-flight LLM call (transform-blank EXTRACT, fluid-blank
   *  FUSED, etc.) is cancelled mid-flight rather than running to
   *  completion just to have its result dropped on generation
   *  mismatch. Drops provider $$$ + rate-limit pressure during
   *  fast typing. Null between resolves. */
  private _inFlightController: AbortController | null = null;
  /** Last user-typed text â used to detect when `_` was just added so we
   *  can bypass the debounce and fire fluid-blank resolution immediately. */
  private _lastInputText = '';
  /** Timestamp of the most recent TASK_STOP dispatch. Used to suppress
   *  TASK_ARM verdicts that arrive shortly after a stop â they're almost
   *  certainly stale in-flight TransformBlank responses (the LLM call was
   *  issued when the task was armed, returned after the user disarmed).
   *  Without this guard, the stale ARM re-arms the task and the agent
   *  starts rewriting subsequent text â observed in scenarios that run
   *  AFTER agent-rewrite tests inadvertently see their buffer rewritten.
   *  Window: 3s â covers typical LLM round-trip (cerebras ~300ms,
   *  generous slack). A user who intentionally re-arms an identical
   *  prompt within 3s of stopping is the only false-positive case;
   *  acceptable trade for blocking the silent task leak. */
  private _lastTaskStopAt = 0;
  /** Prompt of the task that was last stopped â paired with
   *  _lastTaskStopAt to make the stale-arm guard PRECISE. A TASK_ARM
   *  within the stale window whose prompt MATCHES the just-stopped
   *  task's prompt is the in-flight LLM response we want to drop. A
   *  TASK_ARM with a DIFFERENT prompt is a fresh user action and
   *  must be allowed. Pre-prompt-comparison the guard was too
   *  aggressive â back-to-back agent-rewrite scenarios with a fast
   *  provider (claude-cli) would drop the second scenario's ARM. */
  private _lastTaskStopPrompt = '';

  /** Snapshot of the opt-in settings the resolver was last built with.
   *  Re-computed on every resolve; mismatch â rebuildResolver before
   *  running so `OPENCUES.md` flag flips take effect on the next
   *  keystroke (no host restart required). */
  private _lastBuildKey: string | null = null;

  /** Full state reset â wipes every per-buffer / per-keystroke piece
   *  of internal state so the next resolve runs from a clean slate.
   *  Called by hosts that reuse a single runtime instance across
   *  buffer lifecycle boundaries â chrome's panel close+reopen,
   *  shell's `oc-edit --keep-alive` mode where one Bun process
   *  handles multiple Alt+Shift+â sessions (see
   *  integrations/shell/CLAUDE.md Â§ Per-buffer state reset). Without
   *  this, _lastInputText / _lastBuildKey / in-flight controllers
   *  carry across the boundary and the next session sees stale
   *  state. Also reachable via the event bridge's `reset` command
   *  for off-process drivers. NOT a substitute for dispose â wraps
   *  neither unsubscribe nor source teardown. After resetState() the
   *  resolver is still wired and ready; it just thinks it's brand
   *  new. _httpAdapter + _resolver + _sources are kept because
   *  rebuilding them requires the dispatch context that only the
   *  caller has. */
  resetState(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._inFlightController) {
      try { this._inFlightController.abort(); } catch { /* swallow */ }
      this._inFlightController = null;
    }
    this._underscoreKeyArmed = false;
    this._lastInputText = '';
    this._lastTaskStopAt = 0;
    this._lastTaskStopPrompt = '';
    // Force a full source-rebuild on the next text-change. The CueSource
    // instances (TransformBlankSource, FluidBlankSource, etc.) hold
    // their own per-buffer caches (variant cache, MarkdownRender
    // primings, _rewriteCache, etc.) which we can't reach through
    // module-level reset. Re-instantiating the whole resolver via
    // rebuildResolver gives us fresh source instances with empty
    // caches â at the cost of one extra rebuild on the next resolve.
    // _lastBuildKey=null guarantees the buildKey-equality short-circuit
    // can't skip the rebuild.
    this._lastBuildKey = null;
    // Clear TransformBlankSource's STATIC variant pool. It survives
    // instance rebuilds by design (production wants cache survival
    // across resolver rebuilds on hosts where the resolver re-creates
    // sources on every focused-target flip â e.g. chrome's universal
    // integration). But a full resetState is meant to leave NO stale
    // state behind: a user who reloads OPENCUES.md mid-session (provider
    // change, mode toggle) triggers a source rebuild via resetState,
    // and without this clear the pool keeps returning stale rewrites
    // for the previous provider/model until LRU eviction cycles them
    // out. A keep-alive host crossing a session boundary has the
    // same need â the next session's first identical-buffer trigger
    // shouldn't reuse rewrites the previous session generated.
    // Best-effort import â production reset paths don't import @opencues/core.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { TransformBlankSource } = require('@opencues/core') as { TransformBlankSource?: { resetVariantPoolForTest?: () => void } };
      TransformBlankSource?.resetVariantPoolForTest?.();
    } catch { /* swallow â production paths without core lib still work */ }
    this.adapter.log('info', 'Resolver: resetState â rebuilding sources');
    if (this._resolver) this.rebuildResolver();
    else this.adapter.log('warn', 'Resolver: resetState â _resolver was null, skipping rebuild');
    // _generation is monotonic by design â bumping it just discards
    // any in-flight results without changing semantics on the next
    // resolve. Leave it alone; the controller-abort above is what
    // actually cancels in-flight LLM calls.
  }

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
     *  Optional â when omitted, slots stay static during resolution
     *  (legacy behaviour pre-2026-05-13). */
    private blankLoading?: BlankLoadingAnimator,
    /** Shared MarkdownRender â exposes the last styled-text payload so
     *  the resolver can re-inject markdown markers (`**bold**`,
     *  `*italic*`, etc.) into EXTRACT/APPLY input. Without this, an
     *  LLM rewrite asked to "make it caps" loses any prior bold the
     *  user had on a word â markers were stripped from the buffer at
     *  write time and the LLM never sees them on the next pass.
     *  Optional â when omitted, no rich-text view is built. */
    private markdownRender?: MarkdownStylesProvider,
    /** Shared SelectorSatelliteState â needed by the config-intent
     *  substitution branch to register the same cycling state that
     *  BlankFill registers for the keyword-bound `opencues settings _`
     *  path. Without this, ConfigIntent can paint the satellite shape
     *  but cycling won't act on it. Optional â when omitted, the
     *  config-intent branch falls back to inline paint only (no
     *  cycling). */
    private selectorSatelliteState?: SelectorSatelliteStateRef,
    /** Blank-as-context provider â called at every resolve to produce
     *  the ambient-blank snapshot the FluidBlank source consumes.
     *  Hosts that haven't opted into the feature can omit this; the
     *  resolver then passes `undefined` for `context.blankContext` and
     *  blank-context is inert. Implementations are expected to be
     *  cheap (cache-backed) â invoked on every keystroke that fires a
     *  resolve. */
    private blankContextProvider?: () => Promise<
      | { fields: ReadonlyArray<{ token: string; description: string; value: string }>;
          catalog: ReadonlyMap<string, string>;
          mode: 'safe' | 'raw' }
      | undefined
    >,
    /** Phase 4 â capability-gated on-demand blank fetch for the typed-sentinel
     *  parameterized tier. Built by `buildBlankFetchProvider`; undefined when
     *  no blank opts into `ai-callable`. */
    private blankFetchProvider?: {
      getAiCallableFns: () => ReadonlyMap<string, { blankName: string; tokenPrefix: string }>;
      getRenderedBlock: () => string;
      blankFetch: (blankName: string, arg: string) => Promise<string | undefined>;
    },
    /** Undo journal â every substitute the resolver applies records a
     *  transaction so `undo _` can revert it; also enables the ACTION
     *  branch (undo/redo application) itself. Omit to disable both. */
    private undoJournal?: UndoJournal,
  ) {}

  /** Pending config-intent transaction â opened lazily by the wrapped
   *  applyOpencuesScalar (scalar writes land at EMIT time inside core's
   *  getCues), closed by the config-intent substitute branch (which
   *  adds the buffer entry) or, on a race-bail, by resolveAndApply's
   *  end-of-pass commit â the scalar DID change, so a scalar-only
   *  transaction is correct. */
  private _pendingConfigIntentTx: PendingTransaction | null = null;

  /** Lazily-constructed applier for the ACTION (undo/redo) branch. */
  private _undoApplier: UndoApplier | null = null;

  /** Commit + clear any open config-intent transaction (scalar-only
   *  when the buffer splice never landed). */
  private commitPendingConfigIntentTx(): void {
    const tx: PendingTransaction | null = this._pendingConfigIntentTx;
    this._pendingConfigIntentTx = null;
    if (tx) tx.commit();
  }

  /** Record a substitute into the undo journal (no-op without one).
   *  `fill: true` uses fillSplice so undoing a `_`-triggered fill restores
   *  the user's text WITHOUT re-arming the trigger (the re-fire loop). */
  private recordUndo(label: string, before: string, after: string, opts?: { fill?: boolean }): void {
    if (!this.undoJournal) return;
    const buf = (opts?.fill ? fillSplice : diffSplice)(before, after, this.undoJournal.currentEpoch);
    if (!buf) return;
    this.undoJournal.record({ label, entries: [buf] });
  }

  subscribe(): void {
    this.rebuildResolver();
    this._unsubText = this.adapter.onTextChange(e => this.onTextChange(e));
    this._unsubKey = this.adapter.onKey({ keys: ['_'] }, e => this.onUnderscoreKey(e));
  }

  /** Arm the one-shot keystroke flag on plain `_` presses (no
   *  ctrl/alt/meta) â but ONLY when the simulated insertion would
   *  produce a standalone `_` word. A `_` typed adjacent to existing
   *  letters (`monologue` + `_` â `monologue_`, or inside a word like
   *  `monolog_ue`) is structurally NOT a blank trigger; arming on those
   *  would re-open the cursor-split bug (the keystroke happens BEFORE
   *  the split, so a time-window approach can't distinguish them).
   *  Mirrors the same standalone check BlankFill's `onUnderscoreKey`
   *  uses (line ~880). Returns false unconditionally â host inserts
   *  the `_` normally. The flag is cleared at the end of the next
   *  onTextChange dispatch (or kept across a spaced-mode unconfirmed
   *  `_` so the confirming-space's text-change can still see it). */
  private onUnderscoreKey(event: KeyEvent): boolean {
    const m = event.modifiers;
    if (m.ctrl || m.alt || m.meta) return false;
    const insertedText =
      event.text.slice(0, event.cursorOffset) +
      '_' +
      event.text.slice(event.cursorOffset);
    if (!findUnderscoreAtChar(insertedText, event.cursorOffset)) return false;
    this._underscoreKeyArmed = true;
    return false;
  }

  private explicitUnderscoreRecent(): boolean {
    return this._underscoreKeyArmed;
  }

  /**
   * Handle a TASK_* command from EXTRACT â mutate AgentTaskState and
   * substitute new buffer content. Only the trailing trigger phrase
   * (`agentically <X> _`, `add task <X> _`, `stop task _`, `current task
   * _`) is stripped from the buffer; any prose the user typed before
   * the trigger is preserved so the agent can act on it.
   *
   * - TASK_ARM   â arm a fresh task; strip trigger fragment
   * - TASK_ADD   â append to existing task prompt; strip trigger fragment
   * - TASK_STOP  â clear task; strip trigger fragment
   * - TASK_SHOW  â strip trigger fragment, append current task prompt
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

    // Stale-arm guard: a TASK_ARM verdict arriving within 3s of a
    // TASK_STOP is almost certainly an in-flight LLM response from
    // BEFORE the stop (the source's call was issued when the task was
    // armed, returned after the user disarmed). Without this guard the
    // stale ARM re-arms the task silently and the agent starts
    // rewriting subsequent text. See _lastTaskStopAt for the rationale.
    if ((action === 'TASK_ARM' || action === 'TASK_ADD') && this._lastTaskStopAt > 0) {
      const sinceStopMs = Date.now() - this._lastTaskStopAt;
      // Only drop if WITHIN the stale window AND the prompt matches the
      // task we just stopped â that's the in-flight-LLM-response case.
      // A different prompt within the window is a fresh user action
      // (e.g. running scenario 31 right after scenario 21's cleanup) and
      // must be allowed through; the original guard was too aggressive.
      if (sinceStopMs < 3000 && payload === this._lastTaskStopPrompt) {
        this.adapter.log('info', `AgentTask: dropping stale ${action} (arrived ${sinceStopMs}ms after TASK_STOP, prompt matches just-stopped task â likely in-flight LLM response, prompt="${payload}")`);
        return;
      }
    }

    // Host opt-out gate for agentic flows. Hosts whose currently-focused
    // target can't support background agent rewrites (chrome on Quill â
    // see adapter.ts Â§ supportsAgentRewrite) silently drop ARM/ADD
    // verdicts here by rewriting them to a no-op that still trims the
    // trigger phrase from the buffer (clean feedback), but doesn't arm
    // the task. STOP is still honored so users can disarm tasks armed
    // in a different (supported) context that the focus has since
    // moved away from.
    const agentRewriteSupported = this.adapter.supportsAgentRewrite?.() ?? true;
    const effectiveAction = (!agentRewriteSupported && (action === 'TASK_ARM' || action === 'TASK_ADD'))
      ? 'TASK_SUPPRESSED'
      : action;
    if (effectiveAction === 'TASK_SUPPRESSED') {
      this.adapter.log('info', `AgentTask: arm/add suppressed â current target does not support agent-rewrite (supportsAgentRewrite=false)`);
    }
    switch (effectiveAction) {
      case 'TASK_SUPPRESSED':
        newText = prefix;
        newCursor = newText.length;
        break;
      case 'TASK_ARM':
        state.arm(payload);
        this.adapter.log('info', `AgentTask: ARM (taskId=${state.taskId?.slice(0, 8)}â¦, prompt="${payload}")`);
        newText = prefix;
        newCursor = newText.length;
        break;
      case 'TASK_ADD':
        if (!state.armed) {
          // Treat add-without-prior-arm as an arm
          state.arm(payload);
          this.adapter.log('info', `AgentTask: ADD-as-ARM (no prior task; taskId=${state.taskId?.slice(0, 8)}â¦, prompt="${payload}")`);
        } else {
          state.appendToPrompt(payload);
          this.adapter.log('info', `AgentTask: ADD (taskId=${state.taskId?.slice(0, 8)}â¦, prompt="${state.prompt}")`);
        }
        newText = prefix;
        newCursor = newText.length;
        break;
      case 'TASK_STOP':
        this.adapter.log('info', `AgentTask: STOP (was prompt="${state.prompt}")`);
        this._lastTaskStopPrompt = state.prompt;
        state.stop();
        this._lastTaskStopAt = Date.now();
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
        return;  // unknown action â defensive no-op
    }

    if (this.adapter.pushText) {
      this.adapter.pushText(newText, newCursor);
    } else {
      this.adapter.setText(newText);
      this.adapter.setCursorOffset(newCursor);
      this.adapter.forceRender();
    }

    // TASK_SHOW emits the substituted prompt as a DynDef span â same
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
          // Lock against re-resolution by other LLM-driven sources â
          // same flag fluid-blank's substitutions use.
          blankName: 'task-show',
        });
      }
    }
  }

  unsubscribe(): void {
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
    if (this._unsubKey) { this._unsubKey(); this._unsubKey = null; }
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
          this._httpAdapter = new NodeHttpAdapter({ maxSockets: 2, timeout: 30000 }); // BROWSER-SAFE-ALLOW: native-host fallback only â reached when this.options.httpAdapter is unset (chrome always passes it)
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
    // Per-feature settings (resolution order, most â least specific):
    //   per-cue/blank frontmatter (`provider:` / `model:`)
    //     > per-feature (`agent-provider:`, `fluid-blank-model:`, â¦)
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
      // Host UI override > OPENCUES.md scalar > host-supplied default.
      // Chrome popup writes endpointOverride/modelOverride/providerOverride;
      // native hosts leave them undefined so OPENCUES.md remains
      // authoritative there. Lets a chrome user pick `cerebras + gpt-oss-120b`
      // in the popup and have it WIN over a stale `llm-provider: groq` in
      // their synced ~/.cues/OPENCUES.md.
      endpoint: (this.options.endpointOverride && this.options.endpointOverride.length > 0
        ? this.options.endpointOverride
        : settings.get('llm-endpoint') ?? this.options.endpoint),
      defaultModel: (this.options.modelOverride && this.options.modelOverride.length > 0
        ? this.options.modelOverride
        : settings.get('llm-model') ?? this.options.defaultModel),
      // Global tier (read once per build). Prose-bearing sources
      // (word-cues, sentence-cues, auditors, agent-rewrite) refuse to
      // dispatch through providers with `trainsOnInput: true` (today
      // only opencode-zen) â that guard is enforced at source-build
      // time downstream, not here, because we still need to surface
      // the user's choice to blank sources (which CAN use it via
      // explicit `<feature>-llm-provider: opencode-zen` + `model: free`).
      globalProvider: this.options.providerOverride ?? settings.get('llm-provider'),
      // Global MODEL tier: ONLY an explicit choice â host-UI modelOverride
      // (chrome popup) or the `llm-model:` scalar in OPENCUES.md. We
      // deliberately do NOT fall back to `this.options.defaultModel` here.
      //
      // That host default is provider-BLIND (the legacy Groq-namespaced
      // `openai/gpt-oss-120b`). When the provider auto-routes to a
      // provider with a different model namespace â e.g. Cerebras serves
      // the same weights as bare `gpt-oss-120b` â injecting the host
      // default as the global model overrides the provider's own correct
      // `defaultModel` and ships an INVALID (provider, model) pair
      // (`cerebras` + `openai/gpt-oss-120b` â provider `model_not_found`).
      // With no explicit model, resolveLLM falls through to the resolved
      // provider's `defaultModel`, which is valid by construction for
      // whatever provider auto-route (or an explicit `llm-provider:`)
      // landed on. See llm-provider.ts resolveLLM + its auto-route tests.
      globalModel: (this.options.modelOverride && this.options.modelOverride.length > 0
        ? this.options.modelOverride
        : settings.get('llm-model')),
      globalEndpoint: (this.options.endpointOverride && this.options.endpointOverride.length > 0
        ? this.options.endpointOverride
        : settings.get('llm-endpoint') ?? this.options.endpoint),
      // Per-bucket override tiers â the three-bucket simplification.
      // Sits BETWEEN per-feature and global at the resolveFor layer.
      // `inherit` collapses to undefined in build-sources so the
      // bucket effectively disappears and global takes over. Auditors
      // resolve through boot-common's buildAgentLLMResolver and never
      // touch this path.
      cuesBucketProvider: this.configLoader.opencuesState.cuesLlmProvider,
      // `default` means "use the provider's defaultModel" â translate
      // to undefined so the resolver's fallback chain kicks in. Same
      // semantics as the scalar being absent, but keeping `default` as
      // an explicit cycleable value lets `config _` cycling express
      // "reset to provider default" without a delete-scalar path.
      cuesBucketModel: normalizeModelScalar(settings.get('cues-llm-model')),
      cuesBucketEndpoint: settings.get('cues-llm-endpoint'),
      blanksBucketProvider: this.configLoader.opencuesState.blanksLlmProvider,
      blanksBucketModel: normalizeModelScalar(settings.get('blanks-llm-model') ?? settings.get('blank-llm-model')),
      blanksBucketEndpoint: settings.get('blanks-llm-endpoint') ?? settings.get('blank-llm-endpoint'),
      // Per-feature tier.
      wordCues: featureLLM(settings, 'word-cues'),
      fluidBlank: featureLLM(settings, 'fluid-blank'),
      transformBlank: featureLLM(settings, 'transform-blank'),
      configIntent: featureLLM(settings, 'fluid-config'),
      sentenceCues: featureLLM(settings, 'sentence-cues'),
      // Spelling is a regular config-driven cue now (defaults/cues/
      // spelling.md). It inherits per-cue / `word-cues-*` / global LLM
      // routing through the standard ConfigSource path â no per-feature
      // wiring needed here.
      blanks: this.configLoader.folderConfigs?.blankOverrides ?? {},
      // disable lists from CUES.md / BLANKS.md. Each is the union across
      // every search-path layer â ConfigLoader merged them in load().
      disableCues: this.configLoader.folderConfigs?.cuesConfig?.disableCues ?? [],
      disableBlanks: this.configLoader.folderConfigs?.blanksConfig?.disableBlanks ?? [],
      // ALL opt-in: every cue surface defaults to OFF. User flips on via
      // OPENCUES.md. Missing settings â off. Explicit "on" â on.
      // See packages/opencues-core/src/sources/build-sources.ts for what
      // each flag gates.
      // Fluid is the ALWAYS-ON base layer: every `_` not claimed by a blank
      // shape resolves through fluid. (`fluid-blank-mode` retired in the
      // static-resolution design.)
      enableFluidBlank: true,
      enableTransformBlank: settings.get('transform-blank-mode') === 'on',
      enableConfigIntent: settings.get('fluid-config-mode') === 'on',
      // Deliberate `!== 'off'` polarity: undo-mode defaults ON even on
      // installs whose OPENCUES.md pre-dates the scalar (no line at all).
      enableUndoActions: settings.get('undo-mode') !== 'off',
      enableSentenceCues: settings.get('sentence-cues-mode') === 'on',
      enableContradictionCues: settings.get('contradiction-cues-mode') === 'on',
      enableWordCues: settings.get('word-cues-mode') === 'on',
      // `max-thinking` (default on). Threaded into every LLM source's
      // dispatch ctx; @opencues/core/model-thinking.ts resolves the
      // per-model reasoning ceiling (on) vs reduced level (off). Only
      // `off` changes anything â `on` reproduces the prior behaviour.
      maxThinking: (settings.get('max-thinking') ?? 'on') !== 'off',
      // applyOpencuesScalar â ConfigIntentSource's side-effect callback.
      //
      // Does TWO things, matching the pair that satellite cycling
      // always does together (cycling.ts:cycleSelectorSatellite):
      //   1. ConfigLoader.applyOpenCuesScalar â updates in-memory
      //      state + arms 2.5s reload suppression.
      //   2. invokeOrSpawn opencues blank with `set <setting> <value>`
      //      â actually writes the file. Without this the in-memory
      //      flip reverts the next time reload-suppression expires and
      //      ConfigLoader reads the un-modified file (caught 2026-05-19
      //      via the agentic harness â `turn on voice mode _` showed
      //      `voice-mode active` for ~2.5s then snapped back to
      //      inactive). Cycling's path always pairs the in-memory
      //      update with a `set` invocation; ConfigIntent was missing
      //      the second half.
      applyOpencuesScalar: async (setting: string, value: string) => {
        // Undo journal: config-intent scalar writes land HERE at emit
        // time (inside core's getCues), before the pair splice. Open a
        // pending transaction lazily; the config-intent substitute
        // branch adds the buffer entry and commits. Prev value read
        // BEFORE the apply. Skipped while an undo/redo is itself
        // applying (runApply reentrancy).
        if (this.undoJournal && !this.undoJournal.applying) {
          this._pendingConfigIntentTx ??= this.undoJournal.begin('settings change');
          this._pendingConfigIntentTx.add({
            kind: 'scalar-write',
            key: setting,
            prevValue: this.configLoader.opencuesState.settings.get(setting),
            newValue: value,
          });
        }
        // Shared in-memory + persist pair â see util/apply-scalar.ts
        // (also used by the UndoApplier's scalar-write inversion).
        await applyScalarAndPersist(this.adapter, this.configLoader, setting, value);
      },
      // Debug log sink â surfaces TransformBlankSource pipeline traces
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
      // seam (see CuesCoreLike) â the explicit parameter types keep
      // strict-mode happy without re-importing the whole core surface.
      // TransformBlank + FluidBlank lifecycle events go through the
      // event-bridge for runtime consumers (debug-mode visualisers,
      // event-stream taps, etc.). The `started` events ALSO get an
      // info-level log line â they carry the resolved provider/model
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
      // don't implement supportsCycling default to true â every
      // pre-existing host has cycling.
      supportsCycling: this.adapter.supportsCycling?.() ?? true,
      // Host id â host-scopes the config-intent classifier's feature list
      // (chrome-only FEATURES like statusbar-position stay off other hosts).
      hostName: this.adapter.hostName,
      // Host-specific in-buffer message shown when NO LLM source could
      // be built (zero working keys). Hosts pass this via ResolverOptions
      // â chrome sets "open the extension popup", native hosts (CC/OC)
      // mention `~/.cues/.env`. Empty/undefined disables the fallback
      // (regresses to silent no-op â only do this if the host surfaces
      // the warning some other way, e.g. statusline).
      missingKeyFallbackMessage: this.options.missingKeyFallbackMessage,
      formatLLMErrorAsSubstitute: this.options.formatLLMErrorAsSubstitute,
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
    // BlankSource isn't in this list â keyword-bound blanks dispatch
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
      s.get('transform-blank-mode') ?? '',
      s.get('fluid-config-mode') ?? '',
      s.get('undo-mode') ?? '',
      s.get('sentence-cues-mode') ?? '',
      s.get('word-cues-mode') ?? '',
      s.get('llm-endpoint') ?? '',
      s.get('llm-model') ?? '',
      s.get('llm-provider') ?? '',
      // Bucket scalars (three-bucket simplification). Auditors live in
      // boot-common's resolveLLM thunk so its scalars are NOT keyed
      // here â agent-rewrite resolves at tick time, not build time.
      s.get('cues-llm-provider') ?? '', s.get('cues-llm-model') ?? '', s.get('cues-llm-endpoint') ?? '',
      s.get('blanks-llm-provider') ?? s.get('blank-llm-provider') ?? '',
      s.get('blanks-llm-model') ?? s.get('blank-llm-model') ?? '',
      s.get('blanks-llm-endpoint') ?? s.get('blank-llm-endpoint') ?? '',
      s.get('word-cues-provider') ?? '', s.get('word-cues-model') ?? '', s.get('word-cues-endpoint') ?? '',
      s.get('fluid-blank-provider') ?? '', s.get('fluid-blank-model') ?? '', s.get('fluid-blank-endpoint') ?? '',
      s.get('transform-blank-provider') ?? '', s.get('transform-blank-model') ?? '', s.get('transform-blank-endpoint') ?? '',
      s.get('fluid-config-provider') ?? '', s.get('fluid-config-model') ?? '', s.get('fluid-config-endpoint') ?? '',
      s.get('sentence-cues-provider') ?? '', s.get('sentence-cues-model') ?? '', s.get('sentence-cues-endpoint') ?? '',
      // Universal-Integration: chrome's adapter answers per-current-target.
      // When focus moves between a contenteditable (cycling) and a normal
      // input (no cycling), the build key flips and sources rebuild on
      // the next text-change â pruning/restoring cycleable sources without
      // an explicit reload.
      this.adapter.supportsCycling?.() ?? true ? '1' : '0',
    ].join('|');
  }

  // âââ Internals âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

  private onTextChange(e: TextChangeEvent): void {
    if (e.source !== 'user') return; // ignore our own setText echoes
    if (!this._resolver) return;

    // Modal-override gate (tutorial mode). Suppress the whole dispatch
    // AND any pending debounce so no cue/blank source fires against a
    // buffer the modal module owns.
    if (this.options.externallySuppressed?.(e.text)) {
      if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
      this.adapter.log('debug', 'Resolver: externally suppressed (modal mode) â skipping dispatch');
      return;
    }

    // If OPENCUES.md flags changed since last build, rebuild before
    // dispatching. ConfigLoader hot-reloads opencuesState on text-change
    // but doesn't notify Resolver, so without this check a flag flip
    // (`transform-blank-mode: off → on`, `word-cues-mode: off → on`, …)
    // would only take effect on next host restart.
    const currentKey = this.computeBuildKey();
    if (currentKey !== this._lastBuildKey) {
      this.adapter.log('info', `Resolver: OPENCUES.md flags changed â rebuilding sources`);
      this.rebuildResolver();
    }

    // Fluid-blank fast-path: when the user just typed `_` (it's at the
    // trailing edge AND wasn't there before), bypass the debounce and
    // resolve immediately. Cuts the magical-helper latency from ~1000ms
    // to ~500ms by skipping the 500ms debounce that exists to coalesce
    // mid-word typing.
    const text = e.text;
    const prev = this._lastInputText;
    // Same-text dedupe â some hosts (notably OpenCode's Solid prompt)
    // re-emit `onContentChange` for the same buffer content after the
    // initial change event. Without this guard, the second event falls
    // through to scheduleResolve() (it's not a fresh `_` trigger), which
    // fires a redundant resolveAndApply ~500ms later. For a `_`-trigger,
    // that meant two parallel LLM calls on the same text â two
    // substitutions â duplicated body content the user sees. Same text
    // in, same text out, nothing for the resolver to do â early return.
    if (text === prev) return;
    this._lastInputText = text;
    // Gate-comparison baseline: use the adapter's `e.previousText`, NOT
    // `this._lastInputText`. _lastInputText is updated only on user-
    // source events (the early-return at the top of this function), so
    // a runtime write between two user events (e.g. BlankFill or
    // TransformBlank writing the substitute via setText) leaves
    // _lastInputText stale. The gate then sees the stale prior buffer,
    // miscomputes freshness, and routes the new `_` to scheduleResolve
    // with allowBlanks=false â masking it from every blank source and
    // producing the "stacked-blank after substitute silently no-ops"
    // bug. `e.previousText` is the adapter's actual prior buffer state
    // (updated regardless of source), so it reflects what the user saw
    // before this change. _lastInputText stays as the dedupe baseline
    // for the early-return above.
    const gatePrev = e.previousText;
    // Trigger detection â gated by blank-trigger-mode.
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
      blankJustTyped = /_\s+$/.test(text) && !/_\s+$/.test(gatePrev);
    } else {
      blankJustTyped = text.trimEnd().endsWith('_') && !gatePrev.trimEnd().endsWith('_');
    }
    // Explicit-`_` gate: the trailing `_` only counts as a blank trigger
    // when it was placed by an explicit `_` keystroke. A `_` that appeared
    // via cursor-relocation exposing an attached `_` (`monologue_` â cursor
    // inside â space â `monologue _`) must NOT fire. The keystroke handler
    // (`onUnderscoreKey`) arms the one-shot flag; this gate reads it
    // BEFORE the flag is cleared in the finally block below.
    //
    // Diff-based fallback: some host adapters route keydowns through a
    // path that can drop `_` events (chrome's focus-trap modals â LinkedIn
    // share composer, Reddit's <shreddit-composer> â clear `currentTarget`
    // during focus shuffle, so the document-level keydown listener
    // early-returns before reaching `onUnderscoreKey`). For these cases
    // we accept "underscore count just went UP AND the new `_` is in a
    // standalone position at the cursor" as an implicit arm signal. This
    // is structurally narrower than PR #52's cursor-split case: the
    // cursor-split's `_` count stays the same (the `_` existed before,
    // only got exposed); a freshly-typed `_` increases the count. Trust
    // gate (chrome) and source filter (line 772 already excludes runtime
    // writes) keep this safe for non-user origins.
    const prevUnderscoreCount = (gatePrev.match(/_/g) || []).length;
    const newUnderscoreCount = (text.match(/_/g) || []).length;
    // Count-delta alone is sufficient â `blankJustTyped` (computed
    // above) already proves a standalone `_` exists at the trailing
    // edge. The cursor-split bug doesn't change the count (just
    // exposes an existing `_` via whitespace insertion), so any
    // count increase is structurally a fresh insert.
    const freshUnderscoreInserted = newUnderscoreCount > prevUnderscoreCount;
    if (blankJustTyped && !this.explicitUnderscoreRecent() && !freshUnderscoreInserted) {
      // Observability: this suppression is otherwise completely silent on
      // the resolver path (fluid/transform/config-intent blanks just never
      // dispatch â no `starting` line ever appears). Mirror BlankFill's
      // `explicit-_ gate BLOCKED` debug line so `DEBUG=cues*` can explain a
      // `_` that "did nothing". The most common cause: the trailing `_`
      // was NOT placed by a fresh standalone `_` keystroke (exposed
      // by editing existing text, or typed adjacent to a word so
      // `onUnderscoreKey` declined to arm the one-shot flag).
      this.adapter.log('debug', `Resolver: explicit-_ gate BLOCKED blank trigger (trailing _ present but no recent standalone _ keystroke; mode=${triggerMode})`);
      blankJustTyped = false;
    } else if (blankJustTyped && !this.explicitUnderscoreRecent() && freshUnderscoreInserted) {
      // Implicit arm via text diff â host adapter likely missed the
      // keydown but the buffer state unambiguously shows a fresh insert.
      this.adapter.log('debug', `Resolver: explicit-_ gate auto-armed via diff (fresh _ at cursor; host adapter may have missed keydown; mode=${triggerMode})`);
    }
    let keepArmed = false;
    try {
      if (blankJustTyped) {
        if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
        this.adapter.log('debug', `Resolver: _ trigger â bypassing debounce (mode=${triggerMode})`);
        void this.resolveAndApply(text, { allowBlanks: true });
        return;
      }

      // In spaced mode, an unconfirmed lone `_` at end of buffer should
      // never fire blanks â not via bypass (handled above) AND not via
      // the debounced fall-through (handled here). Skip scheduling so a
      // user pausing after `_` doesn't end up substituted. The next
      // text-change (typing more or the confirming space) re-evaluates.
      // KEEP the armed flag across this dispatch so the next text-change
      // (the confirming space) can still see the user's earlier explicit
      // `_` keystroke. Without this, spaced-mode legit usage would
      // permanently fail the explicit-`_` gate.
      if (triggerMode === 'spaced' && text.trimEnd().endsWith('_') && !/_\s+$/.test(text)) {
        if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
        keepArmed = true;
        return;
      }

      // Pass the diff-based freshness signal through so the debounced
      // resolve also unblocks blank sources when the `_` is mid-buffer
      // (e.g. `make this formal _ hey can u send me that report` â TransformBlank-
      // style "instruction _ target"). Without this, only trailing-`_`
      // patterns would arm via the diff fallback; middle-`_` patterns
      // would silently no-op because the explicit-keystroke arm path
      // (onUnderscoreKey) is the only way `allowBlanks` becomes true.
      this.scheduleResolve(text, freshUnderscoreInserted);
    } finally {
      // One-shot: clear armed flag at the END of this onTextChange so the
      // NEXT text-change (one not paired with a `_` keystroke) doesn't
      // inherit the freshness. Exception: spaced-mode unconfirmed `_`
      // (see `keepArmed`) â the user explicitly typed `_` and is waiting
      // for the confirming space; we MUST keep the flag through one extra
      // dispatch. `scheduleResolve` above captures the flag INTO its
      // closure BEFORE this clear runs, so the debounced fire still sees
      // allowBlanks=true when the keystroke was genuine.
      if (!keepArmed) this._underscoreKeyArmed = false;
    }
  }

  private scheduleResolve(text: string, freshUnderscoreInserted = false): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    const delay = this.options.debounceMs ?? 500;
    // Capture the freshness now so the gate reflects when the change
    // happened â not when the debounce fires `delay` ms later (by which
    // time the keystroke window may have lapsed even though the user
    // genuinely just typed `_`). Accept either the keystroke arm flag
    // OR a positive underscore-count delta as proof of fresh user
    // intent â see callsite comment for the middle-`_` rationale.
    const allowBlanks = this.explicitUnderscoreRecent() || freshUnderscoreInserted;
    this._debounceTimer = setTimeout(() => {
      void this.resolveAndApply(text, { allowBlanks });
    }, delay);
  }

  /** Exposed for tests.
   *  @param opts.allowBlanks Default true. When false, `_` slots in the
   *    buffer are masked from blank sources (FluidBlank / TransformBlank /
   *    ConfigIntent). Production callers in `onTextChange` set this based
   *    on `explicitUnderscoreRecent()` â see the explicit-`_` gate above. */
  async resolveAndApply(text: string, opts: { allowBlanks?: boolean } = {}): Promise<void> {
    const allowBlanks = opts.allowBlanks ?? true;
    if (!this._resolver) return;
    // A pending config-intent transaction left over from a superseded/
    // early-returned pass holds real scalar writes â commit it (scalar-
    // only) rather than let it dangle and mis-attach to this pass.
    this.commitPendingConfigIntentTx();
    // Abort the previous resolve's in-flight HTTP calls (if any). The
    // resolve is being superseded by this newer one â its results would
    // be dropped on generation mismatch downstream, so the LLM round-
    // trip is pure waste (provider $$$ + rate-limit pressure).
    if (this._inFlightController) {
      try { this._inFlightController.abort(); } catch { /* never */ }
    }
    const controller = new AbortController();
    this._inFlightController = controller;
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
    // by RoutedWordSourceGroup + every other CueSource â no LLM call.
    // Rules:
    //   - Blanks (`_`) always re-resolve â their context determines the
    //     answer and may have changed.
    //   - Words inside an active blank-fill (SpanFillState) are owned
    //     by cycling; re-querying would waste tokens.
    //   - Words inside ANY multi-word static-alt span (DynDefs-derived)
    //     are owned by cycling â origin OR inner positions.
    //   - A DynDef at this index already claims the position. The word
    //     might be:
    //         (a) the def's originalWord (untouched after resolve)
    //         (b) the def's currentAlt (user cycled to a single-word alt)
    //     Both cases mean cycling owns this word and the resolver must
    //     not second-guess it. Without this, cycling attorney â lawyer
    //     would let the resolver re-evaluate "lawyer" as a fresh word
    //     and drift the alt track (lawyer â client â customer â ...).
    const span = this.spanFillState?.current;
    const cleanWords = wordSpans.map((w, i) => {
      const cleaned = w.word.replace(/[\u200B\u200C]/g, '');
      // Blanks normally always re-resolve â context may have changed â
      // BUT if the `_` is inside an existing DynDef's span the answer
      // is already cached (typical case: user cycled the def back to
      // currentIndex=0 to view the original query, then nudged the
      // buffer with a space or extra char). Re-resolving here would
      // burn another LLM round-trip for a cache hit. Cycling forward
      // (Ctrl+Alt+Up) recovers the existing answer; explicit edits
      // that materially change the trigger prune the DynDef via
      // pruneStale, after which the `_` falls through to a real resolve.
      if (cleaned === '_') {
        if (this.dynDefs.findSpanContaining(i)) return '';
        // Explicit-`_` gate (mirrors the bypass gate in onTextChange): a
        // `_` slot in the buffer only routes to blank sources when the
        // caller declares this resolve pass came from an explicit `_`
        // keystroke. Without this, a falls-through scheduleResolve fires
        // FluidBlank / TransformBlank on `_`s that were never explicitly
        // typed (paste, programmatic setText, cursor-relocation exposing
        // `monologue _` from `monologue_`). The flag is wired from
        // onTextChange (which reads `explicitUnderscoreRecent()`); direct
        // unit-test calls to resolveAndApply default to allowBlanks=true
        // so the existing test suite â which exercises the resolver in
        // isolation, with no keystroke surface â keeps working. Word-cues
        // / sentence-cues continue to run on the other words; only the
        // `_` slot is masked.
        if (!allowBlanks) return '';
        return cleaned;
      }
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
    // not what the agent rendered â so commands work even if the agent
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
    // word that's already bold loses the bold â markers don't exist
    // in the visible buffer (stripped at write time).
    //
    // Cache-prefix match is TRAILING-WHITESPACE-TOLERANT: the cached
    // text often carries preserved separators (newlines after a
    // substitution) that the user has since typed over. We compare on
    // the body â everything up to and including the last styled range â
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
          // Markers index into cached.text â re-inject them into
          // cachedBody (a prefix), then append whatever the user has
          // typed past that point.
          richText = injectMarkdownMarkers(cachedBody, cached) + text.slice(cachedBody.length);
        }
      }
    }

    // Loading animation: start animating every `_` slot before dispatch
    // and release the resolver's claim after the pipeline returns
    // (success, error, or empty result). Refcounted by owner â when a
    // keyword-bound `_` (stocks, weather, volume) is also being filled
    // by BlankFill, both modules call start/stop with their own owner
    // ID and the slot keeps animating until BOTH release. Without that,
    // the resolver's typically-fast return on keyword-bound slots
    // (no resolver-side source claims them) would kill BlankFill's
    // still-pending animation before the first frame ever paints.
    // stop() restores each slot to `_` so the substitution path's
    // `target.word === '_'` check still passes.
    const animatedSlots: number[] = [];
    if (this.blankLoading) {
      for (let i = 0; i < cleanWords.length; i++) {
        if (cleanWords[i] === '_') {
          this.blankLoading.start(i, 'resolver');
          animatedSlots.push(i);
        }
      }
    }
    const stopAllAnimations = (): void => {
      if (!this.blankLoading) return;
      for (const i of animatedSlots) this.blankLoading.stop(i, 'resolver');
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
        // `ambient-context-mode` scalar (off by default) â when off,
        // the host adapter is not even consulted, so a misbehaving
        // host can't accidentally leak metadata.
        //
        // When on: ask the host. The host still returns null when it
        // can't gather (e.g. CC/OC native hosts have no DOM) OR when
        // the focused field is sensitive (password/CC/OTP).
        //
        // Only FluidBlankSource consumes this â see AmbientContext
        // for the full security contract. The runtime is intentionally
        // not plugged into any tool-handling or exec layer for fluid-
        // blank prompts, so the ambient block can only land in text
        // the user sees before submitting.
        ambient: this.configLoader.opencuesState.ambientContextMode === 'on'
          ? (this.adapter.getAmbientContext?.() ?? undefined)
          : undefined,
        // Optional identity context (identity-context-mode personal data). Gated by
        // `identity-context-mode` in OPENCUES.md (when `off` we don't
        // even forward the parsed catalog, so a future misconfigured
        // source can't accidentally read it).
        //
        // NO `noBlankContextConsumer` gate here (dropped for the buffer-
        // dehydration feature): in `safe` mode EVERY LLM-bound source
        // (word-cues, sentence-cues, config-intent, config-source raw)
        // now consumes the catalog to dehydrate its outbound text â not
        // just FluidBlank/TransformBlank. The identity catalog is an
        // in-memory Map at the ConfigLoader (no IO), so forwarding it
        // unconditionally costs nothing. blankContext below KEEPS the
        // gate â that one is a network/script fetch.
        identityContext: this.configLoader.opencuesState.identityContextMode !== 'off'
          ? {
              fields: this.configLoader.identity.fields,
              catalog: this.configLoader.identity.catalog,
              mode: this.configLoader.opencuesState.identityContextMode,
            }
          : undefined,
        // Ambient blank-context. Provider call is cache-backed; runs
        // on every resolve so OPENCUES.md flips are picked up without
        // host restart. When mode is off the provider returns
        // undefined. ALSO skipped when every `_` in the buffer is
        // already claimed by a keyword-bound BlankFill slot â the only
        // sources that consume the catalog (FluidBlank, TransformBlank)
        // both cede in that case, so the fetch would be 5 sequential
        // script/network calls whose result is thrown away.
        blankContext: this.configLoader.opencuesState.blankContextMode !== 'off'
          && this.blankContextProvider
          && !noBlankContextConsumer(cleanWords, this.options.keywordBoundSlotIndices?.(text) ?? [])
          ? await this.blankContextProvider()
          : undefined,
        // Calendar-context (ingested calendar). Host writes the snapshot on a
        // cadence (values/times local + dehydrated titles); read fresh here so
        // a re-ingest applies without restart. Gated by `calendar-context-mode`
        // (off by default — carries calendar PII).
        calendarContext: this.configLoader.opencuesState.calendarContextMode !== 'off'
          && this.options.calendarContext
          && this.options.calendarContext.events.length > 0
          ? {
              events: this.options.calendarContext.events,
              catalog: this.options.calendarContext.catalog,
              ingestedAt: this.options.calendarContext.ingestedAt,
              mode: 'on' as const,
            }
          : undefined,
        // Sentinel grammar (bare default / typed opt-in). Threaded so the
        // catalog renderer + post-LLM resolver in TransformBlank/FluidBlank
        // pick the typed-sentinel engine path when enabled.
        sentinelLanguage: this.configLoader.opencuesState.sentinelLanguage,
        // Phase 4 â ai-callable fn registry + capability-gated on-demand fetch.
        // Only populated when the gate is wired (a blank opted into ai-callable)
        // AND sentinel-language is typed; otherwise both are undefined and the
        // core resolver's on-demand path is a no-op.
        aiCallableFns: this.configLoader.opencuesState.sentinelLanguage === 'typed'
          ? this.blankFetchProvider?.getAiCallableFns()
          : undefined,
        aiCallableFnsBlock: this.configLoader.opencuesState.sentinelLanguage === 'typed'
          ? this.blankFetchProvider?.getRenderedBlock()
          : undefined,
        blankFetch: this.blankFetchProvider?.blankFetch,
        // Subscription-routing policy for anthropic-class `with`
        // overrides. Default 'prefer' is set on the OpenCuesState
        // shape itself, so passing it through verbatim is correct â
        // FluidBlank + TransformBlank fall back to 'prefer' if the
        // AbortSignal for in-flight LLM cancellation. Each source's
        // getCues forwards this to its callLLM â httpAdapter.post.
        // When a newer resolveAndApply preempts this one, the
        // controller above aborts, killing pending HTTP calls instead
        // of letting them run to completion just to have their results
        // dropped on generation mismatch.
        signal: controller.signal,
      });
    } catch (err) {
      stopAllAnimations();
      // AbortError on supersede is expected â don't surface as a logical
      // failure. Anything else is a real fault and gets logged.
      if (!isAbortError(err)) {
        this.adapter.log('error', 'Resolver.resolve threw', err);
      }
      // Clear our in-flight slot if it's still us. If a newer resolve
      // already replaced us, leave it alone.
      if (this._inFlightController === controller) this._inFlightController = null;
      return;
    }
    stopAllAnimations();
    if (this._inFlightController === controller) this._inFlightController = null;

    this.adapter.log('debug', `Resolver.resolve: got ${result.results.length} result(s) for ${cleanWords.length} cleanWords`);
    // Per-word routing/skipped surfaces which ConfigSource claimed each
    // word â the structural property RoutedWordSourceGroup enforces for
    // prompt-injection isolation. Empty-string entries in cleanWords
    // mean a span/dyndef already owns the position; they're not surfaced
    // here (internal optimisation, not a routing decision). `_` tokens
    // route through the blank handlers, also out of scope. Words with
    // no claiming source land in `skipped` â useful for catching cue
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

    // Stale check â a newer scheduleResolve might have run in between.
    if (generation !== this._generation) return;

    let wrote = 0;
    // Sentence-cue suppression state. When a `sentence-cue:*` result
    // applies, subsequent word-cue results whose wordIndex falls within
    // ANY applied sentence's word range get suppressed (design rule:
    // sentence wins outright).
    //
    // Multi-sentence-cue (lifted the v1 one-per-resolve cap, June 2026):
    // sentence-cue registration is PASSIVE â the def lands at
    // currentIndex=0 against the UNMODIFIED buffer, no splice. The old
    // cap existed to avoid a word-index shift cascade when MULTIPLE
    // sentences spliced in the same pass; since nothing splices at
    // registration time, every sentence-cue's spanStart/spanEnd stays
    // valid and they can all register together. This is what makes a
    // multi-paragraph (or multi-sentence) buffer cue EVERY sentence
    // instead of only the first â the user-visible symptom was that in
    // spaceless CJK, later paragraphs/sentences weren't highlighted at
    // all because only the first got a DynDef. Same-word collisions
    // (multiple ã-separated sentences inside ONE whitespace-word) are
    // still resolved first-wins by the existing blankName guard below;
    // post-cycle span shifts self-heal on the re-resolve the splice
    // triggers.
    // ACTION-exclusivity gate. When ANY result in this pass is an
    // undo/redo ACTION, it is the user's SOLE intent for the keystroke
    // that triggered it: the `_` they just typed is the action. Other
    // `_`s in the buffer are LEFTOVERS - most commonly the reverted
    // command an undo just restored (e.g. `... make it formal _`), which
    // still has a live `_`. Without this filter, that leftover `_` gets
    // re-evaluated by TransformBlank/FluidBlank IN THE SAME PASS -
    // spending an LLM call to re-run a command the user just undid and
    // splicing its result on top of the undo (live-caught 2026-07-15:
    // `... formal _ redo _` fired BOTH the redo AND a 1972ms re-transform
    // of the old command). Applying an action and a fresh substitution
    // in one pass is never the intent. Drop everything but the ACTION
    // result(s). (The parallel LLM call still fires - the core resolve
    // awaits all sources - but its result is discarded, so the buffer is
    // never double-mutated. Aborting the in-flight call on first-ACTION
    // is a latency follow-up, not a correctness one.)
    const isActionResult = (r: { source?: string; metadata?: unknown }): boolean =>
      r.source === 'config-intent'
      && !!(r.metadata as { undoAction?: unknown } | undefined)?.undoAction;
    const hasAction = result.results.some(isActionResult);
    const applicableResults = hasAction ? result.results.filter(isActionResult) : result.results;
    if (hasAction && applicableResults.length !== result.results.length) {
      this.adapter.log('debug',
        `Resolver: ACTION verdict present - suppressing ${result.results.length - applicableResults.length} other result(s) this pass (undo/redo is the sole intent)`);
    }

    const sentenceClaims: Array<{ start: number; end: number }> = [];
    for (const r of applicableResults) {
      // ââ ACTION (undo/redo). Classified by the config-intent source
      //    (metadata.undoAction), APPLIED here â the journal + applier
      //    live runtime-side. Runs FIRST in the loop: the result's
      //    alternatives carry the action verb (not a substitute), so
      //    none of the generic guards/filters below apply to it.
      const undoAction = (r.metadata as { undoAction?: { action: 'undo' | 'redo'; count: number } } | undefined)?.undoAction;
      if (r.source === 'config-intent' && undoAction && this.undoJournal) {
        const liveText = this.adapter.getText().replace(/[ââ]/g, '');
        const start = r.spanStart ?? 0;
        const end = Math.min(r.spanEnd ?? text.length, liveText.length);
        // Race guards â same pair the config-intent settings branch uses.
        if (!liveText.includes('_')) {
          this.adapter.log('info', 'Undo: skipping â _ no longer in live text');
          continue;
        }
        if (liveText.slice(start, end) !== text.slice(start, end)) {
          this.adapter.log('info', 'Undo: skipping â command span no longer matches analyzed text');
          continue;
        }
        // Tighten the wipe span before splicing. The summon resolver
        // can claim the WHOLE buffer as the command ('debug-mode on
        // undo _' → start 0): unpunctuated prior content gives the
        // regex floor no boundary, and the summon model reads the pair
        // as part of the phrase. But for ACTION verdicts the pre-verb
        // content is typically the CONFIRMATION of the very change
        // being undone — i.e. exactly the relocation anchor the
        // applier needs. NEVER swallow a pending transaction's anchor:
        // shrink the span to start after the last unique anchor
        // occurrence inside it. (Live-caught by agentic scenario 109 —
        // the un-tightened splice emptied the buffer and every buffer
        // entry skipped as not-found.)
        let cmdStart = start;
        {
          const pending = undoAction.action === 'undo'
            ? this.undoJournal.peekUndo(undoAction.count)
            : this.undoJournal.peekRedo(undoAction.count);
          for (const tx of pending) {
            for (const e of tx.entries) {
              if (e.kind !== 'buffer-splice') continue;
              const anchor = undoAction.action === 'undo' ? e.afterSlice : e.beforeSlice;
              if (!anchor) continue;
              const idx = liveText.indexOf(anchor);
              if (idx >= 0 && idx === liveText.lastIndexOf(anchor)
                  && idx >= cmdStart && idx + anchor.length <= end
                  && idx + anchor.length > cmdStart) {
                cmdStart = idx + anchor.length;
              }
            }
          }
        }
        if (cmdStart === start) {
          // Untightened — swallow whitespace before the command so no
          // dangling blank line / trailing space remains (same idea as
          // transform's trigger removal). Skipped when tightened: the
          // position sits right after an anchor, and walking back
          // would eat into it.
          while (cmdStart > 0 && (liveText[cmdStart - 1] === '\n' || liveText[cmdStart - 1] === ' ' || liveText[cmdStart - 1] === '\t')) cmdStart--;
        }
        const working = liveText.slice(0, cmdStart) + liveText.slice(end);

        this._undoApplier ??= new UndoApplier(this.adapter, this.configLoader, this.undoJournal);
        const { text: finalText, report, cursorHint } = await this._undoApplier.apply(undoAction.action, undoAction.count, working);

        // State cleanup BEFORE the buffer write: reverted splices
        // invalidate every span-bound offset (a surviving
        // SelectorSatelliteEntry would point into removed text), and
        // clearing first also stops clearOnEdit watchers reacting to
        // our own write. Deliberately NOT resetSharedBufferState â
        // that bumps the journal epoch and would stale the remaining
        // entries. Cues repopulate on the next keystroke.
        this.dynDefs.clear();
        this.spanFillState?.clear();
        this.selectorSatelliteState?.clear();
        this.hlState.deactivate();

        if (report.appliedEntries === 0) {
          // Nothing applied â splice a visible note instead of silently
          // eating the command (error-substitute pattern, clearOnEdit
          // so one backspace clears it).
          const why = report.skipped.length > 0 ? ` (${report.skipped[0].reason})` : '';
          const note = report.requested === 0
            ? `[OpenCues: nothing to ${undoAction.action}]`
            : `[OpenCues: could not ${undoAction.action}${why}]`;
          // Note replaces only the command span (not the swallowed
          // whitespace — the note keeps its separating space).
          const noted = liveText.slice(0, start) + note + liveText.slice(end);
          const noteStart = start;
          if (this.adapter.pushText) this.adapter.pushText(noted, noteStart + note.length);
          else { this.adapter.setText(noted); this.adapter.setCursorOffset(noteStart + note.length); this.adapter.forceRender(); }
          if (this.spanFillState) {
            const notedWords = splitWords(noted);
            const noteWord = notedWords.find(w => w.start === noteStart);
            if (noteWord) {
              this.spanFillState.set({
                index: noteWord.index,
                alternatives: ['_', note],
                currentAltIndex: 1,
                spanLength: Math.max(1, note.split(/\s+/).filter(Boolean).length),
                clearOnEdit: true,
                pairCharStart: noteStart,
                pairCharEnd: noteStart + note.length,
              }, noted);
            }
          }
          this.adapter.emitEvent?.('undo.applied', { ...report });
          this.adapter.log('info', `Undo: ${undoAction.action} Ã${undoAction.count} â nothing applied (${report.skipped.map(s => s.reason).join(', ') || 'empty journal'})`);
          wrote++;
          continue;
        }

        // ONE buffer write for the whole application (one host history
        // entry). Cursor lands at the END of the restored content
        // (`cursorHint` from the applier's last buffer-splice), NOT the
        // stale pre-undo command offset - `cmdStart` indexes the OLD
        // buffer and lands in an undetermined spot in the reverted text
        // (live-caught 2026-07-15: cursor jumped around after undo/redo).
        // Scalar-only undos (no buffer splice) carry no hint - park at
        // end of buffer, the deterministic sensible default.
        // Trim trailing horizontal whitespace the command-span wipe can
        // leave (`… Paris undo _` → the separator before the command
        // survives as a dangling space). A reverted buffer never
        // meaningfully ends in spaces/tabs; newlines are preserved.
        const trimmedText = finalText.replace(/[ \t]+$/, '');
        const newCursor = Math.min(cursorHint ?? trimmedText.length, trimmedText.length);
        if (this.adapter.pushText) this.adapter.pushText(trimmedText, newCursor);
        else { this.adapter.setText(trimmedText); this.adapter.setCursorOffset(newCursor); this.adapter.forceRender(); }
        this.adapter.emitEvent?.('undo.applied', { ...report });
        this.adapter.log('info', `Undo: ${undoAction.action} Ã${report.requested} applied â ${report.appliedTransactions} transaction(s), ${report.appliedEntries} entr(ies), ${report.skipped.length} skipped${report.skipped.length > 0 ? ` [${report.skipped.map(s => s.reason).join(', ')}]` : ''}`);
        wrote++;
        continue;
      }
      const isSentenceCue = typeof r.source === 'string' && r.source.startsWith('sentence-cue:');
      // ââ Suppression check: word-cue (or any non-LLM-blank result)
      //    inside an applied sentence's word range is dropped.
      const isLlmBlank = r.source === 'fluid-blank' || r.source === 'transform-blank' || r.source === 'config-intent';
      if (sentenceClaims.length > 0 && !isSentenceCue && !isLlmBlank) {
        const claimed = sentenceClaims.find(c => r.wordIndex >= c.start && r.wordIndex <= c.end);
        if (claimed) {
          this.adapter.log('debug', `Resolver: suppressing word-cue at wordIndex=${r.wordIndex} â inside sentence-cue span [${claimed.start},${claimed.end}]`);
          continue;
        }
      }
      const target = wordSpans[r.wordIndex];
      if (!target) continue;
      const existing = this.dynDefs.get(r.wordIndex);
      // Chainable LLM-blank substitutes (fluid-blank / transform-blank)
      // are EXEMPT from the mid-cycle and blankName guards below â they
      // explicitly extend an existing same-class chain at this position
      // via findChainableLlmDef, instead of clobbering it. A blocked
      // skip here would prevent the chain branch from ever running, so
      // sequential "translate to japanese â translate to chinese" calls
      // would silently no-op after the first.
      const isChainableLlmSource = r.source === 'fluid-blank' || r.source === 'transform-blank';
      const sameClassChainable = isChainableLlmSource
        && !!existing?.blankName
        && existing.blankName === r.source;
      // Same-word sentence-cue collision: two sentences segmented from ONE
      // whitespace-word (spaceless CJK â a ã with no following space fuses
      // the next sentence's start into the prior word). They share a natural
      // word index, so the SECOND would be dropped by the blankName guard
      // below and never cued/dimmed (the long-second-sentence bug). Exempt
      // it here; the sentence-cue registration block re-keys it to a
      // synthetic, collision-free index so BOTH survive.
      const sameWordSentenceCueCollision = isSentenceCue
        && typeof existing?.blankName === 'string'
        && existing.blankName.startsWith('sentence-cue:')
        && (existing.spanStart !== r.spanStart || existing.spanEnd !== r.spanEnd);
      // Don't clobber a user mid-cycle on this word.
      if (existing && existing.currentIndex > 0 && !sameClassChainable && !sameWordSentenceCueCollision) continue;
      // Don't clobber blank-attributed entries (volume/brightness blank
      // fills, satellite cycles, etc.) â those route through their own
      // cycling path and have a script set/get protocol the LLM alts
      // would silently break.
      if (existing && existing.blankName && !sameClassChainable && !sameWordSentenceCueCollision) continue;
      // Already resolved â same word at the same index, fresh from a
      // prior LLM pass. Without this, every subsequent text-change
      // (typing the next word, adding a space) clobbers the existing
      // DynDef with a new LLM result. Alts can differ slightly across
      // runs, and each write triggers a forceRender â repaint flash.
      // Only re-resolve if the word at this index actually changed
      // (user deleted/replaced the word).
      if (existing && existing.originalWord === target.word) continue;
      // Tip-having words own their own alternatives via the cueMap
      // (the hand-curated `alts` array under CUES.md's `## Tips` JSON
      // block). The LLM returning grammar synonyms for `ultrathink`
      // etc. would silently override the curated list. Mirrors the
      // legacy CC cue-engine's `skipFn: word => tipsMap.has(word)`
      // filter on the LLM source.
      // Tip-having words own their own alternatives via the cueMap (the
      // hand-curated `alts` array under CUES.md's `## Tips` JSON block).
      // The LLM returning grammar synonyms for `ultrathink` etc. would
      // silently override the curated list. Mirrors the legacy CC
      // cue-engine's `skipFn: word => tipsMap.has(word)` filter on the
      // LLM source.
      //
      // â  LLM blank sources (transform-blank / fluid-blank /
      // config-intent) are EXEMPT. They target `_`; if a user (or a
      // shipped pack) has a tip entry for `_` â tips-shell/CUE.md once
      // had `{ "_": { alts: ["blank","fill","underscore"] } }` â the
      // tip-vs-LLM rule would silently block every blank substitution.
      // Pinned by `transform-blank.scenarios.test.ts` Â§ "tip entry
      // for `_` must not block substitution" (2026-05-28 regression).
      const cueMapEntry = this.configLoader.lookup(target.word);
      const isLlmBlankSource = r.source === 'fluid-blank' || r.source === 'transform-blank' || r.source === 'config-intent';
      if (!isLlmBlankSource && cueMapEntry && cueMapEntry.alternatives && cueMapEntry.alternatives.length > 1) continue;
      const alts = (r.alternatives ?? []).filter(a => a && a !== target.word);
      if (alts.length === 0) continue;
      // FluidBlankSource sets spanStart/spanEnd (character offsets) when
      // it wants the answer to wipe a multi-word lookup phrase, not just
      // the single _ token. Cycling back to alt[0] = `_` clears the
      // lookup phrase to a bare blank.
      const isMultiWordSpan = typeof r.spanStart === 'number'
        && typeof r.spanEnd === 'number'
        && r.spanEnd > r.spanStart;
      // MissingKeyFallback emits the same shape as a fluid-blank
      // substitute (alternatives = ['_', errorMessage]) â route through
      // the fluid-blank applicator so the error text lands in the
      // buffer (otherwise the user only sees it via cycling).
      //
      // Error substitutes â any LLM-driven blank source that classified
      // a user-actionable HTTP failure (transform-blank + config-intent
      // gained this in June 2026; fluid-blank had it earlier) â also
      // get routed through the substitute splice so the user sees the
      // inline `[OpenCues: ...]` message regardless of which source
      // emitted it.
      const isErrorSubstitute = r.source === 'missing-key-fallback'
        || (r.metadata as { fluidBlankErrorReason?: string } | undefined)?.fluidBlankErrorReason !== undefined;
      const isFluidBlank = r.source === 'fluid-blank' || r.source === 'missing-key-fallback' || isErrorSubstitute;
      const isTransformBlank = r.source === 'transform-blank' && !isErrorSubstitute;
      // ConfigIntent emits the same FluidBlank-style shape
      // (alternatives = ['_', confirmation]) â splice the
      // confirmation in at the `_`, register a DynDef for
      // cycling-Down revert. blankName below differs so the def
      // isn't re-resolved as a fluid-blank lookup.
      const isConfigIntent = r.source === 'config-intent' && !isErrorSubstitute;
      // Fluid-blank substitutes inline (BlankFill-style). For WIPE mode the
      // text shrinks so the wordIndex shifts â we have to compute the def's
      // FINAL position in the new text and key the def there, not at the
      // resolver's r.wordIndex (which referred to the pre-substitute text).
      // Without this the def is orphaned at an out-of-bounds index and the
      // next resolve generates synonym alts for the answer position.
      if (isFluidBlank && alts.length > 0) {
        // Race guard: BlankFill runs synchronously after
        // its blankScript returns and can populate the `_` BEFORE this
        // LLM-driven path completes. If `_` is no longer in the live text
        // at the expected position, BlankFill already won â skip our
        // substitute so we don't overwrite "nvidia $209.25" with "NVDA".
        const liveText = this.adapter.getText();
        const start = isMultiWordSpan ? r.spanStart! : target.start;
        const end = isMultiWordSpan ? r.spanEnd! : target.end;
        if (liveText.charAt(start) !== '_' && !liveText.includes('_')) {
          this.adapter.log('info', 'FluidBlank: skipping â _ already substituted by another module');
          continue;
        }
        // Fail-safe (mirrors the ConfigIntent / TransformBlank splice
        // guards): for WIPE mode â which overwrites the whole lookup
        // PHRASE, not just `_` â the range we're about to replace must
        // still match the analyzed snapshot byte-for-byte in the live
        // buffer. If the user typed into it during the async LLM call
        // (or the span now runs past the buffer end), abort rather than
        // splice stale coordinates over their edit. This is the splice-
        // site guard the WIPE path was missing; until now it relied
        // solely on the source emitting a parser-bounded span.
        if (isMultiWordSpan && (end > liveText.length || liveText.slice(start, end) !== text.slice(start, end))) {
          this.adapter.log('info', 'FluidBlank: skipping WIPE â splice range drifted from the analyzed buffer');
          continue;
        }
        // Splice the answer into [start, end) â the canonical
        // FluidBlank shape. applyMarkdownAwareSplice handles strip +
        // write + markdown.styled emit with ranges shifted into
        // final-buffer coords. Same primitive TransformBlank uses
        // below; the only difference is which range we hand it.
        const sub = applyMarkdownAwareSplice(this.adapter, text, start, end, alts[0]);
        const newText = sub.newText;
        const answer = sub.stripped;
        this.recordUndo('fluid-blank fill', text, newText, { fill: true });

        // Find which word in the new text the answer sits at.
        const newWords = splitWords(newText);
        const newWord = newWords.find(w => w.start === start);
        const newWordIndex = newWord ? newWord.index : r.wordIndex;
        // spanEnd must cover the FULL substituted range, not just the
        // first word's end. For a multi-word answer like "William
        // Shakespeare" spliced at start=0, the substituted text occupies
        // [0, answer.length); using newWord.end here would give 7
        // (end of "William"), and the chain-extension verbatim check
        // (`liveText.slice(spanStart, spanEnd) === currentAlt`) would
        // fail on the next substitute because the slice excludes
        // "Shakespeare". Pinned by `fluid-blank-multiword-span.test.ts`.
        const newSpanEnd = start + answer.length;

        // The "question" â the buffer slice we're replacing. For WIPE
        // mode this is the user's full prompt phrase (e.g. "translate
        // hello to japanese _"); for FILL mode it's just "_". Captured
        // as alts[0] so cycling Down restores what the user typed before
        // the LLM ran â they can edit the prompt and re-summon.
        const question = text.slice(start, end);

        // Chain extension: if a prior fluid-blank def sits inside the
        // new span and is still verbatim at its recorded position, the
        // user is doing a sequence of substitutions on the same content
        // (translate to japanese â translate to chinese). Extend the
        // existing alternatives in REVERSE chronological order â newest
        // at index 0 â so Up walks back through history one step at a
        // time (matching the convention every other blank type uses:
        // alts[0] = current, Up = +1 = next in cycle).
        // Truncate-on-branch: if the user cycled back mid-chain before
        // re-summoning, discard the abandoned tail (now the items at
        // indices BELOW currentIndex â newer than where the user landed).
        const existingChain = this.dynDefs.findChainableLlmDef(
          text, start, end, ['fluid-blank'],
        );
        let fluidDef: WordDef;
        if (existingChain) {
          const baseAlts = existingChain.def.alternatives
            .slice(existingChain.def.currentIndex);
          const chainedAlts = [alts[0], question, ...baseAlts];
          fluidDef = {
            originalWord: existingChain.def.originalWord,
            alternatives: chainedAlts,
            currentIndex: 0,
            spanStart: start,
            spanEnd: newSpanEnd,
            blankName: 'fluid-blank',
          };
          if (existingChain.wordIndex !== newWordIndex) {
            this.dynDefs.delete(existingChain.wordIndex);
          }
          this.adapter.log('info', `FluidBlank: extending chain (depth=${chainedAlts.length}, prevWordIdx=${existingChain.wordIndex}, newWordIdx=${newWordIndex})`);
        } else {
          fluidDef = {
            originalWord: question,
            alternatives: [alts[0], question],
            currentIndex: 0,
            spanStart: start,
            spanEnd: newSpanEnd,
            // blankName locks this def against re-resolution by the LLM â
            // same mechanism blank-bound entries use to prevent the answer
            // from being clobbered by RoutedWordSourceGroup synonyms.
            blankName: 'fluid-blank',
          };
        }
        this.dynDefs.set(newWordIndex, fluidDef);
        wrote++;

        // Error substitutes wipe-on-edit. Register a spanFillState
        // entry with clearOnEdit:true at the substituted range; the
        // existing BlankFill.onTextChange â applyClearOnEdit
        // pipeline handles the wipe when the user types or deletes
        // inside the message. Mirrors ConfigIntent's pattern below.
        if (isErrorSubstitute && this.spanFillState) {
          this.spanFillState.set({
            index: newWordIndex,
            alternatives: ['_', ...alts],
            currentAltIndex: 1,
            spanLength: Math.max(1, alts[0].split(/\s+/).filter(Boolean).length),
            clearOnEdit: true,
            pairCharStart: start,
            pairCharEnd: newSpanEnd,
          }, newText);
        }

        this.adapter.log('info', `FluidBlank: substituting "${text.slice(start, end)}" â "${answer}" (mode=${isMultiWordSpan ? 'WIPE' : 'FILL'}, range=[${start},${end}), defAt=${newWordIndex}, errorSub=${isErrorSubstitute}, totalMs=${Date.now() - __resolveStart})`);

        // Emit `fluid-blank.completed` AFTER the buffer commit so
        // observers (statusline, agentic tests) can rely on the event
        // marking a final, user-visible buffer state â never an
        // intermediate loading-animation frame. The source carries the
        // completion payload via `metadata.fluidBlankCompletion`; this
        // structurally closes the race that allowed the braille
        // loading char (Â· â¢ â) to be caught between completion of the
        // LLM call and the resolver's substitute commit. Mirrors the
        // `transform-blank.completed` pattern below. Error substitutes
        // don't carry the metadata field (they bail before recording
        // the success payload), so the optional-chain naturally
        // suppresses the event in that path â error events ride
        // through `fluid-blank.bailed` instead.
        const fbCompletion = r.metadata?.fluidBlankCompletion as
          | { span: string; answer: string; mode: string; latencyMs: number }
          | undefined;
        if (fbCompletion !== undefined) {
          this.adapter.emitEvent?.('fluid-blank.completed', fbCompletion);
        }
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
        // typed away from the original prompt should abort â
        // otherwise unrelated edits silently get destroyed.
        if (!liveText.includes('_')) {
          this.adapter.log('info', `ConfigIntent: skipping â _ no longer in live text (len=${liveText.length})`);
          continue;
        }
        // Stricter check: the range we're about to wipe must still
        // match the analyzed text byte-for-byte. If the user typed in
        // the prefix, we'd otherwise wipe their edit.
        if (liveText.slice(r.spanStart!, r.spanEnd!) !== text.slice(r.spanStart!, r.spanEnd!)) {
          this.adapter.log('info', `ConfigIntent: skipping â wipe range no longer matches analyzed text`);
          continue;
        }
        const selector = alts[0];
        const meta = r.metadata as Record<string, unknown> | undefined;
        const satellite = String(meta?.satelliteValue ?? '');
        // When satelliteCyclingValue is set, it's stored as the
        // cycling state's currentValue while `satellite` is used for
        // the buffer splice. The two differ for PROVIDER verdicts that
        // included a model â buffer shows `anthropic:claude-opus-4-7`,
        // cycling state stores `anthropic`. Falls back to `satellite`
        // when absent (every other case behaves unchanged).
        const cyclingValue = meta && typeof meta.satelliteCyclingValue === 'string' && meta.satelliteCyclingValue
          ? String(meta.satelliteCyclingValue)
          : satellite;
        const sep = String(meta?.displaySeparator ?? ' ');
        const blankName = String(meta?.blankName ?? 'opencues');
        if (!satellite) {
          this.adapter.log('info', 'ConfigIntent: skipping â metadata.satelliteValue missing');
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
              // cyclingValue is the satellite for non-pair cases (same
              // string); for `provider:model` pairs it's just `provider`
              // so cycling Up/Down rotates the provider catalogue. The
              // model auto-resets via providerScalarToModelScalar on
              // each provider cycle, keeping the pair invariant.
              currentValue: cyclingValue,
              separator: sep,
              // clearOnEdit: true â backspacing into either word wipes
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

        // Close the pending config-intent transaction (opened by the
        // wrapped applyOpencuesScalar at emit time) with the buffer
        // entry â scalar writes + pair splice revert as ONE undo.
        if (this.undoJournal) {
          const tx = this._pendingConfigIntentTx ?? this.undoJournal.begin('settings change');
          this._pendingConfigIntentTx = null;
          const buf = diffSplice(liveText, newText, this.undoJournal.currentEpoch);
          if (buf) tx.add(buf);
          tx.commit();
        }

        wrote++;
        this.adapter.log('info', `ConfigIntent: substituting "${text.slice(start, end)}" â "${pair}" (range=[${start},${end}), totalMs=${Date.now() - __resolveStart})`);
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
      // results inside it are suppressed (design 4a â sentence wins).
      //
      // Earlier versions auto-spliced alts[1] the moment the LLM
      // returned (TransformBlank-style). That was agent-like â the
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
        // this sentence, abandon â the cue would point at stale chars.
        if (liveText.slice(start, end) !== originalSentence) {
          this.adapter.log('info', `SentenceCue[${r.source}]: skipping â buffer edit at [${start},${end}) changed the sentence since resolve`);
          continue;
        }
        // Registration key. Normally the sentence's first word index. But
        // when a DIFFERENT sentence-cue already holds that word (two
        // sentences in one spaceless-CJK word), re-key the later one to a
        // synthetic, collision-free index so BOTH survive (the long-second-
        // sentence "not highlighted" bug). Stable across re-resolves (same
        // span â same key), so it isn't duplicated.
        const atNatural = this.dynDefs.get(r.wordIndex);
        const collides = !!atNatural && typeof atNatural.blankName === 'string'
          && atNatural.blankName.startsWith('sentence-cue:')
          && (atNatural.spanStart !== start || atNatural.spanEnd !== end);
        const regKey = collides ? SENTENCE_CUE_SYNTHETIC_KEY_BASE + start : r.wordIndex;

        // Managed-span overlap guard. SentenceCueSource segments the
        // WHOLE buffer regardless of any active selector/satellite pair
        // or other span-bound DynDef (fluid-blank substitute, transform
        // rewrite). A sentence-cue cycling Up across one of those would
        // mid-overwrite the span â refuse to register the def at all if
        // there's overlap.
        const sat = this.selectorSatelliteState?.current;
        const overlapsSatellite = sat ? (start < sat.pairCharEnd && sat.pairCharStart < end) : false;
        let overlapsDynDef = false;
        for (const [, def] of this.dynDefs.entries()) {
          if (!def.blankName) continue;
          if (typeof def.spanStart !== 'number' || typeof def.spanEnd !== 'number') continue;
          if (def.spanEnd <= def.spanStart) continue;
          // Refreshing OUR OWN def (same sentence span, any key) is fine â
          // exempt the exact span so re-resolution doesn't self-collide.
          if (typeof def.blankName === 'string' && def.blankName.startsWith('sentence-cue:')
            && def.spanStart === start && def.spanEnd === end) continue;
          if (start < def.spanEnd && def.spanStart < end) { overlapsDynDef = true; break; }
        }
        if (overlapsSatellite || overlapsDynDef) {
          this.adapter.log('info', `SentenceCue[${r.source}]: skipping â sentence span [${start},${end}) overlaps an active managed span (satellite=${overlapsSatellite}, dyndef=${overlapsDynDef})`);
          continue;
        }

        // Register the DynDef passively. No splice; the buffer keeps
        // the original sentence. alts[0] === originalSentence so cycling
        // Up to currentIndex=1 swaps in the first rewrite via the
        // existing applyAltCycle path.
        this.dynDefs.set(regKey, {
          originalWord: originalSentence,
          alternatives: r.alternatives, // [original, ...rewrites]
          currentIndex: 0, // passive â buffer shows alts[0] (the original)
          spanStart: start,
          spanEnd: end,
          // blankName uses the source id (sentence-cue:<name>) so the
          // entry is locked against re-resolution AND distinguishable
          // from other span-bearing defs in logs / event traces.
          blankName: r.source,
          // Dynamic advisory (e.g. calendar-conflict heads-up) → surfaced in
          // the status line when the cursor sits in the span, no cycling.
          cueTip: r.cueTip,
        });
        wrote++;

        // Record claim for downstream word-cue suppression. Uses the
        // ORIGINAL word indices (the result list is in original-buffer
        // coords since we didn't splice). One entry per applied
        // sentence-cue â every claimed range suppresses word-cues inside
        // it (multi-sentence-cue lift, June 2026).
        const claimStart = r.wordIndex;
        const claimEnd = r.wordIndex + originalSentence.split(/\s+/).filter(Boolean).length - 1;
        sentenceClaims.push({ start: claimStart, end: claimEnd });

        this.adapter.log('info', `SentenceCue[${r.source}]: cue ready [${start},${end}) "${originalSentence.slice(0, 50)}â¦" (alts=${r.alternatives.length - 1}, defAt=${r.wordIndex}, claimWords=[${claimStart},${claimEnd}])`);
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

        // Race guard â if the live text no longer matches what we
        // analyzed, another module already touched it. Skip.
        // Compare ZWS-stripped to ignore runtime-internal toggles (e.g.
        // BlankLoading spinner ticks via pushText flip ZWS every frame on
        // CC 2.1.x to force a repaint; those toggles aren't user edits).
        const stripZw = (s: string): string => s.replace(/[\u200B\u200C]/g, '');
        if (stripZw(liveText) !== stripZw(originalText)) {
          this.adapter.log('info', `TransformBlank: skipping â live text changed since resolve (live len=${liveText.length}, original len=${originalText.length})`);
          continue;
        }

        // TASK COMMAND ROUTING â TASK_ARM/TASK_ADD/TASK_STOP/TASK_SHOW
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
        // target in originalText (the unmarked visible buffer) â
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
              // Span from earliest-of(target, trigger) â latest-of(target, trigger).
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
              // whitespace as separator. Splice covers target end â EOL.
              spliceStart = targetIdx;
              const remainder = originalText.slice(targetEnd);
              const separator = (remainder.match(/^\s*/)?.[0] ?? '').replace(/[ \t]+$/, '');
              spliceEnd = originalText.length;
              rewriteWithSeparator = rewrittenText + separator;
            }
          } else {
            // Sandwiched target â EXTRACT joined two halves with "\n"
            // but in originalText they're separated by the trigger
            // phrase. We replace ONLY the trigger phrase with "" and
            // each half with its modified rewrite â surrounding
            // structural whitespace (paragraph breaks) is preserved
            // exactly, including the now-empty trigger LINE itself.
            // Compose the final buffer here and splice it as one
            // [pt1Start, pt2End) operation.
            const sandwich = findSandwichedTarget(originalText, transformTarget, transformInstruction);
            if (sandwich) {
              spliceStart = sandwich.pt1Start;
              spliceEnd = sandwich.pt2End;
              // Split the LLM rewrite on its first `\n` â EXTRACT
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
              // The trigger LINE remains structurally â its surrounding
              // whitespace is intact and its text is just empty now.
              rewriteWithSeparator = pt1Mod + sepBeforeTrigger + sepAfterTrigger + pt2Mod;
            }
            // else: fall through to whole-body replace.
          }
        }


        // ââ Two substitute paths âââââââââââââââââââââââââââââââââââââââ
        //
        // Bounded-target (transformTarget set): the source rewrote ONLY
        // the target span, so the runtime splices [spliceStart, spliceEnd)
        // computed above. Structurally safe because the LLM only saw the
        // target as input â it can't produce content outside that span.
        // (TransformBlank's fused path does NOT set transformTarget â it
        // emits the whole buffer â so it always takes the merge path
        // below; this branch remains for any future bounded-span source.)
        //
        // Fused / whole-buffer (transformTarget empty/undefined): the
        // LLM emitted the WHOLE final buffer in FULL_REWRITE. We diff
        // (originalText â rewrittenText) and three-way-merge against
        // the live buffer so any in-flight user typing past the trigger
        // survives. No splice-scope ambiguity â duplication bug class
        // is structurally impossible (no concat tail to overrun).
        let bufferText: string;
        let sub: { newText: string; hadMarkdown: boolean };
        if (transformTarget && transformTarget.length > 0) {
          sub = applyMarkdownAwareSplice(
            this.adapter, originalText, spliceStart, spliceEnd, rewriteWithSeparator,
            { cursor: Number.MAX_SAFE_INTEGER },
          );
          bufferText = sub.newText;
        } else {
          // Strip ZWS from BOTH originalText and liveText before merging.
          // The spinner's per-frame pushText flips \u200B/\u200C to force a
          // host repaint, and threeWayMerge would otherwise see those toggles
          // as "user edits". Stripping only liveText (the prior attempt at
          // this fix) was worse: it made liveText differ from originalText
          // by 1 char (the ZWS), which the merge counted as a real user edit
          // at the trigger's last char position. The LLM's trigger-removal
          // hunk overlapped that fake edit â got dropped â the trigger
          // survived in the merged result. Stripping both inputs equally
          // lets the merge see the buffers as actually-equal modulo ZWS,
          // so no fake user-edits arise.
          const stripZw = (s: string): string => s.replace(/[\u200B\u200C]/g, '');
          // Pre-removal of the trigger phrase from BOTH originalText and
          // liveText. The fused-path LLM emits FULL_REWRITE without the
          // trigger; threeWayMerge then has to derive "remove the trigger"
          // from a word-level diff against originalText. When the trigger
          // sits on its own line after pre-existing content
          // (`...email body\n\ndraft an email _`), the surrounding
          // paragraph-break gap tokens straddle the trigger and the merge
          // emits multi-fragment hunks whose boundaries don't cleanly
          // wrap the trigger phrase â leaving parts of the summon text
          // ("draft an email" or just the `_`) parked in the merged
          // result. User-visible: "my summon text doesn't get deleted
          // when on another line". Pre-removing the trigger from both
          // merge inputs guarantees the merge never has to delete it on
          // its own â the trigger is simply absent from both sides.
          const trig = transformInstruction
            ? locateTrigger(originalText, transformInstruction, 0, 0)
            : null;
          let originalForMerge = stripZw(originalText);
          let liveForMerge = stripZw(liveText);
          if (trig) {
            const removeRange = (text: string, t: { start: number; end: number }): string => {
              // Also swallow a leading newline gap if the trigger occupies
              // its own line â otherwise the paragraph break before the
              // trigger is left dangling as a stray blank line in the
              // rewritten buffer.
              let start = t.start;
              while (start > 0 && (text[start - 1] === '\n' || text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
              return text.slice(0, start) + text.slice(t.end);
            };
            originalForMerge = stripZw(removeRange(originalText, trig));
            // The trigger should live at the same offsets in liveText
            // (resolveAndApply runs against a snapshot the LLM analyzed),
            // but be tolerant: only strip from live if the trigger phrase
            // is still there at the recorded position.
            const liveTrig = locateTrigger(liveText, transformInstruction!, 0, 0);
            if (liveTrig) liveForMerge = stripZw(removeRange(liveText, liveTrig));
          }
          const merge = threeWayMerge(originalForMerge, rewrittenText, liveForMerge);
          sub = applyMarkdownAwareSubstitution(
            this.adapter, merge.newText, { cursor: Number.MAX_SAFE_INTEGER },
          );
          bufferText = sub.newText;
          spliceStart = 0;
        }
        // Undo journal: what the user SAW (live buffer) â what landed.
        // diffSplice trims to the changed region, so even this whole-
        // buffer path records a relocatable hunk, not the full text.
        this.recordUndo('rewrite', liveText.replace(/[ââ]/g, ''), bufferText);

        // Find which word the rewrite's first word lands at in the new
        // text (for keying the def). Defaults to wherever the splice
        // inserted (spliceStart), which becomes the first word position
        // in the post-substitution text.
        const newWords = splitWords(bufferText);
        const firstSpliceWord = newWords.find(w => w.start >= spliceStart);
        const newWordIndex = firstSpliceWord ? firstSpliceWord.index : 0;
        // spanEnd MUST be the full bufferText length â the def's alternatives[0]
        // IS bufferText, so the span and the stored text have to agree. Using
        // the last WHITESPACE-word's end (the old behaviour) fell short whenever
        // the rewrite ended in trailing whitespace/newline, leaving the def
        // span shorter than its own text â the dim/highlight then stopped a
        // generation-dependent char or two before the real end (the trailing
        // ã / last chars not highlighted). Whole-buffer transform â spanStart 0,
        // spanEnd = full length.
        const newSpanEnd = bufferText.length;

        // Chain extension: if a prior transform-blank def's current alt
        // is still verbatim inside the pre-substitute buffer, the user
        // is doing a sequence of rewrites on the same content
        // (translate to japanese â translate to chinese). Extend the
        // existing chain in REVERSE chronological order â newest at
        // index 0 â so Up walks back through history one step at a
        // time (matching the convention every other blank type uses:
        // alts[0] = current visible, Up = +1 = next in cycle).
        // Truncate-on-branch: if the user cycled back mid-chain before
        // re-summoning, discard the abandoned head (items NEWER than
        // where the user landed â indices BELOW currentIndex in the
        // new reverse-chronological layout).
        const existingChain = this.dynDefs.findChainableLlmDef(
          originalText, 0, originalText.length, ['transform-blank'],
        );
        let transformDef: WordDef;
        let extendedFromIdx: number | null = null;
        if (existingChain) {
          const baseAlts = existingChain.def.alternatives
            .slice(existingChain.def.currentIndex);
          const chainedAlts = [bufferText, originalText, ...baseAlts];
          transformDef = {
            originalWord: existingChain.def.originalWord,
            alternatives: chainedAlts,
            currentIndex: 0,
            spanStart: 0,
            spanEnd: newSpanEnd,
            blankName: 'transform-blank',
          };
          extendedFromIdx = existingChain.wordIndex;
          if (existingChain.wordIndex !== newWordIndex) {
            this.dynDefs.delete(existingChain.wordIndex);
          }
          this.adapter.log('info', `TransformBlank: extending chain (depth=${chainedAlts.length}, prevWordIdx=${existingChain.wordIndex}, newWordIdx=${newWordIndex})`);
        } else {
          transformDef = {
            originalWord: originalText,
            // alternatives[0] = the post-substitution buffer (current visible)
            // alternatives[1] = original full text (cycle Up to revert)
            alternatives: [bufferText, originalText],
            currentIndex: 0,
            spanStart: 0,
            spanEnd: newSpanEnd,
            // blankName locks this def from re-resolution by the LLM â
            // same mechanism fluid-blank uses.
            blankName: 'transform-blank',
          };
        }
        // Prune stale defs the substitute invalidated.
        // (a) Sentence-cue defs were resolved against pre-substitute text;
        //     their spanStart/spanEnd indices now point at unrelated content
        //     in the new buffer â the dim ranges paint nonsense overlay.
        // (b) Any other def whose spanEnd > bufferText.length is out-of-range
        //     in the new buffer â keeping it is structurally meaningless.
        // Navigation's onTextChange short-circuits on runtime events, so it
        // doesn't run pruneStale for us. Substitute is the right place.
        let prunedCount = 0;
        for (const [idx, d] of this.dynDefs.entries()) {
          if (idx === newWordIndex) continue;            // keep the one we just set
          if (extendedFromIdx !== null && idx === extendedFromIdx) continue; // skip the old chain key (already deleted above if differing)
          const isSentenceCue = d.blankName?.startsWith('sentence-cue:') ?? false;
          const outOfRange = d.spanEnd !== undefined && d.spanEnd > bufferText.length;
          if (isSentenceCue || outOfRange) {
            this.dynDefs.delete(idx);
            prunedCount++;
          }
        }
        if (prunedCount > 0) {
          this.adapter.log('debug', `TransformBlank: pruned ${prunedCount} stale def(s) after substitute`);
        }

        this.dynDefs.set(newWordIndex, transformDef);
        wrote++;

        const previewLen = 60;
        const origPreview = originalText.length > previewLen ? originalText.slice(0, previewLen) + 'â¦' : originalText;
        const rewritePreview = bufferText.length > previewLen ? bufferText.slice(0, previewLen) + 'â¦' : bufferText;
        const markerNote = sub.hadMarkdown ? ', markdown stripped' : '';
        this.adapter.log('info', `TransformBlank: substituting "${origPreview}" â "${rewritePreview}" (origLen=${originalText.length}, rewriteLen=${bufferText.length}${markerNote}, defAt=${newWordIndex}, totalMs=${Date.now() - __resolveStart})`);

        // Fire `transform-blank.completed` AFTER the buffer commit so
        // that observers (statusline, agentic tests) can rely on the
        // event marking a final, user-visible buffer state â never an
        // intermediate loading-animation frame. The source's pipeline
        // latency rides through via metadata.pipelineLatencyMs; this
        // structurally closes the race that allowed the braille
        // loading char (â /â /â¦) to be caught between completion of the
        // LLM call and the resolver's substitute commit.
        const pipelineLatencyMs = (r.metadata?.pipelineLatencyMs as number | undefined) ?? (Date.now() - __resolveStart);
        this.adapter.emitEvent?.('transform-blank.completed', {
          finalLen: bufferText.length,
          finalPreview: rewritePreview,
          latencyMs: pipelineLatencyMs,
        });
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
      // `DynDefs.set` enforces the managed-span ownership invariant centrally:
      // a plain word-cue whose span overlaps an active managed owner (transform/
      // fluid/config-intent/sentence-cue/blank) is REJECTED, so it can't fight
      // the owner on re-resolve/cycle ("the blank span breaks when I edit", and
      // word-cues claiming inner words of a persisted sentence-cue span). The
      // owner can sit at a different word index â span-overlap, not index, is
      // the test. set() returns false when it rejects.
      if (!this.dynDefs.set(r.wordIndex, def)) {
        this.adapter.log('debug', `Resolver: word-cue at [${def.spanStart},${def.spanEnd}) rejected â inside an active managed span`);
        continue;
      }
      wrote++;
    }
    // Force a paint so DimRender/Statusline pick up the new alts without
    // waiting for the user's next keystroke. Hosts with no idle render
    // loop (e.g. OpenCode's onContentChange-only path) need this.
    if (wrote > 0) this.adapter.forceRender();

    // Close any config-intent transaction whose buffer splice never
    // landed (race-bail path, or the result was dropped downstream).
    // The scalar DID change at emit time, so a scalar-only transaction
    // is correct â undo still reverts the setting.
    this.commitPendingConfigIntentTx();
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
// "protection" â its full-rewrite + three-way-merge architecture
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
 * Locate a sandwiched target â two halves joined by "\n" in EXTRACT's
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
  // supplied â it's robust to agent-edited trigger words (e.g. agent
  // translated `agentically` â `agentisch` in the visible buffer; the
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
  // each flank â preserving newlines so paragraph structure
  // ("para1\n\nstop task _\n\npara2") survives. Insert ONE space at the
  // join only when both sides end up non-whitespace (mid-sentence
  // trigger) so we don't run words together.
  const before = visibleText.slice(0, start).replace(/ +$/, '');
  const after = visibleText.slice(blankIdx + 1).replace(/^ +/, '');
  const needsSpace = before.length > 0 && after.length > 0
    && !/\s$/.test(before) && !/^\s/.test(after);
  return needsSpace ? `${before} ${after}` : `${before}${after}`;
}
