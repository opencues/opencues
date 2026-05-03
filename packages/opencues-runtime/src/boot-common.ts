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
 *  - gates 'debug' through `isDebugEnabled` (reads opencues.md
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
  /** Lazy debug gate. Re-evaluated on every log call so opencues.md
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
    // true. Re-evaluated per call so opencues.md hot-reloads pick up
    // a flipped debug-mode without restart.
    if (level === 'debug' && isDebugEnabled !== undefined && !isDebugEnabled()) return;
    try { sink(level, msg, data); } catch { /* swallow */ }
  };
}
import { ConfigLoader } from './modules/config-loader';
import { Navigation } from './modules/navigation';
import { DimRender } from './modules/dim-render';
import { Cycling } from './modules/cycling';
import { BlankFill } from './modules/blank-fill';
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
}

export interface BuildSharedRuntimeOptions {
  /** Same log function the host uses. Errors from ConfigLoader.load
   *  + BlankFill.subscribe wiring flow through it. */
  readonly log: (level: LogLevel, msg: string, data?: unknown) => void;
  /** Search paths for `.cues/` config dirs, in priority order
   *  (project first, user second). Falls back to `[adapter.cwd]` when
   *  unset for backwards compat. See ConfigLoaderOptions. */
  readonly configSearchPaths?: readonly string[];
  /** Path to `.opencuesrc` (user-level rc-style runtime config). When
   *  unset, settings stay at runtime defaults. */
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

  // BlankFill subscribes only after ConfigLoader.load resolves so its
  // initial scan sees the populated blanksByWord map. Same pattern
  // both hosts had inline.
  const blankFill = new BlankFill(
    adapter, configLoader, spanFillState, dismissedBlanks, selectorSatelliteState, dynDefs,
  );
  configLoader.load()
    .then(() => blankFill.subscribe())
    .catch(err => log('error', 'BlankFill: deferred subscribe failed', err));

  return {
    configLoader,
    hlState,
    dynDefs,
    spanFillState,
    dismissedBlanks,
    selectorSatelliteState,
    agentTaskState,
  };
}
