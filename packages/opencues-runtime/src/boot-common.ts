// Shared host-bootstrap helpers — keeps the per-host adapter boot.ts files
// from drifting on state-class wiring or universal-module subscription
// order. Each adapter band still owns:
//   - the HostAdapter implementation (DOM vs node:* vs OpenTUI)
//   - the bindings → adapter construction
//   - the per-host log function + isDebugEnabled gating
//   - any conditional optional modules whose construction shape differs
//     between hosts (Statusline file path vs in-process hook, TTS script
//     vs speakFn, Resolver httpAdapter override, etc.)
//
// Everything below is identical across hosts and lives here once. If you
// add a new universal state class or a module that always wires the same
// way regardless of host, put it here so both adapters pick it up at the
// same time.
//
// Tested via the existing Navigation/DimRender/Cycling/BlankFill module
// suites that already exercise the wiring against MockAdapter — adding a
// boot-common-specific test would mostly duplicate them.

import type { HostAdapter, LogLevel } from './adapter';
import type { ResolvedAgentLLM } from './modules/agent-rewrite';


/* ─── Source reclassification helper ─────────────────────────────────────
 *
 * Both bootstraps need the same shape: stash text the runtime wrote,
 * then reclassify subsequent text-change events as source='runtime' if
 * the text matches a recent stash. Multi-shot within a short TTL
 * window — DOM reconciliation pipelines (Lexical, ProseMirror,
 * Gmail's compose) fire MULTIPLE input events per programmatic write,
 * and a single-shot reclassifier only catches the first.
 *
 * Bug history (May 2026): with one-shot matching, the FIRST input
 * event from a TransformBlank substitute was reclassified to
 * 'runtime' and skipped by the Resolver. The SECOND+ echo events (from
 * MutationObserver-triggered re-renders) arrived after the stash was
 * cleared and got tagged 'user'. The Resolver then processed them
 * normally, fired the `_`-pipeline on the runtime's own substituted
 * buffer (which often still contained a `_` the LLM had failed to
 * strip), and produced a runaway loop — one user `_ trigger` → 4+
 * full ConfigIntent+TransformBlank+FluidBlank cycles in 7 seconds
 * observed on chrome.
 *
 * Multi-shot fix: keep a list of recent writes, TTL them out after
 * 250ms (long enough to cover the typical 10-150ms DOM echo window,
 * short enough that a user typing the exact same content moments
 * later isn't misclassified).
 *
 * Hosts call markRuntimeWrite(text) inside their setText/pushText, and
 * reclassify(text, source) inside their notifyOpenCuesTextChange.
 */
export interface SourceReclassifier {
  /** Stash text written by the runtime so subsequent matching input
   *  events flip source to 'runtime' (within the TTL window). Hosts
   *  whose write path normalises whitespace (chrome's execCommand)
   *  should call this AFTER the write with the actual post-DOM text. */
  markRuntimeWrite(text: string): void;
  /** Returns 'runtime' when the incoming text matches a recent marked
   *  runtime write (within RUNTIME_WRITE_TTL_MS), otherwise the
   *  proposed source. */
  reclassify(text: string, proposedSource: 'user' | 'runtime'): 'user' | 'runtime';
}

/** Time window in which subsequent matching input events are still
 *  reclassified to 'runtime'. 250ms covers the typical DOM-echo
 *  window (50-200ms on Gmail/Lexical/PM) with margin, while staying
 *  well under any realistic gap between a runtime substitute and a
 *  user typing the identical text manually. */
export const RUNTIME_WRITE_TTL_MS = 250;

