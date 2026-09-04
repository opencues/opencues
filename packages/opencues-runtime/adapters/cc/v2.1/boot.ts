// Single entry point for the Claude Code v2.1 host bootstrap.
//
// The tweakcc patch's only job is to:
//   1. require() this module from cli.js's createRequire context.
//   2. Call boot(hostInfo) once on first key dispatch.
//   3. Use the returned BootResult helpers from the KeyDispatcher and
//      from the wrapped renderedValue expression.
//
// Everything else — adapter construction, state, module subscription,
// Runtime lifecycle, error capture — lives here. That keeps the patch
// surface tiny and decouples the runtime's internal layout from the patch.

import { Runtime } from '../../../src/runtime';
import { buildBootApiKeys, pickAutoProvider } from '@opencues/core';
import { ClaudeCodeV21Adapter, type HostBindings, normaliseKeyEvent, toggleZeroWidth } from './adapter';
import { installMacDoubleEscStdinRewrite } from '../../../src/modules/mac-keyboard';
import { locateViewportSlice, translateDirectivesToViewport } from './viewport';
import { Navigation } from '../../../src/modules/navigation';
import { DimRender } from '../../../src/modules/dim-render';
import { Cycling } from '../../../src/modules/cycling';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { Statusline } from '../../../src/modules/statusline';
import { KataCoach } from '../../../src/modules/kata';
import { TTS } from '../../../src/modules/tts';
import { Resolver } from '../../../src/modules/resolver';
import { AgentRewrite } from '../../../src/modules/agent-rewrite';
import { BlankFill } from '../../../src/modules/blank-fill';
import { BlankLoadingAnimator, parseCustomFrames, parseRgbColors, parseAnsiColors, parseFrameIntervalMs, DEFAULT_RGB_PALETTE, DEFAULT_ANSI_PALETTE } from '../../../src/modules/blank-loading';
import { GlimmerRender, parseGlimmerTransitionMs } from '../../../src/modules/glimmer-render';
import { MarkdownRender } from '../../../src/modules/markdown-render';
import { CursorStateExport } from '../../../src/modules/cursor-state-export';
import { HighlightState } from '../../../src/state/highlight-state';
import { DynDefs } from '../../../src/state/dyn-defs';
import { SpanFillState } from '../../../src/state/span-fill';
import { DismissedBlanks } from '../../../src/state/dismissed-blanks';
import { createSourceReclassifier, resetSharedBufferState } from '../../../src/boot-common';
import { SelectorSatelliteState } from '../../../src/state/selector-satellite';
import { AgentTaskState } from '../../../src/state/agent-task';
import { UndoJournal } from '../../../src/state/undo-journal';
import { applyDirectives } from '../../../src/render-directives';
import { buildAgentLLMResolver, identityDehydrationFor, buildKataLLMResolver, buildBlankContextProvider, buildBlankFetchProvider, buildCalendarContextIngest, buildSessionCommitmentsIngest, startCueDismissals, startSessionCommitmentsKick, locateNewestCCTranscript, startUsageMeter, buildCyclingProviderProbe, checkRuntimeDrift, NATIVE_HOST_MISSING_KEY_MESSAGE, nativeHostFormatLLMError } from '../../../src/boot-common';
import { buildBlankWeaver } from '../../../src/modules/blank-weave';
import { startEventBridge } from '../../../src/event-bridge';
import type {
  BlankInvokeSpec,
  KeyEvent,
  LogLevel,
  ProcessHandle,
  ProcessSpec,
  RenderContext,
  RenderDirectives,
  TextChangeEvent,
  CursorChangeEvent,
  Unsubscribe,
} from '../../../src/adapter';

/**
 * Columns Claude Code prepends to the input's FIRST line that a continuation
 * line does NOT get. For Claude Code that is ZERO: the `❯ ` prompt indents the
 * first line, and CC's input box indents the continuation lines by the same
 * amount, so an injected note line already starts at the span's own frame.
 *
 * IT WAS 2 UNTIL 2026-08-16, and the reason is worth keeping because it was
 * two errors cancelling. The comment here claimed continuation lines got no
 * indent, so the pad added the prompt width back — and the old note rule then
 * subtracted the `↳ ` connector's two cells to put the MESSAGE under the span.
 * The two cancelled: on screen the ARROW landed on the span's column and the
 * message sat two cells past it, which is what CC has always shown and why
 * nobody noticed the runtime was nominally message-aligned. When the runtime
 * moved to aligning the CONNECTOR (render-directives.ts), the subtraction went
 * and the addition was left double-counting: the arrow appeared two cells INTO
 * the word. Zero is the honest value, and it agrees with the OpenTUI hosts,
 * which never had a compensation.
 *
 * Still tunable live via `OPENCUES_CC_NOTE_INDENT` (no rebuild — export it and
 * restart) for a host whose box does indent only the first line.
 */
