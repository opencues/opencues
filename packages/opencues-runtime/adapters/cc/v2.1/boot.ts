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
import { ClaudeCodeV21Adapter, type HostBindings, normaliseKeyEvent, toggleZeroWidth } from './adapter';
import { Navigation } from '../../../src/modules/navigation';
import { DimRender } from '../../../src/modules/dim-render';
import { Cycling } from '../../../src/modules/cycling';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { Statusline } from '../../../src/modules/statusline';
import { TTS } from '../../../src/modules/tts';
import { Resolver } from '../../../src/modules/resolver';
import { AgentRewrite } from '../../../src/modules/agent-rewrite';
import { BlankFill } from '../../../src/modules/blank-fill';
import { CursorStateExport } from '../../../src/modules/cursor-state-export';
import { HighlightState } from '../../../src/state/highlight-state';
import { DynDefs } from '../../../src/state/dyn-defs';
import { SpanFillState } from '../../../src/state/span-fill';
import { DismissedBlanks } from '../../../src/state/dismissed-blanks';
import { SelectorSatelliteState } from '../../../src/state/selector-satellite';
import { AgentTaskState } from '../../../src/state/agent-task';
import { applyDirectives } from '../../../src/render-directives';
import { buildAgentLLMResolver } from '../../../src/boot-common';
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
  Unsubscribe,
} from '../../../src/adapter';