export function createSourceReclassifier(now: () => number = Date.now): SourceReclassifier {
  const recent: Array<{ text: string; addedAt: number }> = [];

  function pruneStale(t: number): void {
    const cutoff = t - RUNTIME_WRITE_TTL_MS;
    while (recent.length > 0 && recent[0].addedAt < cutoff) recent.shift();
  }

  return {
    markRuntimeWrite(text: string): void {
      const t = now();
      pruneStale(t);
      recent.push({ text, addedAt: t });
    },
    reclassify(text: string, proposedSource: 'user' | 'runtime'): 'user' | 'runtime' {
      const t = now();
      pruneStale(t);
      // Multi-shot match WITHOUT consumption — a single runtime write
      // can produce multiple DOM-echo input events (Gmail compose
      // fires 2-4; ProseMirror's reconciler can fire more). All of
      // them carry the same text; all of them need to reclassify to
      // 'runtime' so the Resolver skips the entire batch. Consuming
      // on first match leaves the remaining echoes mislabeled as
      // 'user', which was the May 2026 runaway-loop bug. Stale
      // entries age out via pruneStale's TTL.
      if (recent.some(w => w.text === text)) return 'runtime';
      return proposedSource;
    },
  };
}

/* ─── Log factory ────────────────────────────────────────────────────────
 *
 * Both bootstraps build a log function that:
 *  - gates 'debug' through `isDebugEnabled` (reads OPENCUES.md
 *    debug-mode lazily so a popup/file edit can toggle it without
 *    restart),
 *  - delegates everything else to a host-supplied sink (console on
 *    chrome, fs.appendFileSync on opencode).
 *
 * This factory just composes those two pieces.
 */
export interface LogFactoryOptions {
  /** Host-supplied sink. Errors thrown by the sink are swallowed so
   *  flaky logging can't crash the runtime. */
  readonly sink: (level: LogLevel, msg: string, data?: unknown) => void;
  /** Lazy debug gate. Re-evaluated on every log call so OPENCUES.md
   *  hot-reloads pick up new debug-mode without restart. */
  readonly isDebugEnabled?: () => boolean;
}

export function createLogFunction(
  opts: LogFactoryOptions,
): (level: LogLevel, msg: string, data?: unknown) => void {
  const { sink, isDebugEnabled } = opts;
  return (level, msg, data) => {
    // No gate supplied = all levels pass through (caller opted out of
    // gating). When supplied, debug is dropped unless the gate returns
    // true. Re-evaluated per call so OPENCUES.md hot-reloads pick up
    // a flipped debug-mode without restart.
    if (level === 'debug' && isDebugEnabled !== undefined && !isDebugEnabled()) return;
    try { sink(level, msg, data); } catch { /* swallow */ }
  };
}
import { ConfigLoader } from './modules/config-loader';

/**
 * Build the AgentRewrite `resolveLLM` thunk for boot files. Reads the
 * current `agent-provider:` / `agent-model:` / `agent-endpoint:`
 * OPENCUES.md frontmatter (with falls-through to global `llm-provider:`
 * / `llm-model:` / `llm-endpoint:`), looks up the right ProviderAdapter
 * from @opencues/core, and returns the resolved tuple. Returns null
 * when no key is available for the resolved provider, OR when
 * @opencues/core can't be require()'d (rare — usually a packaging
 * misstep). The runtime falls back to its built-in Groq-shaped path
 * in that case.
 *
 * Re-resolves on every tick (callers wrap this in an arrow), so
 * OPENCUES.md hot-reload propagates without an integration restart.
 */
export function buildAgentLLMResolver(
  configLoader: ConfigLoader,
  apiKeys: Readonly<Record<string, string | undefined>>,
): ResolvedAgentLLM | null {
  let core: { resolveLLM?: (opts: unknown) => unknown } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    core = require('@opencues/core');
  } catch {
    return null;
  }
  if (!core?.resolveLLM) return null;
  const s = configLoader.opencuesState.settings;
  const out = core.resolveLLM({
    featureProvider: s.get('agent-provider'),
    featureModel: s.get('agent-model'),
    endpointOverride: s.get('agent-endpoint') ?? s.get('llm-endpoint'),
    globalProvider: s.get('llm-provider'),
    globalModel: s.get('llm-model'),
    apiKeys,
  }) as ResolvedAgentLLM | null;
  return out;
}
import { Navigation } from './modules/navigation';
import { DimRender } from './modules/dim-render';
import { Cycling } from './modules/cycling';
import { BlankFill } from './modules/blank-fill';
import { BlankLoadingAnimator, parseCustomFrames, parseRgbColors, parseAnsiColors, parseFrameIntervalMs, DEFAULT_RGB_PALETTE, DEFAULT_ANSI_PALETTE } from './modules/blank-loading';
import { MarkdownRender } from './modules/markdown-render';
import { HighlightState } from './state/highlight-state';
import { DynDefs } from './state/dyn-defs';
import { SpanFillState } from './state/span-fill';
import { DismissedBlanks } from './state/dismissed-blanks';
import { SelectorSatelliteState } from './state/selector-satellite';
import { AgentTaskState } from './state/agent-task';

