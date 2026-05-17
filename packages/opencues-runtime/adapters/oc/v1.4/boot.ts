// Single entry point for the OpenCode v1.4 host bootstrap.
//
// The OpenCode-side patch's only job:
//   1. Build an OpenCodeBindings object from its TUI primitives
//      (TextareaRenderable, useKeyboard, useRenderer).
//   2. Call boot(host) once on TUI mount.
//   3. Forward useKeyboard events to the returned BootResult.dispatchKey.
//
// Mirrors the Claude Code v2.1 pattern; everything else lives in the
// host-agnostic `opencues-runtime` modules.

import { Runtime } from '../../../src/runtime';
import { OpenCodeV14Adapter, type OpenCodeBindings } from './adapter';
import { startEventBridge } from '../../../src/event-bridge';
import { Statusline } from '../../../src/modules/statusline';
import { Resolver } from '../../../src/modules/resolver';
import { AgentRewrite } from '../../../src/modules/agent-rewrite';
import { TTS } from '../../../src/modules/tts';
import { CursorStateExport } from '../../../src/modules/cursor-state-export';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { buildSharedRuntime, createLogFunction, buildAgentLLMResolver } from '../../../src/boot-common';
import { EventEmitter } from '../../../src/lib/event-emitter';
import type {
  CommonHostInfo,
  KeyEvent,
  LogLevel,
  RenderContext,
  RenderDirectives,
  TextChangeEvent,
  Unsubscribe,
} from '../../../src/adapter';

/** OpenCode host info — CommonHostInfo plus the spawn-based extensions
 *  that don't apply to sandboxed hosts (chrome). */
export interface HostInfo extends CommonHostInfo {
  /** node:child_process.spawn shim — opencode supplies the real thing,
   *  the runtime's spawnProcess capability check is gated on its
   *  presence in the bindings. */
  spawnProcess?(spec: unknown): unknown;
  /** Optional: TTS script path. spawn-process must be available. */
  ttsScriptPath?: string;
  /**
   * Optional host-native blank dispatch. Same shape as chrome's
   * blankInvoke — BlankFill + Cycling try this BEFORE spawnProcess so
   * shared TS blanks (HackerNewsBlank, etc.) win over the legacy
   * shell scripts in blanks/. Returns null when the blankName
   * isn't in the host's registry; runtime then falls through to
   * spawnProcess (still works for OS blanks like volume/brightness).
   */
  blankInvoke?(spec: import('../../../src/adapter').BlankInvokeSpec):
    import('../../../src/adapter').ProcessHandle | null;
}

export interface BootResult {
  /** Call from useKeyboard's callback. Returns true if OpenCues consumed the event. */
  dispatchKey(event: KeyEvent): boolean;
  /** Call when the prompt input value changes (from onInput). */
  notifyTextChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  /** Call when the cursor moves WITHOUT the text changing (mouse click,
   *  arrow keys, focus). The patched Prompt component watches its
   *  cursor offset and fires this when it changes alone. Idempotent —
   *  no-op when the offset matches the last-seen value. */
  notifyCursorChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  /**
   * O.4 — collect render directives from all subscribed handlers
   * (DimRender + future modules). The patch turns the result into
   * extmarks on the textarea.
   */
  collectRenderDirectives(text: string, cursor: number): RenderDirectives[];
  /** Call to dispose the runtime (e.g. on TUI unmount). */
  dispose(): void;
}