/** Minimal host info the patch supplies. boot() builds HostBindings from it. */
export interface HostInfo {
  readonly hostVersion: string;
  readonly cwd: string;
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
  /** Optional: absolute path to the TTS script (CC ships speak.sh + SpeakCtl.exe colocated in <CC_FORK>/.opencues/scripts/). */
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
   * the runtime picks the right one based on cues.md `llm-provider:` /
   * `<feature>-provider:` settings. Legacy `llmApiKey` is still accepted
   * and registered as GROQ_API_KEY when this map isn't supplied.
   */
  llmApiKeys?: Readonly<Record<string, string | undefined>>;
  /** Optional: absolute path for the statusline state-export JSON. */
  statusFilePath?: string;
  /**
   * Optional: absolute path for the cursor-state-export JSON
   * (e.g. /tmp/opencues-cursor-state.json). No in-tree consumer;
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
  // so opencues.md `debug-mode: on/off` toggles take effect on the
  // next hot-reload without restart. opencues.md is the source of
  // truth once loaded; DEBUG_OPENCUES env is a bootstrap fallback for
  // logs fired before the first ConfigLoader.load resolves (and a
  // dev-time override when no opencues.md exists).
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

  // Handler arrays + render state owned by this boot.
  const keyHandlers: Array<(e: KeyEvent) => boolean> = [];
  const renderHandlers: Array<(c: RenderContext) => RenderDirectives | null> = [];
  const textHandlers: Array<(e: TextChangeEvent) => void> = [];
  // Module-emitted structured events (resolver.completed, etc.).
  // Subscribers registered via bindings.registerEventHandler; emit
  // via bindings.emitEvent. Cheap when nobody's subscribed.
  const eventHandlers: Array<(type: string, body?: Record<string, unknown>) => void> = [];
  let pendingRender = false;
  let pendingText: string | null = null;
  let pendingCursor: number | null = null;
  // Drift detection: lastSeenText is what we last observed during a dispatch
  // or render. If the visible-character content changes between observations
  // and we didn't initiate the change ourselves, fire a 'user' textChange.
  // Also serves as the source-of-truth for bindings.getText — host.getText
  // is a stale closure on this CC build (REPAIR.md §Host quirks #1).
  let lastSeenText: string | null = null;
  let lastSeenCursor = 0;
  const ZW_RE = /[\u200B\u200C]+/g;
  const visible = (s: string): string => s.replace(ZW_RE, '');
  const checkTextDrift = (text: string, cursorOffset: number): void => {
    lastSeenCursor = cursorOffset;
    if (lastSeenText === null) {
      lastSeenText = text;
      return;
    }
    if (text === lastSeenText) return;
    if (visible(text) !== visible(lastSeenText)) {
      const event: TextChangeEvent = {
        text,
        cursorOffset,
        previousText: lastSeenText,
        source: pendingText !== null ? 'runtime' : 'user',
      };
      for (const handler of textHandlers) {
        try { handler(event); } catch (err) {
          log('error', 'textChange handler error', err);
        }
      }
    }
    lastSeenText = text;
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
    setText: (text) => { pendingText = text; },
    setCursorOffset: (offset) => { pendingCursor = offset; },
    forceRender: () => { pendingRender = true; },
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
          lastSeenText = text;
          if (typeof cursor === 'number') lastSeenCursor = cursor;
          host.pushText!(text, cursor);
        }
      : undefined,
    log,
  };

  const adapter = new ClaudeCodeV21Adapter(bindings);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const spanFillState = new SpanFillState();
  const dismissedBlanks = new DismissedBlanks();
  const selectorSatelliteState = new SelectorSatelliteState();
  const agentTaskState = new AgentTaskState();

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

  // Subscribe modules synchronously so the very first key dispatch is wired.
  const navigation = new Navigation(adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState);
  navigation.subscribe();
  const dimRender = new DimRender(adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState);
  dimRender.subscribe();
  const cycling = new Cycling(adapter, hlState, dynDefs, configLoader, spanFillState, dismissedBlanks, selectorSatelliteState);
  cycling.subscribe();

  // BlankFill: scans for `_` placeholders + matched blank. Owns the
  // detection + sync (stepValues) and async (blankScript) fill paths.
  // E.8 adds the consume-all branch — needs SpanFillState as a writer
  // so E.9's Cycling can read the stash. F.a generalises the same state
  // for multi-word stepValues fills (affirmations etc.).
  const blankFill = new BlankFill(adapter, configLoader, spanFillState, dismissedBlanks, selectorSatelliteState, dynDefs);
  configLoader.load().then(() => blankFill.subscribe()).catch(() => { /* logged */ });
  void blankFill; // silence unused — referenced by future phases

  // Statusline only if the host advertised a path. Don't write to a default
  // location — that risks colliding with another opencues instance.
  if (host.statusFilePath) {
    const statusline = new Statusline(adapter, hlState, dynDefs, {
      exportPath: host.statusFilePath,
      refreshHook: host.refreshStatusline,
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
  const apiKeys: Record<string, string | undefined> = { ...(host.llmApiKeys ?? {}) };
  if (host.llmApiKey && !apiKeys.GROQ_API_KEY) apiKeys.GROQ_API_KEY = host.llmApiKey;
  const hasAnyKey = Object.values(apiKeys).some(Boolean);
  if (hasAnyKey) {
    const resolver = new Resolver(adapter, hlState, dynDefs, configLoader, {
      endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
      defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
      apiKeys,
      debounceMs: host.llmDebounceMs ?? 500,
    }, spanFillState, agentTaskState);
    // AgentRewrite — cadence-driven holistic rewrite with three-way merge.
    const agentRewrite = new AgentRewrite(adapter, dynDefs, agentTaskState, {
      endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
      defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
      // Re-resolves per tick — picks up cues.md `agent-provider:` /
      // `agent-model:` / `llm-provider:` edits without a restart.
      resolveLLM: () => buildAgentLLMResolver(configLoader, apiKeys),
      // Sliding-window mode (lazy thunk so cues.md edits take effect
      // without a restart). 0 = full-buffer; e.g. 200 = cursor ± 100
      // words, expanded to paragraph boundaries.
      windowWords: () => parseInt(configLoader.opencuesState.settings.get('agent-window-words') ?? '0', 10) || 0,
      // Debounce window — re-read on every scheduleTick so users can
      // tweak agent-debounce-ms in OPENCUES.md without restart. NaN /
      // non-positive falls back to 1000 inside AgentRewrite.getCadenceMs.
      cadenceMs: () => parseInt(configLoader.opencuesState.settings.get('agent-debounce-ms') ?? '', 10),
      // Auditor composition — concatenated into the rewrite system
      // prompt. Lazy thunk so AUDITOR.md edits + AUDITORS.md disable[]
      // edits propagate without restart. See spec/auditor-spec.md.
      auditorPrompts: () => configLoader.composeAuditorPrompts(),
    });
    agentRewrite.start();
    configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });
  }

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
      // Synthetic keys go through the same handler list real keystrokes
      // use, but sample text/cursor at dispatch time (the cli.js patch
      // does the same — InputZone closures are stale across React
      // re-renders, so the dispatch site is the only fresh source).
      dispatchKey: (e) => {
        const text = adapter.getText();
        const cursor = adapter.getCursorOffset();
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
      // CC has no cursor-only event type — leave cursor change to the
      // next applyRender's drift detection. Acceptable: synthetic
      // cursor-only injects on CC are rarely interesting (cycling +
      // text drives all the realistic test paths).
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
      const event = normaliseKeyEvent(rawEvent, text, cursorOffset);
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

    applyRender(rendered, text, cursorOffset) {
      checkTextDrift(text, cursorOffset);
      if (typeof rendered !== 'string') return rendered;
      if (renderHandlers.length === 0) return rendered;
      const visibleText = rendered.replace(/\x1b\[[0-9;]*m/g, '');
      const ctx: RenderContext = {
        text: visibleText,
        cursor: cursorOffset,
        externalHighlights: [],
      };
      let out = rendered;
      const debugDirectives: unknown[] = [];
      for (const handler of renderHandlers) {
        try {
          const directives = handler(ctx);
          if (directives) {
            debugDirectives.push(directives);
            out = applyDirectives(out, directives);
          }
        } catch (err) {
          log('error', 'render handler error', err);
        }
      }
      if (isDebugEnabled()) {
        log('debug', 'applyRender', {
          textLen: text.length,
          visibleLen: visibleText.length,
          visiblePreview: visibleText.slice(0, 60),
          hlActive: hlState.active,
          hlWordIdx: hlState.wordIndex,
          directives: debugDirectives,
        });
      }
      return out;
    },
  };
}
