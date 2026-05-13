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
 * Both bootstraps need the same shape: stash the text the runtime just
 * wrote, then reclassify the next text-change event as source='runtime'
 * if its text matches the stash. One-shot — cleared after match so a
 * later identical user-typed text isn't misclassified.
 *
 * Hosts call markRuntimeWrite(text) inside their setText/pushText, and
 * reclassify(text, source) inside their notifyOpenCuesTextChange.
 */
export interface SourceReclassifier {
  /** Stash text written by the runtime so the next input event flips
   *  source to 'runtime'. Hosts whose write path normalises whitespace
   *  (chrome's execCommand) should call this AFTER the write with the
   *  actual post-DOM text. */
  markRuntimeWrite(text: string): void;
  /** Returns 'runtime' when the incoming text matches the last marked
   *  runtime write, otherwise the proposed source. Clears the stash on
   *  match. */
  reclassify(text: string, proposedSource: 'user' | 'runtime'): 'user' | 'runtime';
}

export function createSourceReclassifier(): SourceReclassifier {
  let lastRuntimeSetText: string | null = null;
  return {
    markRuntimeWrite(text: string): void {
      lastRuntimeSetText = text;
    },
    reclassify(text: string, proposedSource: 'user' | 'runtime'): 'user' | 'runtime' {
      if (lastRuntimeSetText !== null && text === lastRuntimeSetText) {
        lastRuntimeSetText = null;
        return 'runtime';
      }
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
 * current `agent-provider:` / `agent-model:` / `agent-endpoint:` CUES.md
 * frontmatter (with falls-through to global `llm-provider:` /
 * `llm-model:` / `llm-endpoint:`), looks up the right ProviderAdapter
 * from @opencues/core, and returns the resolved tuple. Returns null
 * when no key is available for the resolved provider, OR when
 * @opencues/core can't be require()'d (rare — usually a packaging
 * misstep). The runtime falls back to its built-in Groq-shaped path
 * in that case.
 *
 * Re-resolves on every tick (callers wrap this in an arrow), so
 * CUES.md hot-reload propagates without an integration restart.
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
import { BlankLoadingAnimator, parseCustomFrames, parseRgbColors, parseAnsiColors } from './modules/blank-loading';
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
    ),
    ansiColors: () => parseAnsiColors(
      configLoader.opencuesState.settings.get('blank-loading-colors-ansi'),
    ),
    log: msg => log('debug', msg),
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