/** State + ConfigLoader the optional modules (Statusline / TTS / Resolver
 *  / CursorStateExport) and the host's BootResult need access to. */
export interface SharedRuntime {
  readonly configLoader: ConfigLoader;
  readonly hlState: HighlightState;
  readonly dynDefs: DynDefs;
  readonly spanFillState: SpanFillState;
  readonly dismissedBlanks: DismissedBlanks;
  readonly selectorSatelliteState: SelectorSatelliteState;
  readonly agentTaskState: AgentTaskState;
  /** Shared loading-glyph animator for in-flight `_` slots. Passed to
   *  BlankFill (keyword-bound slots) and to Resolver (Fluid/Transform
   *  slots) so both code paths share state and don't race. */
  readonly blankLoading: BlankLoadingAnimator;
  /** Markdown overlay renderer — parses **bold** / *italic* / `code`
   *  etc. on LLM-substitution events and emits per-range directives
   *  the host's render pipeline picks up. */
  readonly markdownRender: MarkdownRender;
}

export interface BuildSharedRuntimeOptions {
  /** Same log function the host uses. Errors from ConfigLoader.load
   *  + BlankFill.subscribe wiring flow through it. */
  readonly log: (level: LogLevel, msg: string, data?: unknown) => void;
  /** Search paths for `.cues/` config dirs, in priority order
   *  (project first, user second). Falls back to `[adapter.cwd]` when
   *  unset for backwards compat. See ConfigLoaderOptions. */
  readonly configSearchPaths?: readonly string[];
  /** Path to `OPENCUES.md` (user-level runtime config, frontmatter
   *  format). When unset, settings stay at runtime defaults. */
  readonly settingsFile?: string;
}

/**
 * Native-host error formatter shared by CC / OC / gemini-cli / terminal
 * — chrome supplies its own (popup-specific phrasing). The messages
 * mention `~/.cues/.env` + shell env because that's where native hosts
 * read keys + scalars from. Returns the in-buffer text the runtime
 * substitutes for the failed `_`.
 *
 * Wired by each non-chrome boot via `ResolverOptions.formatLLMErrorAsSubstitute`.
 * Resolver hands every classified user-actionable HTTP failure
 * (401/403/404/429/400/network) through this function; LLM-internal
 * errors (no-span, malformed JSON, 5xx) stay silent unconditionally.
 */
export function nativeHostFormatLLMError(
  reason: 'invalid-api-key' | 'network' | 'rate-limit' | 'endpoint-not-found' | 'bad-request',
  err?: Error,
): string {
  // Best-effort extract the provider's own error body. Bench-tuned regex
  // matches `"message":"..."` / `"error":"..."` shapes — falls back to
  // the raw error message.
  const detail = err?.message?.match(/"(?:message|error)":\s*"([^"]+)"/)?.[1]
    ?? err?.message?.slice(0, 180);
  const suffix = detail ? ` — ${detail}` : '';
  switch (reason) {
    case 'invalid-api-key':    return '[OpenCues: API key rejected (401/403) — re-export the provider\'s API key in your shell env (or ~/.cues/.env)]';
    case 'endpoint-not-found': return '[OpenCues: provider endpoint returned 404 — check `llm-endpoint:` in ~/.cues/OPENCUES.md]';
    case 'rate-limit':         return '[OpenCues: provider rate-limit hit (429) — wait a moment or switch `llm-provider:` in OPENCUES.md]';
    case 'network':            return '[OpenCues: network error — provider unreachable. Check connectivity, then retry.]';
    case 'bad-request':        return `[OpenCues: provider returned 400 (bad request)${suffix}. Check the llm-model: you set in OPENCUES.md matches the chosen provider]`;
  }
}