export function boot(host: HostInfo): BootResult {
  // configLoader is constructed below; isDebugEnabled reads it lazily
  // so OPENCUES.md `debug-mode: on/off` hot-reloads without restart.
  // DEBUG_OPENCUES env is a bootstrap fallback for logs fired before
  // ConfigLoader.load resolves.
  let configLoaderRef: ConfigLoader | null = null;
  // Debug gating reads opencuesState.debugMode lazily so OPENCUES.md
  // `debug-mode: on/off` hot-reloads without restart. DEBUG_OPENCUES env
  // is a bootstrap fallback for logs fired before ConfigLoader.load resolves.
  const log = createLogFunction({
    sink: (level, msg, data) => host.log?.(level, msg, data),
    isDebugEnabled: () => configLoaderRef?.loaded === true
      ? configLoaderRef.opencuesState.debugMode === 'on'
      : !!process.env.DEBUG_OPENCUES,
  });

  const keyEvents = new EventEmitter<KeyEvent, boolean>();
  const textEvents = new EventEmitter<TextChangeEvent>();
  const cursorEvents = new EventEmitter<import('../../../src/adapter').CursorChangeEvent>();
  const renderEvents = new EventEmitter<RenderContext, RenderDirectives | null>();
  // Module-emitted structured events. Modules call adapter.emitEvent
  // at lifecycle boundaries (resolver.completed, blank.substituted,
  // transform-blank.pass, …); subscribers observe via adapter.onEvent.
  // Cheap when not subscribed — emit is just textEvents.emit with no
  // listeners.
  const moduleEvents = new EventEmitter<{ type: string; body?: Record<string, unknown> }>();

  // Text observation tracking. Used to populate `previousText` on
  // notifyTextChange events. We do NOT synthesise text-change events
  // when collectRenderDirectives sees drift — the bootstrap can't
  // reliably tell user-typed drift apart from a runtime-initiated
  // setText/pushText that hasn't yet flowed through SolidJS's
  // onContentChange (Cycling.cycleBlank → setText → forceRender all
  // run synchronously, before onContentChange fires). Synthesising
  // 'user' there clears the highlight and the next Resolver pass
  // pollutes the now-unattributed word with LLM alts.
  let lastSeenText: string | null = null;
  let lastSeenCursor = 0;
  const fireTextChange = (text: string, cursor: number, source: 'user' | 'runtime'): void => {
    textEvents.emit(
      { text, cursorOffset: cursor, previousText: lastSeenText ?? '', source },
      err => log('error', 'text handler threw', err),
    );
    lastSeenText = text;
    lastSeenCursor = cursor;
  };

  const fireCursorChange = (text: string, cursor: number, source: 'user' | 'runtime'): void => {
    if (cursor === lastSeenCursor && text === lastSeenText) return;
    cursorEvents.emit(
      { text, cursorOffset: cursor, source },
      err => log('error', 'cursor handler threw', err),
    );
    lastSeenCursor = cursor;
    lastSeenText = text;
  };

  const bindings: OpenCodeBindings = {
    hostVersion: host.hostVersion,
    cwd: host.cwd,
    getText: host.getText,
    getCursorOffset: host.getCursorOffset,
    setText: host.setText,
    setCursorOffset: host.setCursorOffset,
    forceRender: host.forceRender,
    registerKeyHandler: cb => keyEvents.subscribe(cb),
    registerTextChangeHandler: cb => textEvents.subscribe(cb),
    registerCursorChangeHandler: cb => cursorEvents.subscribe(cb),
    registerRenderHandler: cb => renderEvents.subscribe(cb),
    readFile: host.readFile,
    readDir: host.readDir,
    writeFile: host.writeFile,
    spawnProcess: host.spawnProcess as OpenCodeBindings['spawnProcess'],
    blankInvoke: host.blankInvoke,
    pushText: host.pushText,
    log,
    emitEvent: (type, body) => moduleEvents.emit(
      { type, body },
      err => log('error', 'event handler threw', err),
    ),
    registerEventHandler: cb => moduleEvents.subscribe(({ type, body }) => cb(type, body)),
  };

  const adapter = new OpenCodeV14Adapter(bindings);
  Runtime.create(adapter).catch(err => log('error', 'Runtime.create failed', err));

  // Universal state + ConfigLoader + Navigation/DimRender/Cycling/BlankFill
  // all live in boot-common.ts so the chrome and opencode bands can't
  // drift on subscription order or constructor args. Tips come from
  // CUES.md's `## Tips` block — no separate JSON file.
  const HOME = process.env.HOME ?? '~';
  const configSearchPaths = [
    ...(process.env.OPENCUES_HOME ? [process.env.OPENCUES_HOME] : []),
    `${host.cwd}/.cues`,
    `${HOME}/.cues`,
  ];
  const settingsFile = process.env.OPENCUES_HOME
    ? `${process.env.OPENCUES_HOME}/OPENCUES.md`
    : `${HOME}/.cues/OPENCUES.md`;
  const shared = buildSharedRuntime(adapter, { log, configSearchPaths, settingsFile });
  configLoaderRef = shared.configLoader; // wires isDebugEnabled to OPENCUES.md

  const {
    configLoader, hlState, dynDefs,
    spanFillState, selectorSatelliteState, agentTaskState,
  } = shared;

  // Statusline (file-based) + in-process snapshot hook so the OpenCode
  // footer can render the tip natively. Both sinks are opt-in; either
  // or both can be wired.
  if (host.statusFilePath || host.statusSnapshotHook) {
    const statusline = new Statusline(adapter, hlState, dynDefs, {
      exportPath: host.statusFilePath ?? '',
      onSnapshot: host.statusSnapshotHook
        ? (payload) => host.statusSnapshotHook!(payload)
        : undefined,
    }, configLoader, spanFillState, selectorSatelliteState, agentTaskState);
    statusline.subscribe();
  }

  // CursorStateExport — opt-in. External tooling can read the export
  // for buffer/cursor inspection; no in-tree consumer.
  if (host.cursorStatePath && adapter.capabilities.includes('file-write')) {
    const cse = new CursorStateExport(adapter, { exportPath: host.cursorStatePath });
    cse.subscribe();
  }

  // TTS. Opt-in via host.ttsScriptPath + spawn-process cap.
  if (host.ttsScriptPath && adapter.capabilities.includes('spawn-process')) {
    const tts = new TTS(adapter, hlState, dynDefs, configLoader, {
      scriptPath: host.ttsScriptPath,
      rate: host.ttsRate !== undefined ? String(host.ttsRate) : undefined,
    }, spanFillState, selectorSatelliteState);
    tts.subscribe();
  }

  // LLM Resolver. Opt-in via any LLM key being available
  // (legacy `llmApiKey` OR any entry in the multi-provider `llmApiKeys`
  // map). The resolver routes per-cue / per-blank / per-feature requests
  // to whichever provider the user has configured in OPENCUES.md.
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
    }, spanFillState, agentTaskState, shared.blankLoading, shared.markdownRender);
    // Subscribe AFTER ConfigLoader.load — otherwise rebuildResolver sees
    // no cuesConfig/blanksConfig and bails. Mirrors CC v2.1 boot.
    configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });

    // AgentRewrite — cadence-driven holistic rewrite with three-way
    // merge. Single agent path; the legacy AgentLoop / Judge were
    // removed once AgentRewrite proved its merge layer made the
    // per-edit guards structurally unnecessary.
    const agentRewrite = new AgentRewrite(adapter, dynDefs, agentTaskState, {
      endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
      defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
      // Re-resolves per tick so OPENCUES.md edits to `agent-provider:` /
      // `agent-model:` / `llm-provider:` take effect without a restart.
      // null means "use the static fallback" — usually transient until
      // OPENCUES.md is fully loaded.
      resolveLLM: () => buildAgentLLMResolver(configLoader, apiKeys),
      windowWords: () => parseInt(configLoader.opencuesState.settings.get('agent-window-words') ?? '0', 10) || 0,
      cadenceMs: () => parseInt(configLoader.opencuesState.settings.get('agent-debounce-ms') ?? '', 10),
      auditorPrompts: () => configLoader.composeAuditorPrompts(),
      maxConcurrentAuditors: () => parseInt(configLoader.opencuesState.settings.get('max-concurrent-auditors') ?? '', 10) || 0,
    });
    agentRewrite.start();
  }

  log('info', 'OpenCues runtime starting (OpenCode v1.4)', {
    host: 'opencode',
    hostVersion: host.hostVersion,
    capabilities: adapter.capabilities,
  });

  // Internal event-bridge — opt-in via OPENCUES_BRIDGE=1. Polls a
  // synthetic-input file and forwards module events to a JSONL stream
  // for off-process tooling.
  //
  // notifyTextChange + notifyCursorChange are wired through to the same
  // emitters bootResult.notifyTextChange + .notifyCursorChange use, so
  // synthetic injects reach the Resolver / Statusline / CursorStateExport
  // pipeline directly. Without this, OpenTUI's `replaceText` (the
  // underlying setText sink) skips onContentChange and the resolver
  // never sees the buffer change.
  if (process.env.OPENCUES_BRIDGE === '1') {
    startEventBridge({
      adapter,
      dispatchKey: (e) => keyEvents.emitUntilConsumed(e, err => log('error', 'key handler threw', err)),
      notifyTextChange: (text, cursor, source) => fireTextChange(text, cursor, source),
      notifyCursorChange: (text, cursor, source) => fireCursorChange(text, cursor, source),
      state: { hlState, dynDefs, spanFillState, selectorSatelliteState, agentTaskState },
    });
  }

  return {
    dispatchKey(event) {
      return keyEvents.emitUntilConsumed(event, err => log('error', 'key handler threw', err));
    },
    notifyTextChange(text, cursorOffset, source) {
      fireTextChange(text, cursorOffset, source);
    },
    notifyCursorChange(text, cursorOffset, source) {
      fireCursorChange(text, cursorOffset, source);
    },
    collectRenderDirectives(text, cursor) {
      // Observe-only — never synthesise textChange here (see comment by
      // lastSeenText declaration). Cycling.cycleBlank + forceRender
      // race onContentChange and would otherwise look like user drift.
      lastSeenText = text;
      lastSeenCursor = cursor;
      const ctx: RenderContext = { text, cursor, externalHighlights: [] };
      return renderEvents.collect(ctx, err => log('error', 'render handler threw', err));
    },
    dispose() {
      adapter.dispose();
      keyEvents.clear();
      textEvents.clear();
      cursorEvents.clear();
      renderEvents.clear();
      moduleEvents.clear();
    },
  };
}