const CC_INPUT_FIRST_LINE_INDENT: number = (() => {
  const raw = typeof process !== 'undefined' ? process.env?.OPENCUES_CC_NOTE_INDENT : undefined;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

/** Minimal host info the patch supplies. boot() builds HostBindings from it. */
export interface HostInfo {
  readonly hostVersion: string;
  readonly cwd: string;
  /** Optional registry of built-in blank instances. When supplied, the
   *  runtime constructs a blank-as-context provider that snapshots
   *  context-eligible blanks (those with `as-context: safe|raw` in
   *  BLANK.md) as ambient tokens for fluid-blank. Without this map,
   *  `blank-context-mode` in OPENCUES.md is silently inert. */
  blanks?: ReadonlyMap<string, import('../../../src/blanks/types').Blank>;
  /** Snapshot of the current input text. */
  getText(): string;
  /** Snapshot of the current cursor offset. */
  getCursorOffset(): number;
  /** Optional: read a file. Used by ConfigLoader for the tips JSON + cwd .md files. */
  readFile?(path: string): Promise<string | null>;
  /** Optional: list directory entries. Used by ConfigLoader for folder discovery. */
  readDir?(path: string): Promise<readonly { name: string; isDirectory: boolean }[] | null>;
  /** Optional: write a file. Used by Statusline for the export JSON. */
  writeFile?(path: string, content: string): Promise<void>;
  /** Optional: spawn a child process. Used by TTS for fire-and-forget speak. */
  spawnProcess?(spec: ProcessSpec): ProcessHandle;
  /**
   * Optional host-native blank dispatch. BlankFill + Cycling try this
   * BEFORE spawnProcess so the shared TS blanks (HackerNewsBlank,
   * etc. — see opencues-runtime/src/blanks/) win over the legacy shell
   * scripts in blanks/. Returns null when the blankName isn't in
   * the host's registry; runtime falls through to spawnProcess.
   */
  blankInvoke?(spec: BlankInvokeSpec): ProcessHandle | null;
  /** Optional: async text push (calls captured onChange + onOffsetChange). */
  pushText?(text: string, cursor?: number): void;
  /**
   * Optional: parent-component React-state bumper. When the patch's S7
   * seam is wired, this calls the InputZone-parent's `useState` setter,
   * forcing a parent re-render without changing the buffer. Used for
   * Navigation highlight moves + any other pure-redraw trigger. Falls
   * back to host.pushText(lastSeenText) when undefined.
   */
  forceRender?(): void;
  /** Optional: absolute path to the TTS script (CC ships speak.sh + SpeakCtl.exe colocated in <CC_FORK>/.cues/scripts/). */
  ttsScriptPath?: string;
  /** Optional: TTS rate (-10 to 10) passed as 2nd arg to the script. Defaults to 2. */
  ttsRate?: number;
  /** Optional: LLM API key (e.g. GROQ_API_KEY). Resolver only runs when provided. */
  llmApiKey?: string;
  /** Optional: LLM endpoint URL. Defaults to Groq's chat completions endpoint. */
  llmEndpoint?: string;
  /** Optional: default LLM model name. */
  llmDefaultModel?: string;
  /** Optional: resolver debounce ms (defaults to 500). */
  llmDebounceMs?: number;
  /**
   * Optional: API keys keyed by provider env-var name
   * (GROQ_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY).
   * The patch reads `process.env` and forwards whichever keys are set;
   * the runtime picks the right one based on OPENCUES.md `llm-provider:` /
   * `<feature>-provider:` settings. Legacy `llmApiKey` is still accepted
   * and registered as GROQ_API_KEY when this map isn't supplied.
   */
  llmApiKeys?: Readonly<Record<string, string | undefined>>;
  /** Optional: absolute path for the statusline state-export JSON. */
  statusFilePath?: string;
  /**
   * Optional: absolute path for the cursor-state-export JSON
   * (e.g. /tmp/opencues-cursor-state-<pid>.json). No in-tree consumer;
   * external tooling can read it. When unset, the runtime doesn't
   * write anything.
   */
  cursorStatePath?: string;
  /**
   * Optional: trigger the host to re-display the statusline export.
   * On CC v2.1, supplied by the patch as a closure that calls the captured
   * `globalThis.__oc_refreshHostStatusline` (S6 seam). When present,
   * Statusline calls this after every successful write.
   */
  refreshStatusline?(): void;
  /** Optional logger. */
  log?(level: LogLevel, msg: string, data?: unknown): void;
}

/** Raw key event from the host (Ink-style flag names are tolerated). */
export interface RawKeyEvent {
  key?: string;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  option?: boolean;
  shift?: boolean;
  super?: boolean;
}

/** What consumePendingRender returns when there's something to render. */
export interface PendingRender {
  /** Replacement text for the InputZone. */
  readonly text: string;
  /** Cursor offset to apply. */
  readonly cursor: number;
}

export interface BootResult {
  readonly adapter: ClaudeCodeV21Adapter;
  readonly hlState: HighlightState;
  readonly dynDefs: DynDefs;
  /** Whether boot completed without error. */
  readonly failed: boolean;

  /**
   * Run a raw host key event through every registered onKey handler.
   * Returns true if any handler consumed the event.
   */
  dispatchKey(rawEvent: RawKeyEvent, text: string, cursorOffset: number): boolean;

  /**
   * Read-and-clear the pending render. Returns null if nothing pending.
   * If a module called setText/setCursorOffset, those values come back here.
   * If only forceRender (no text change), the text is the ZWS-toggled
   * version of `currentText` (forces re-render without visible change).
   *
   * IMPORTANT: pass the host's *fresh* current text/cursor every call. The
   * patch reads them at the dispatch site (e.g. `inputZoneVar.text`). Do
   * NOT rely on bindings.getText() — host closures may be stale across
   * React re-renders.
   */
  consumePendingRender(currentText: string, currentCursor: number): PendingRender | null;

  /**
   * Wrap a host-rendered string through every onRender handler, applying
   * each handler's RenderDirectives via applyDirectives. Pass-through if
   * no handlers are subscribed or the input isn't a string.
   */
  applyRender(rendered: unknown, text: string, cursorOffset: number): unknown;

  /**
   * Wipe per-buffer runtime state (DynDefs, HighlightState, SpanFill,
   * SelectorSatellite). Fire whenever an external mutation has invalidated
   * the runtime's tracked spans — terminal paste, host-level undo, any
   * write that bypasses the runtime's setText pipeline. Idempotent.
   * See `resetSharedBufferState` in `src/boot-common.ts` for the full
   * rationale + state objects deliberately NOT wiped.
   */
  resetBufferState(): void;
}

/**
 * Construct the runtime, subscribe modules, return host-facing helpers.
 *
 * Synchronous: subscriptions land before this function returns, so the
 * very first key dispatch after boot() is fully wired. Runtime.create is
 * fire-and-forget, used only for capability validation + startup logging.
 * ConfigLoader.load() is also fire-and-forget — Cycling gracefully no-ops
 * until the cue map is populated.
 */
export function boot(host: HostInfo): BootResult {
  // configLoader is constructed below; isDebugEnabled reads it lazily
  // so OPENCUES.md `debug-mode: on/off` toggles take effect on the
  // next hot-reload without restart. OPENCUES.md is the source of
  // truth once loaded; DEBUG_OPENCUES env is a bootstrap fallback for
  // logs fired before the first ConfigLoader.load resolves (and a
  // dev-time override when no OPENCUES.md exists).
  let configLoaderRef: ConfigLoader | null = null;
  const isDebugEnabled = (): boolean => {
    if (configLoaderRef?.loaded) {
      return configLoaderRef.opencuesState.debugMode === 'on';
    }
    return !!process.env.DEBUG_OPENCUES;
  };
  const log = (level: LogLevel, msg: string, data?: unknown): void => {
    // Always pass through error/warn/info — they're not gated by debug.
    // Debug-level only when explicitly enabled.
    if (level === 'debug' && !isDebugEnabled()) return;
    if (host.log) {
      try { host.log(level, msg, data); } catch { /* swallow */ }
    } else if (isDebugEnabled()) {
      // eslint-disable-next-line no-console
      console.error(`[opencues][${level}] ${msg}`, data ?? '');
    }
  };

  // Mac Terminal.app emits Ctrl+Option+arrow as `\x1b\x1b[A` (double-ESC),
  // which Ink splits into a standalone escape + a plain arrow before any
  // handler can see the modifier. Normalise the raw stdin chunk to the
  // Ghostty-style `\x1b[1;7A` BEFORE Ink parses it — the installer wraps the
  // `read()`-pull path Ink uses (utf8 strings) plus 'data' events. macOS-only +
  // idempotent (guards live inside the installer); no-op on every other host.
  if (installMacDoubleEscStdinRewrite(process.stdin)) {
    log('info', 'mac double-ESC stdin rewrite installed');
  }

  // Handler arrays + render state owned by this boot.
  const keyHandlers: Array<(e: KeyEvent) => boolean> = [];
  const renderHandlers: Array<(c: RenderContext) => RenderDirectives | null> = [];
  const textHandlers: Array<(e: TextChangeEvent) => void> = [];
  // Cursor-change subscribers. CC's cli.js doesn't surface cursor-only
  // moves natively (the parent React tree has no onCursorChange path),
  // so REAL user cursor moves don't fire these — same caveat as the
  // file-header note. The handlers exist so SYNTHETIC cursor injects
  // via the event-bridge's `cursor:N` command can drive runtime modules
  // that gate on cursor changes (Navigation's cursor-navigate mode is
  // the load-bearing consumer — scenario 30 in the agentic harness
  // pins the contract end-to-end). Without this, scenario 30 silently
  // no-ops on CC because adapter.onCursorChange is undefined and
  // Navigation.subscribe() falls through to "highlight follows typing only".
  const cursorHandlers: Array<(e: CursorChangeEvent) => void> = [];
  // Module-emitted structured events (resolver.completed, etc.).
  // Subscribers registered via bindings.registerEventHandler; emit
  // via bindings.emitEvent. Cheap when nobody's subscribed.
  const eventHandlers: Array<(type: string, body?: Record<string, unknown>) => void> = [];
  let pendingRender = false;
  let pendingText: string | null = null;
  let pendingCursor: number | null = null;
  // `true` while inside dispatchKey — setText/forceRender then buffer into
  // pending* flags which consumePendingRender drains synchronously after
  // dispatch. `false` everywhere else (async timer callbacks, promise
  // resolutions, etc.) — setText/forceRender must then push actively via
  // host.pushText, or the buffer stalls until the next user keystroke
  // (which breaks BlankLoading's spinner animation + agent-task highlight
  // refresh on 2.1.150 where S6 isn't available to drive renders).
  let insideDispatch = false;
  // Drift detection: lastSeenText is what we last observed during a dispatch
  // or render. If the visible-character content changes between observations
  // and we didn't initiate the change ourselves, fire a 'user' textChange.
  // Also serves as the source-of-truth for bindings.getText — host.getText
  // is a stale closure on this CC build (REPAIR.md §Host quirks #1).
  let lastSeenText: string | null = null;
  let lastSeenCursor = 0;
  const ZW_RE = /[\u200B\u200C]+/g;
  const visible = (s: string): string => s.replace(ZW_RE, '');

  // Source reclassifier — mirrors chrome's safeguard against runtime
  // writes echoing back as 'user' events. Every time WE push text via
  // setText, we mark the (clean) value. checkTextDrift, when it would
  // otherwise emit source='user', asks the reclassifier first — if the
  // text matches a recent runtime write, it's reclassified to 'runtime'
  // and the Resolver skips it. Prevents the cycle-Down → original
  // "draft an email _" → resolver re-fires → new transform-blank LLM
  // call → infinite-loop scenario the user hit.
  const sourceReclassifier = createSourceReclassifier();

  const checkTextDrift = (text: string, cursorOffset: number): void => {
    lastSeenCursor = cursorOffset;
    // Always work in ZWS-stripped space. The wire text (what onChange
    // received) carries a trailing ZWS on the 2.1.110 fallback path that
    // the patch toggles every pushHostText to defeat React's string-
    // equality bail-out. The runtime must never see those ZWS chars —
    // splitWords matches `\S+` so a ZWS sticks to the last word
    // ("Information]\u200B"), which breaks any def comparison that uses
    // `originalWord` / multi-word match and lets re-resolvers fire
    // inside a substituted span. Strip first, then compare + store + emit.
    const clean = visible(text);
    if (lastSeenText === null) {
      lastSeenText = clean;
      return;
    }
    if (clean === lastSeenText) return;
    const proposed: 'user' | 'runtime' = pendingText !== null ? 'runtime' : 'user';
    const source = sourceReclassifier.reclassify(clean, proposed);
    const event: TextChangeEvent = {
      text: clean,
      cursorOffset,
      previousText: lastSeenText,
      source,
    };
    for (const handler of textHandlers) {
      try { handler(event); } catch (err) {
        log('error', 'textChange handler error', err);
      }
    }
    lastSeenText = clean;
  };

  const removeFrom = <T>(arr: T[], item: T): void => {
    const i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
  };

  const bindings: HostBindings = {
    hostVersion: host.hostVersion,
    cwd: host.cwd,
    // Prefer boot's drift-tracked text (always fresh from the latest dispatch
    // or render). Falls back to host.getText() before the first observation.
    // Avoids the stale-closure issue where host.getText is bound to a long-
    // gone Dy8 invocation.
    getText: () => {
      if (lastSeenText !== null) return lastSeenText;
      try { return host.getText(); } catch { return ''; }
    },
    getCursorOffset: () => {
      if (lastSeenText !== null) return lastSeenCursor;
      try { return host.getCursorOffset(); } catch { return 0; }
    },
    setText: (text) => {
      const prev = lastSeenText;
      pendingText = text;
      lastSeenText = text;
      // Mark this push so any subsequent matching text event (the React
      // re-render echo, a parent component's debounced onChange echo,
      // any other reflex of our setText that comes back through input
      // detection) gets reclassified to source='runtime' and the Resolver
      // ignores it. Stash the CLEAN text (after ZWS strip) since
      // checkTextDrift compares in that space. See boot-common.ts §
      // RUNTIME_WRITE_TTL_MS for the 250ms freshness window.
      sourceReclassifier.markRuntimeWrite(visible(text));
      // CC's J68 (the InputZone parent on 2.1.150) discards WH's return,
      // so the consumePendingRender → return-new-IZ pattern can't actually
      // propagate text changes. Only host.pushText reaches the parent's
      // onChange. Commit immediately + fire text.changed for runtime
      // subscribers (Statusline, resolver onTextChange, event-bridge).
      if (host.pushText) {
        host.pushText(text, lastSeenCursor);
        pendingText = null;
      }
      if (prev !== null && visible(prev) !== visible(text)) {
        const event: TextChangeEvent = {
          text, cursorOffset: lastSeenCursor, previousText: prev, source: 'runtime',
        };
        for (const handler of textHandlers) {
          try { handler(event); } catch (err) { log('error', 'setText textChange handler error', err); }
        }
      }
      // Synchronously fire renderHandlers (Statusline.maybeWrite etc.)
      // so any state-derived snapshot file lands the same tick as the
      // setText call. Without this, Cycling.applyAltCycle's def.currentIndex
      // update doesn't reach /tmp/opencues-status-<pid>.json until React
      // commits the kickRender + applyRender chain — 96-500ms later. The
      // harness's `expect currentAltIndex equals 1` polls the file
      // immediately after waitForEvent on text.changed, before that
      // chain settles. Synthetic ctx is fine: render handlers that
      // return directives don't actually mutate the buffer here (no
      // applyDirectives call) — they just observe state.
      const synthCtx: RenderContext = { text, cursor: lastSeenCursor, externalHighlights: [] };
      for (const handler of renderHandlers) {
        try { handler(synthCtx); } catch (err) {
          log('error', 'setText synthetic-render handler error', err);
        }
      }
    },
    setCursorOffset: (offset) => {
      pendingCursor = offset;
      lastSeenCursor = offset;
      // Same rationale as setText. CC has no onCursorChange path that
      // reaches the parent, but the cursor moves through pushText's
      // cursor arg. Use the existing pushText with current text.
      if (host.pushText && lastSeenText !== null) {
        host.pushText(lastSeenText, offset);
        pendingCursor = null;
      }
    },
    forceRender: () => {
      pendingRender = true;
      // CC's J68 discards WH's return value, so consumePendingRender's
      // ZWS-toggled-IZ trick never reaches the parent. We MUST go through
      // host.forceRender (S7-wired __oc_kickRender) to bump the parent's
      // useState and trigger a real re-render. Both inside-dispatch
      // (Navigation activating a highlight) and outside-dispatch (timer-
      // driven spinner, agent-task refresh) take the same path.
      //
      // If pendingText is queued (e.g. setText was called by a host
      // without pushText), drain it through pushText for completeness.
      // S7-missing fallback: host.forceRender is undefined, so we ZWS-
      // toggle the current text via pushText to defeat React equality.
      if (pendingText !== null && host.pushText) {
        const text = pendingText;
        const cursor = pendingCursor ?? undefined;
        try { host.pushText(text, cursor); } catch (err) { log('error', 'forceRender pushText drain failed', err); }
        pendingText = null;
        pendingCursor = null;
        lastSeenText = text;
      }
      if (host.forceRender) {
        try { host.forceRender(); } catch (err) { log('error', 'host.forceRender (kick) failed', err); }
        pendingRender = false;
      } else if (host.pushText && lastSeenText !== null) {
        try { host.pushText(lastSeenText, lastSeenCursor); } catch { /* swallow */ }
        pendingRender = false;
      }
    },
    registerKeyHandler: (cb): Unsubscribe => {
      keyHandlers.push(cb);
      return () => removeFrom(keyHandlers, cb);
    },
    registerRenderHandler: (cb): Unsubscribe => {
      renderHandlers.push(cb);
      return () => removeFrom(renderHandlers, cb);
    },
    registerTextChangeHandler: (cb): Unsubscribe => {
      textHandlers.push(cb);
      return () => removeFrom(textHandlers, cb);
    },
    registerCursorChangeHandler: (cb): Unsubscribe => {
      cursorHandlers.push(cb);
      return () => removeFrom(cursorHandlers, cb);
    },
    readFile: host.readFile,
    readDir: host.readDir,
    writeFile: host.writeFile,
    spawnProcess: host.spawnProcess,
    blankInvoke: host.blankInvoke,
    emitEvent: (type, body) => {
      for (const h of eventHandlers) {
        try { h(type, body); } catch (err) { log('error', 'event handler threw', err); }
      }
    },
    registerEventHandler: (cb) => {
      eventHandlers.push(cb);
      return () => removeFrom(eventHandlers, cb);
    },
    // Wrap pushText so runtime-initiated async pushes (e.g. selector
    // script-get callbacks) mark themselves as runtime — otherwise the
    // next applyRender's checkTextDrift sees the new text differs from
    // lastSeenText AND pendingText is null, fires a 'user' textChange,
    // and Navigation deactivates the highlight.
    pushText: host.pushText
      ? (text: string, cursor?: number): void => {
          const prev = lastSeenText;
          lastSeenText = text;
          if (typeof cursor === 'number') lastSeenCursor = cursor;
          host.pushText!(text, cursor);
          // Fire text.changed with source='runtime' so consumers
          // (event-bridge, Resolver onTextChange, etc.) see the swap. The
          // host's next applyRender will also call checkTextDrift, but
          // by then lastSeenText already matches the new text and drift
          // detection skips. Cycling alt-swaps on CC go through pushText —
          // without this emit, the harness's text.changed assertion (the
          // canonical "buffer mutated" signal) never sees the post-cycle
          // text, even though the visible buffer actually changed.
          if (prev !== null && visible(prev) !== visible(text)) {
            const event: TextChangeEvent = {
              text,
              cursorOffset: typeof cursor === 'number' ? cursor : lastSeenCursor,
              previousText: prev,
              source: 'runtime',
            };
            for (const handler of textHandlers) {
              try { handler(event); } catch (err) {
                log('error', 'pushText textChange handler error', err);
              }
            }
          }
        }
      : undefined,
    log,
  };

  const adapter = new ClaudeCodeV21Adapter(bindings);

  // Kata key observation — MUST be the first key subscriber (key
  // dispatch is emit-until-consumed; Navigation consumes Ctrl+Alt
  // arrows). See docs/architecture/katas.md § host wiring contract.
  let kataCoachRef: KataCoach | null = null;
  adapter.onKey(null, (e) => { kataCoachRef?.observeKey(e); return false; });

  // Direct-launch drift advisory. CC's per-band boot wires modules by
  // hand and predates `buildSharedRuntime` (where every other host gets
  // this for free). Without this call the warning never fires for CC
  // users launching the host directly (bypassing `opencues run`'s
  // CLI-side srcHash check). Fire-and-forget; silent on any error.
  // See boot-common.ts:checkRuntimeDrift for limits.
  void checkRuntimeDrift(adapter);

  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  // Span-lifecycle trace (debug-mode gated at the sink) — see boot-common.
  dynDefs.setDebugLog(msg => adapter.log('debug', `DynDefs: ${msg}`));
  const spanFillState = new SpanFillState();
  const dismissedBlanks = new DismissedBlanks();
  const selectorSatelliteState = new SelectorSatelliteState();
  const agentTaskState = new AgentTaskState();
  // Session-scoped undo/redo log — mirrors buildSharedRuntime's wiring
  // (CC constructs its modules inline; keep the two in lockstep).
  const undoJournal = new UndoJournal();

  // ConfigLoader: kick off load asynchronously. Cycling tolerates an empty
  // map (returns false from step) until load resolves.
  // Search paths in priority order. Project-level `.cues/` wins on name
  // conflicts; user-level `~/.cues/` is the global default. System
  // settings live at `~/.cues/OPENCUES.md` (or $OPENCUES_HOME/OPENCUES.md).
  // OPENCUES_HOME env var takes top priority for power users / CI.
  const HOME = process.env.HOME ?? '~';
  const configSearchPaths = [
    ...(process.env.OPENCUES_HOME ? [process.env.OPENCUES_HOME] : []),
    `${host.cwd}/.cues`,
    `${HOME}/.cues`,
  ];
  const settingsFile = process.env.OPENCUES_HOME
    ? `${process.env.OPENCUES_HOME}/OPENCUES.md`
    : `${HOME}/.cues/OPENCUES.md`;
  const configLoader = new ConfigLoader(adapter, { configSearchPaths, settingsFile });
  configLoaderRef = configLoader; // wire isDebugEnabled to OPENCUES.md
  configLoader.subscribe(); // hot-reload on text-change drift
  configLoader.load().catch(err => log('error', 'ConfigLoader.load failed', err));

  // OUTBOUND PII FLOOR (buffer-dehydration) — CC's per-band boot wires
  // modules by hand (predates buildSharedRuntime, where every other
  // host registers this for free), so the dispatchChat-level guard is
  // registered here explicitly. Mirrors boot-common.buildSharedRuntime.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('@opencues/core') as {
      setOutboundDehydrationGuard?: (g: (() => unknown) | null) => void;
      getDehydrator?: (c: ReadonlyMap<string, string>) => unknown;
    };
    core.setOutboundDehydrationGuard?.(() => {
      const id = identityDehydrationFor(configLoader);
      return id && core.getDehydrator ? core.getDehydrator(id.catalog) : null;
    });
  } catch { /* core unavailable — pre-feature behaviour */ }

  // Subscribe modules synchronously so the very first key dispatch is wired.
  const navigation = new Navigation(adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState);
  navigation.subscribe();
  const dimRender = new DimRender(adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState);
  dimRender.subscribe();
  // Build the multi-provider key bag here (rather than next to the
  // Resolver constructor below) so Cycling's satellite-cycle filter
  // sees the same keys the Resolver will dispatch against. Beyond the
  // host-passed keys, buildBootApiKeys fills any registry env var the
  // bootstrap didn't forward from process.env, then from ~/.cues/.env
  // (written by `opencues set-key`) — a shell export always wins over
  // the file.
  const apiKeys = buildBootApiKeys(host.llmApiKeys, host.llmApiKey, (m) => log('info', m));
  const cycling = new Cycling(
    adapter, hlState, dynDefs, configLoader,
    spanFillState, dismissedBlanks, selectorSatelliteState,
    () => apiKeys, undefined, undoJournal,
    // Liveness gate for provider cycling — native transport (NodeHttpAdapter
    // fallback, no host httpAdapter here). Shared with buildSharedRuntime so
    // the two hand-wired module sets can't drift.
    buildCyclingProviderProbe(() => apiKeys, undefined, undefined),
  );
  cycling.subscribe();

  // BlankFill: scans for `_` placeholders + matched blank. Owns the
  // detection + sync (stepValues) and async (blankScript) fill paths.
  // E.8 adds the consume-all branch — needs SpanFillState as a writer
  // so E.9's Cycling can read the stash. F.a generalises the same state
  // for multi-word stepValues fills (affirmations etc.).
  // Shared loading-glyph animator. Owned at this layer so BlankFill +
  // Resolver (constructed below) share state — without that, both
  // would spin their own animators and race on `_` slots that span
  // both paths (rare but real).
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

  // MarkdownRender — receives `markdown.styled` events from substituting
  // modules (TransformBlank/FluidBlank) and caches per-style ranges. Used
  // by the Resolver below to re-inject markers into the LLM's rich-text
  // view so prior styling stacks across transforms.
  const markdownRender = new MarkdownRender(adapter);
  markdownRender.subscribe();

  // Register the loading animator as a render handler so per-frame
  // colours from blank-loading-colors-ansi flow through the directive
  // pipeline. CC is terminal-only — always picks the ANSI list (not
  // RGB). Mirrors the equivalent registration in boot-common.ts which
  // covers gemini / OC / chrome.
  adapter.onRender((ctx) => {
    const ranges = blankLoading.getActiveColoredRanges(ctx.text, 'ansi');
    if (ranges.length === 0) return null;
    return {
      coloredRanges: ranges.map(r => ({ start: r.start, end: r.end, ansi: r.color })),
    };
  });

  // Glimmer transition — scramble-settle when a substitution LANDS
  // (`glimmer-transition-ms`). Owned at this layer for the same reason
  // as blankLoading above: CC hand-wires its modules instead of calling
  // buildSharedRuntime, so the shared construction there doesn't cover
  // this band (see boot-bands-wiring.test.ts). Registered AFTER the
  // loading-colour handler so its whole-string textOverride is the
  // frame's final word while it runs. Display-only: textOverride +
  // forceRender, never setText.
  const glimmer = new GlimmerRender({
    adapter,
    durationMs: () => parseGlimmerTransitionMs(
      configLoader.opencuesState.settings.get('glimmer-transition-ms'),
    ),
    log: msg => log('debug', msg),
  });
  adapter.onRender((ctx) => {
    const override = glimmer.getTextOverride(ctx.text);
    return override !== null ? { textOverride: override } : null;
  });

  // Routing is deterministic (blankShapes) — the old LLM BlankIntent gate
  // was retired.
  // integration-weave LLM (blanks bucket, native NodeHttpAdapter fallback).
  // No-ops to static unless `integration-weave-mode: on` + a blank opts in.
  const blankWeaver = buildBlankWeaver(configLoader, () => apiKeys, undefined, (lvl, msg) => log(lvl, msg));
  const blankFill = new BlankFill(adapter, configLoader, spanFillState, dismissedBlanks, selectorSatelliteState, dynDefs, blankLoading, blankWeaver, undoJournal, glimmer);
  configLoader.load().then(() => blankFill.subscribe()).catch(() => { /* logged */ });
  void blankFill; // silence unused — referenced by future phases

  // KataCoach — modal guided-scenario runtime. Same wiring as
  // oc/v1.14 (docs/architecture/katas.md).
  const HOME_TUT = process.env.HOME ?? '~';
  const kataCoach = new KataCoach(adapter, configLoader, {
    katasDirs: configSearchPaths.map(p => `${p}/katas`),
    resolveLLM: () => buildKataLLMResolver(configLoader, apiKeys),
    cadenceMs: () => parseInt(configLoader.opencuesState.settings.get('kata-debounce-ms') ?? '', 10),
    nudgeMs: () => parseInt(configLoader.opencuesState.settings.get('kata-nudge-ms') ?? '', 10),
    progressFile: process.env.OPENCUES_HOME
      ? `${process.env.OPENCUES_HOME}/kata-progress.json`
      : `${HOME_TUT}/.cues/kata-progress.json`,
    log: msg => log('debug', msg),
  });
  kataCoach.subscribe();
  kataCoachRef = kataCoach; // arms the early key observer above

  // Statusline only if the host advertised a path. Don't write to a default
  // location — that risks colliding with another opencues instance.
  if (host.statusFilePath) {
    const statusline = new Statusline(adapter, hlState, dynDefs, {
      exportPath: host.statusFilePath,
      refreshHook: host.refreshStatusline,
      kataStatus: () => kataCoach.status(),
      undoStatus: () => undoJournal.recentApplyReport(8000),
    }, configLoader, spanFillState, selectorSatelliteState, agentTaskState);
    statusline.subscribe();
  }

  // CursorStateExport — opt-in. External tooling can read the export
  // for buffer/cursor inspection; no in-tree consumer.
  if (host.cursorStatePath && adapter.capabilities.includes('file-write')) {
    const cse = new CursorStateExport(adapter, { exportPath: host.cursorStatePath });
    cse.subscribe();
  }

  // TTS only when both spawn-process is available AND a script path was given.
  if (host.ttsScriptPath && adapter.capabilities.includes('spawn-process')) {
    const tts = new TTS(adapter, hlState, dynDefs, configLoader, {
      scriptPath: host.ttsScriptPath,
      rate: host.ttsRate !== undefined ? String(host.ttsRate) : undefined,
    }, spanFillState, selectorSatelliteState);
    tts.subscribe();
  }

  // Resolver: LLM-driven cycle population. Only constructed when an API key
  // is present. Subscribes once configLoader.load() resolves so the resolver
  // can build sources from cuesConfig + blanksConfig.
  // `apiKeys` is constructed above (next to Cycling) so the cycling
  // filter sees the same bag.
  // "Usable LLM" = any env key OR the zero-key subscription-CLI rung
  // (pickAutoProvider's last rung: claude/codex binary present). Without
  // the second clause a keyless subscription setup would show the
  // missing-key hint and skip AgentRewrite while dispatch actually works.
  const hasAnyKey = Object.values(apiKeys).some(Boolean) || pickAutoProvider(apiKeys) !== null;
  // Resolver is constructed even with no keys so the MissingKeyFallbackSource
  // can substitute a visible in-buffer hint on `_` instead of silent no-op.
  const calendarContextHolder = buildCalendarContextIngest(log);
  // Cue dismissals: hydrate what the user has forgotten and register the writer
  // that persists a new forget. ⚠ Wired HERE by hand because this band does not
  // call `buildSharedRuntime` — it predates it and assembles its modules
  // itself. Without this line the `_`-twice gesture fires, logs `cue forget`,
  // and silently degrades to a 24h mute because no sink is registered: the
  // dismissal never reaches <cues>/dismissals.json and never shows up in
  // `opencues dismissals`. That is exactly how it shipped the first time.
  startCueDismissals(log);
  // Session-contradiction / ask-cues: native read of the per-cwd
  // session-commitments watchlist (produced by `opencues extract-commitments`).
  // Live holder — refreshed on a timer; the resolver reads it fresh each pass.
  // Inert until the producer writes the file (feature off / no transcript growth
  // → empty → source silent).
  const sessionCommitmentsHolder = buildSessionCommitmentsIngest(log, { cwd: host.cwd });
  // Kick the producer from the boot band — the same mechanism OpenCode/Gemini
  // use — so the feature no longer depends on the opt-in statusline trigger. The
  // locator finds this session's transcript under ~/.claude/projects/<slug>/.
  // Self-gates on the mode scalars; harmless double-kick if the statusline is
  // also enabled (the producer self-debounces + locks).
  startSessionCommitmentsKick(log, { locate: () => locateNewestCCTranscript(host.cwd), format: 'cc', extraArgs: ['--cwd', host.cwd] });
  // Aggregate LLM usage meter — passive accounting for `opencues usage`.
  startUsageMeter(log, { host: 'claude-code' });
  const resolver = new Resolver(adapter, hlState, dynDefs, configLoader, {
    glimmer,
    endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
    defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
    apiKeys,
    debounceMs: host.llmDebounceMs ?? 500,
    missingKeyFallbackMessage: hasAnyKey ? undefined : NATIVE_HOST_MISSING_KEY_MESSAGE,
    formatLLMErrorAsSubstitute: nativeHostFormatLLMError,
    keywordBoundSlotIndices: (text: string) => blankFill.scan(text).map(s => s.index),
    // Calendar-context: native read of the shared calendar.json snapshot
    // ($OPENCUES_HOME first, then ~/.cues), refreshed on a timer. Live
    // holder — the resolver reads it fresh each pass. See boot-common.
    calendarContext: calendarContextHolder,
    sessionCommitments: sessionCommitmentsHolder,
    externallySuppressed: (text: string) => kataCoach.shouldSuppressResolve(text),
  }, spanFillState, agentTaskState, blankLoading, markdownRender, selectorSatelliteState,
  buildBlankContextProvider(configLoader, host.blanks, log),
  buildBlankFetchProvider(configLoader, host.blanks, log),
  undoJournal);
  if (hasAnyKey) {
    // AgentRewrite — cadence-driven holistic rewrite with three-way merge.
    const agentRewrite = new AgentRewrite(adapter, dynDefs, agentTaskState, {
      undoJournal,
      endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
      defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
      // Re-resolves per tick — picks up OPENCUES.md `agent-provider:` /
      // `agent-model:` / `llm-provider:` edits without a restart.
      resolveLLM: () => buildAgentLLMResolver(configLoader, apiKeys),
      // Buffer-dehydration: outbound DOCUMENT scrubbed to [TOKEN]s in
      // identity-context safe mode; rewrite hydrated before the merge.
      identityDehydration: () => identityDehydrationFor(configLoader),
      // Sliding-window mode (lazy thunk so OPENCUES.md edits take effect
      // without a restart). 0 = full-buffer; e.g. 200 = cursor ± 100
      // words, expanded to paragraph boundaries.
      windowWords: () => parseInt(configLoader.opencuesState.settings.get('agent-window-words') ?? '0', 10) || 0,
      // Debounce window — re-read on every scheduleTick so users can
      // tweak agent-debounce-ms in OPENCUES.md without restart. NaN /
      // non-positive falls back to 1000 inside AgentRewrite.getCadenceMs.
      cadenceMs: () => parseInt(configLoader.opencuesState.settings.get('agent-debounce-ms') ?? '', 10),
      // Auditor composition — isolated mode (one parallel LLM call per
      // auditor; results diff-merged by priority). Lazy thunk so
      // AUDITOR.md edits + AUDITORS.md disable[] edits propagate without
      // restart. See spec/auditor-spec.md § Composition.
      auditorPrompts: () => configLoader.composeAuditorPrompts(),
      // Optional cap on concurrent auditor calls. Default 0 (uncapped).
      // Lazy thunk so users can flip max-concurrent-auditors in OPENCUES.md
      // without restart.
      maxConcurrentAuditors: () => parseInt(configLoader.opencuesState.settings.get('max-concurrent-auditors') ?? '', 10) || 0,
    });
    agentRewrite.start();
  }
  // resolver.subscribe() moved OUT of the hasAnyKey block so the
  // MissingKeyFallbackSource can fire (registers via subscribe) even
  // when no keys are configured.
  configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });

  // Fire-and-forget Runtime.create — capability validation + startup log.
  Runtime.create(adapter).catch(err => {
    log('error', 'Runtime.create failed', err);
  });

  // Internal event-bridge — opt-in via OPENCUES_BRIDGE=1. Polls a
  // synthetic-input file and forwards module events to a JSONL stream
  // for off-process tooling. CC v2.1's keyHandlers list is the same
  // one a real keystroke goes through, so synthetic dispatches are
  // semantically identical to user input.
  if (process.env.OPENCUES_BRIDGE === '1') {
    startEventBridge({
      adapter,
      // Compute the render directives (dim / highlight / inlineNote) for the
      // live text + cursor so the dump exposes what would be painted now —
      // makes the inline cue note observable to agentic scenarios. Mirrors
      // applyRender's ctx construction; ZWS-stripped so DimRender's coords line
      // up. Null returns (Statusline) are dropped.
      renderDirectives: () => {
        const ctxText = visible(adapter.getText());
        const rctx: RenderContext = {
          text: ctxText,
          cursor: adapter.getCursorOffset(),
          externalHighlights: [],
        };
        const out: RenderDirectives[] = [];
        for (const handler of renderHandlers) {
          try { const d = handler(rctx); if (d) out.push(d); }
          catch { /* a broken handler must not break the dump */ }
        }
        return out;
      },
      // The PAINTED output (ANSI-stripped) for the current buffer, so scenarios
      // can assert the inline note's aligned splice. Buffer space: firstLineIndent
      // is 0 (the display prompt isn't part of the buffer), so the note aligns
      // under the span's column in the text itself.
      renderedText: () => {
        const ctxText = visible(adapter.getText());
        const rctx: RenderContext = {
          text: ctxText,
          cursor: adapter.getCursorOffset(),
          externalHighlights: [],
        };
        let out = ctxText;
        for (const handler of renderHandlers) {
          try { const d = handler(rctx); if (d) out = applyDirectives(out, d, 0); }
          catch { /* a broken handler must not break the dump */ }
        }
        return out.replace(/\x1b\[[0-9;]*m/g, '');
      },
      // Synthetic keys go through the same handler list real keystrokes
      // use. HONOUR the caller's text/cursorOffset framing when supplied:
      // the event-bridge's `text:` inject frames its synthetic `_` as the
      // final keystroke of the injected string (new text minus the `_`,
      // cursor at its position). Re-sampling adapter state here clobbered
      // that framing with the PRE-inject buffer — after a transform
      // substitute the stale cursor sat exactly at the filled span's end,
      // inside Cycling's inclusive `_`-note gate, so the synthetic `_` was
      // consumed as a cycle (def reverted to the original) instead of
      // arming the blank gate. Every OTHER band passes the event through
      // untouched (emitUntilConsumed(e)); this inline construction had
      // drifted. Adapter sampling remains the fallback for callers that
      // don't frame (none today — parseKeyArg samples equivalently).
      dispatchKey: (e) => {
        const text = e.text !== undefined ? e.text : adapter.getText();
        const cursor = e.cursorOffset !== undefined ? e.cursorOffset : adapter.getCursorOffset();
        const ev: KeyEvent = {
          key: e.key,
          modifiers: { ...e.modifiers },
          text,
          cursorOffset: cursor,
        };
        for (const handler of keyHandlers) {
          try { if (handler(ev)) return true; }
          catch (err) { log('error', 'bridged key handler error', err); }
        }
        return false;
      },
      // notifyTextChange — CC normally drift-tracks textChanges through
      // applyRender, but synthetic writes happen outside any render
      // cycle. Fire textHandlers directly so the Resolver / Statusline
      // see the synthetic change. Mirrors checkTextDrift's emit logic
      // minus the visible-diff guard (the caller already knows it changed).
      notifyTextChange: (text, cursor, source) => {
        const event = {
          text,
          cursorOffset: cursor,
          previousText: lastSeenText ?? '',
          source,
        };
        for (const handler of textHandlers) {
          try { handler(event); }
          catch (err) { log('error', 'bridged textChange handler error', err); }
        }
        lastSeenText = text;
        lastSeenCursor = cursor;
      },
      // notifyCursorChange — used by the event-bridge's synthetic
      // `cursor:N` command. Real user cursor moves on CC don't fire
      // this (cli.js has no onCursorChange surface); the path exists
      // for the agentic-harness contract (scenario 30: cursor-navigate
      // mode auto-activates highlight on cursor change). Updates
      // lastSeenCursor + fires cursorHandlers (Navigation subscribes
      // there when cursor-navigate is on). Same prev-text-stale fix
      // shape as notifyTextChange above — bridge calls this BEFORE
      // adapter.setCursorOffset, so lastSeenCursor still holds the OLD
      // value here.
      notifyCursorChange: (text, cursor, source) => {
        const event: CursorChangeEvent = {
          text,
          cursorOffset: cursor,
          source,
        };
        for (const handler of cursorHandlers) {
          try { handler(event); }
          catch (err) { log('error', 'bridged cursorChange handler error', err); }
        }
        lastSeenCursor = cursor;
      },
      state: { hlState, dynDefs, spanFillState, selectorSatelliteState, agentTaskState },
    });
  }

  let handlerErrLogged = false;

  return {
    adapter,
    hlState,
    dynDefs,
    failed: false,

    dispatchKey(rawEvent, text, cursorOffset) {
      checkTextDrift(text, cursorOffset);
      // ZWS strip at the KeyEvent boundary — same rationale as
      // checkTextDrift / applyRender (see boot.ts:282, 771-772). Without
      // this, `text` carries the render-kick `\u200B`/`\u200C` marker that
      // __oc_pushHostText toggles to defeat React's string-equality bail.
      // Resolver.onUnderscoreKey's standalone-`_` check runs splitWords
      // (which matches `\S+`); a ZWS adjacent to the cursor word glues to
      // it and the trailing `_` is no longer detected as standalone — the
      // one-shot gate refuses to arm, and the second `_` in a chain (e.g.
      // `draft email _` → `… translate to japanese _`) silently falls into
      // the debounced fall-through with allowBlanks=false, masking the
      // blank source.
      const cleanText = visible(text);
      const cleanCursor = visible(text.slice(0, cursorOffset)).length;
      const event = normaliseKeyEvent(rawEvent, cleanText, cleanCursor);
      insideDispatch = true;
      try {
        for (const handler of keyHandlers) {
          try {
            if (handler(event)) return true;
          } catch (err) {
            if (!handlerErrLogged) {
              handlerErrLogged = true;
              log('error', 'key handler error', err);
            }
          }
        }
        return false;
      } finally {
        insideDispatch = false;
      }
    },

    consumePendingRender(currentText, currentCursor) {
      if (!pendingRender) return null;
      pendingRender = false;

      let result: PendingRender;
      if (pendingText !== null || pendingCursor !== null) {
        result = {
          text: pendingText ?? currentText,
          cursor: pendingCursor ?? currentCursor,
        };
        pendingText = null;
        pendingCursor = null;
      } else {
        // No explicit text/cursor change — ZWS toggle to force re-render.
        result = { text: toggleZeroWidth(currentText), cursor: currentCursor };
      }
      // Mark that we initiated this change so the next observed text matching
      // it doesn't get flagged as user-typed drift.
      lastSeenText = result.text;
      return result;
    },

    resetBufferState() {
      resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState, undoJournal });
    },

    applyRender(rendered, text, cursorOffset) {
      checkTextDrift(text, cursorOffset);
      if (typeof rendered !== 'string') return rendered;
      if (renderHandlers.length === 0) return rendered;
      // Strip ANSI for `visibleText` (used as the styling-application
      // base via `out = applyDirectives(...)`). Strip ANSI *and* ZWS for
      // `ctxText` (consumed by handlers: DimRender's splitWords,
      // SentenceCue's segmenter, etc.). ZWS only exists in CC because
      // __oc_pushHostText toggles it to defeat React's string-equality
      // bail-out on forceRender — it's an internal render-kick marker,
      // never a meaningful visible character. Letting it reach handlers
      // makes splitWords emit a stray ZWS-word at the buffer tail; for
      // multi-word spans that walks the dim end-word lookup off by one
      // and dim disappears. checkTextDrift already strips ZWS for the
      // text-change side; this is the symmetric strip for the render
      // side. Keep the two boundaries in sync.
      const visibleText = rendered.replace(/\x1b\[[0-9;]*m/g, '');
      const sliceText = visible(visibleText);
      // VIEWPORT translation (Sep 2026): CC renders tall buffers through a
      // scrolled viewport — `rendered` is only the visible lines, while
      // every span (DynDefs, cues, highlight) is in FULL-buffer coords.
      // Building ctx from the slice made scrolled spans fail DimRender's
      // stale-def guard and lose their dim/note ("draft email _ doesn't go
      // grey"). Locate the slice inside the full buffer, hand handlers the
      // FULL text, and translate directive ranges back into slice coords.
      // No contiguous match (soft-wrap inserts, mid-render mutation) →
      // pre-fix behaviour unchanged. See viewport.ts.
      const fullText = visible(text);
      const match = sliceText === fullText
        ? { offset: 0, length: fullText.length }
        : locateViewportSlice(fullText, sliceText, cursorOffset);
      const ctxText = match ? fullText : sliceText;
      const ctx: RenderContext = {
        text: ctxText,
        cursor: cursorOffset,
        externalHighlights: [],
      };
      let out = rendered;
      const debugDirectives: unknown[] = [];
      for (const handler of renderHandlers) {
        try {
          let directives = handler(ctx);
          if (directives && match) {
            directives = translateDirectivesToViewport(directives, match.offset, match.length, fullText.length);
          }
          if (directives) {
            debugDirectives.push(directives);
            out = applyDirectives(out, directives, CC_INPUT_FIRST_LINE_INDENT);
          }
        } catch (err) {
          log('error', 'render handler error', err);
        }
      }
      if (isDebugEnabled()) {
        const zwsStripped = visibleText.length - sliceText.length;
        log('debug', 'applyRender', {
          textLen: text.length,
          visibleLen: visibleText.length,
          ctxLen: ctxText.length,
          sliceLen: sliceText.length,
          viewportOffset: match ? match.offset : null,
          zwsStripped,
          visiblePreview: sliceText.slice(0, 60),
          hlActive: hlState.active,
          hlWordIdx: hlState.wordIndex,
          directives: debugDirectives,
        });
      }
      return out;
    },
  };
}