/**
 * Native-host no-key fallback message — wired by CC / OC / gemini-cli
 * / terminal boots via `ResolverOptions.missingKeyFallbackMessage`. Used
 * when the user types `_` AND no LLM source could be wired (zero keys).
 * Chrome supplies its own (popup-specific phrasing).
 */
export const NATIVE_HOST_MISSING_KEY_MESSAGE =
  '[OpenCues: no API key — set CEREBRAS_API_KEY (or another provider\'s key) in ~/.cues/.env or your shell env]';

/**
 * Construct ConfigLoader, every state class, and subscribe the universal
 * modules (Navigation, DimRender, Cycling, BlankFill). Hosts call this
 * after building the adapter — the returned SharedRuntime is then handed
 * to optional modules they wire conditionally (Statusline / TTS / etc.).
 *
 * Module subscription order matches the original per-host boot.ts files —
 * any reordering should happen here so both bands change together.
 */
export function buildSharedRuntime(
  adapter: HostAdapter,
  opts: BuildSharedRuntimeOptions,
): SharedRuntime {
  const { log, configSearchPaths, settingsFile } = opts;

  // ConfigLoader first — every other module depends on it. load() runs
  // async; modules tolerate the empty pre-load window.
  const configLoader = new ConfigLoader(adapter, { configSearchPaths, settingsFile });
  configLoader.subscribe();
  configLoader.load().catch(err => log('error', 'ConfigLoader.load failed', err));

  // State classes. Order is dependency-irrelevant but matches the
  // historical declaration order in both per-host boot.ts files.
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const spanFillState = new SpanFillState();
  const dismissedBlanks = new DismissedBlanks();
  const selectorSatelliteState = new SelectorSatelliteState();
  const agentTaskState = new AgentTaskState();

  // Universal modules — wired identically on every host.
  const navigation = new Navigation(
    adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState,
  );
  navigation.subscribe();

  const dimRender = new DimRender(
    adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState,
  );
  dimRender.subscribe();

  const cycling = new Cycling(
    adapter, hlState, dynDefs, configLoader,
    spanFillState, dismissedBlanks, selectorSatelliteState,
  );
  cycling.subscribe();

  // Shared loading-animation owner. Used by both BlankFill (keyword-
  // bound slots like `volume _`) and the Resolver (TransformBlank +
  // FluidBlank slots like `make this shorter _` and `capital of france _`).
  // One instance keeps the animation timer + state coherent — without
  // it BlankFill and Resolver would each spin their own and race on
  // shared slots.
  const blankLoading = new BlankLoadingAnimator({
    adapter,
    mode: () => {
      const raw = configLoader.opencuesState.settings.get('blank-loading-animation');
      if (raw === 'off' || raw === 'braille-rotate' || raw === 'flipper' || raw === 'custom') return raw;
      return 'bounce';
    },
    customFrames: () => parseCustomFrames(
      configLoader.opencuesState.settings.get('blank-loading-frames'),
    ),
    rgbColors: () => parseRgbColors(
      configLoader.opencuesState.settings.get('blank-loading-colors-rgb'),
    ) ?? DEFAULT_RGB_PALETTE,
    ansiColors: () => parseAnsiColors(
      configLoader.opencuesState.settings.get('blank-loading-colors-ansi'),
    ) ?? DEFAULT_ANSI_PALETTE,
    frameIntervalMs: () => parseFrameIntervalMs(
      configLoader.opencuesState.settings.get('blank-loading-interval-ms'),
    ),
    log: msg => log('debug', msg),
  });

  // Register the animator as a render handler so its per-frame colours
  // flow through the existing RenderDirectives pipeline. The host picks
  // ansi vs rgb by capability (`render-rgb-color` advertises full
  // colour support — chrome only at the moment). Without that
  // capability, default to ANSI which works for every terminal host.
  const wantsRgb = adapter.capabilities.includes('render-rgb-color');
  adapter.onRender((ctx) => {
    const ranges = blankLoading.getActiveColoredRanges(ctx.text, wantsRgb ? 'rgb' : 'ansi');
    if (ranges.length === 0) return null;
    return {
      coloredRanges: ranges.map(r => ({
        start: r.start,
        end: r.end,
        ...(wantsRgb ? { rgb: r.color } : { ansi: r.color }),
      })),
    };
  });

  // BlankFill subscribes only after ConfigLoader.load resolves so its
  // initial scan sees the populated blanksByWord map. Same pattern
  // both hosts had inline.
  const blankFill = new BlankFill(
    adapter, configLoader, spanFillState, dismissedBlanks, selectorSatelliteState, dynDefs, blankLoading,
  );
  configLoader.load()
    .then(() => blankFill.subscribe())
    .catch(err => log('error', 'BlankFill: deferred subscribe failed', err));

  // MarkdownRender — receives `markdown.styled` events from substituting
  // modules and exposes the per-style ranges as RenderDirectives. The
  // strip happens in markdown-substitute.ts at write time; MarkdownRender
  // is purely a directive-emitter.
  const markdownRender = new MarkdownRender(adapter);
  markdownRender.subscribe();

  return {
    configLoader,
    hlState,
    dynDefs,
    spanFillState,
    dismissedBlanks,
    selectorSatelliteState,
    agentTaskState,
    blankLoading,
    markdownRender,
  };
}

/* ─── Per-buffer state reset ─────────────────────────────────────────────
 *
 * Wipe the state objects whose contents are bound to specific character
 * offsets / word indices in the live buffer. Callers fire this whenever
 * an external mutation has invalidated those offsets:
 *
 *   - Chrome content script — focus change between fields (each field
 *     is its own buffer with its own word indices), AND buffer-replacing
 *     input events (undo / redo / paste / IME commit / native autocomplete).
 *   - Native hosts — TBD per host. Terminal undo, paste, and any host-
 *     UI write that bypasses the runtime's setText pipeline qualify.
 *
 * What gets cleared:
 *   dynDefs                — leftover word-position entries either render
 *                            phantom highlights or block legit substitutions
 *                            (the May 2026 "first `_` doesn't work" bug).
 *   hlState                — stale highlight pointer renders the wrong
 *                            word as "current" until the user moves caret.
 *   spanFillState          — in-flight span-fill from the prior buffer
 *                            state would splice into the new text at the
 *                            same character range.
 *   selectorSatelliteState — mid-cycle on a settings selector would resume
 *                            against the wrong buffer (wrong-buffer settings
 *                            writes).
 *
 * Deliberately NOT cleared (session-scoped, not buffer-scoped):
 *   agentTaskState  — armed `agentically X _` task survives so users can
 *                     leave a draft, tab away, return without re-arming.
 *   dismissedBlanks — dismissing `weather _` once stays dismissed for the
 *                     session; undo shouldn't resurrect the suggestion.
 *
 * Resolver re-runs on the next keystroke debounce — the user sees a clean
 * buffer briefly, then cues repopulate. Acceptable UX cost vs. the silent
 * desync that partial reconciliation would produce.
 *
 * Idempotent — safe to call repeatedly (focus-change spam, input-event
 * bursts during paste or IME composition).
 *
 * Signature takes a minimal structural type, not `SharedRuntime`, so the
 * CC v2.1 boot (which builds its state classes inline rather than via
 * `buildSharedRuntime`) can pass the same locals it already has — every
 * band stays in lockstep on the wipe set without forcing CC to also
 * adopt SharedRuntime.
 */
export function resetSharedBufferState(state: {
  readonly dynDefs: Pick<DynDefs, 'clear'>;
  readonly hlState: Pick<HighlightState, 'deactivate'>;
  readonly spanFillState: Pick<SpanFillState, 'clear'>;
  readonly selectorSatelliteState: Pick<SelectorSatelliteState, 'clear'>;
}): void {
  state.dynDefs.clear();
  state.hlState.deactivate();
  state.spanFillState.clear();
  state.selectorSatelliteState.clear();
}
