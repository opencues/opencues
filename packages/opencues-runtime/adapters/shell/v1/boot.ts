// Shell v1 host bootstrap.
//
// The terminal-side app's job:
//   1. Build a ShellBindings object from its TUI primitives (an
//      OpenTUI TextareaRenderable + the renderer for forceRender).
//   2. Call boot(host) once on app mount.
//   3. Forward useKeyboard events to BootResult.dispatchKey.
//   4. On textarea onContentChange, call notifyTextChange + ask the
//      runtime for render directives, which the app applies as extmarks.
//
// Identical wiring to the OC v1.14 band — the underlying primitive
// (OpenTUI TextareaRenderable) is the same. The split exists so the
// host-name/version surface stays accurate (`adapter.hostName ===
// 'shell'`) and so future divergence between the two doesn't
// require rebooting OpenCode users.

import { Runtime } from '../../../src/runtime';
import { ShellV1Adapter, type ShellBindings } from './adapter';
import { startEventBridge } from '../../../src/event-bridge';
import { Statusline } from '../../../src/modules/statusline';
import { Resolver } from '../../../src/modules/resolver';
import { AgentRewrite } from '../../../src/modules/agent-rewrite';
import { TTS } from '../../../src/modules/tts';
import { CursorStateExport } from '../../../src/modules/cursor-state-export';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { buildSharedRuntime, createLogFunction, buildAgentLLMResolver, buildBlankContextProvider, resetSharedBufferState, NATIVE_HOST_MISSING_KEY_MESSAGE, nativeHostFormatLLMError } from '../../../src/boot-common';
import { EventEmitter } from '../../../src/lib/event-emitter';
import type {
  CommonHostInfo,
  KeyEvent,
  RenderContext,
  RenderDirectives,
  TextChangeEvent,
  CursorChangeEvent,
} from '../../../src/adapter';

export interface HostInfo extends CommonHostInfo {
  spawnProcess?(spec: unknown): unknown;
  ttsScriptPath?: string;
  blankInvoke?(spec: import('../../../src/adapter').BlankInvokeSpec):
    import('../../../src/adapter').ProcessHandle | null;
}

export interface BootResult {
  dispatchKey(event: KeyEvent): boolean;
  notifyTextChange(text: string, cursorOffset: number, source: 'user' | 'runtime', previousText?: string): void;
  notifyCursorChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  collectRenderDirectives(text: string, cursor: number): RenderDirectives[];
  /**
   * Wipe per-buffer runtime state (DynDefs, HighlightState, SpanFill,
   * SelectorSatellite). Fire whenever an external mutation has invalidated
   * the runtime's tracked spans — e.g. host-level undo, paste, IME commit,
   * or any UI write that bypasses the runtime's setText pipeline.
   * Idempotent. See `resetSharedBufferState` in `src/boot-common.ts` for
   * the full rationale + the state objects deliberately NOT wiped
   * (agentTaskState, dismissedBlanks).
   */
  resetBufferState(): void;
  dispose(): void;
}

export function boot(host: HostInfo): BootResult {
  let configLoaderRef: ConfigLoader | null = null;
  const log = createLogFunction({
    sink: (level, msg, data) => host.log?.(level, msg, data),
    isDebugEnabled: () => configLoaderRef?.loaded === true
      ? configLoaderRef.opencuesState.debugMode === 'on'
      : !!process.env.DEBUG_OPENCUES,
  });

  const keyEvents = new EventEmitter<KeyEvent, boolean>();
  const textEvents = new EventEmitter<TextChangeEvent>();
  const cursorEvents = new EventEmitter<CursorChangeEvent>();
  const renderEvents = new EventEmitter<RenderContext, RenderDirectives | null>();
  const moduleEvents = new EventEmitter<{ type: string; body?: Record<string, unknown> }>();

  let lastSeenText: string | null = null;
  let lastSeenCursor = 0;
  const fireTextChange = (text: string, cursor: number, source: 'user' | 'runtime', previousText?: string): void => {
    textEvents.emit(
      { text, cursorOffset: cursor, previousText: previousText ?? lastSeenText ?? '', source },
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

  const bindings: ShellBindings = {
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
    spawnProcess: host.spawnProcess as ShellBindings['spawnProcess'],
    blankInvoke: host.blankInvoke,
    pushText: host.pushText,
    log,
    emitEvent: (type, body) => moduleEvents.emit(
      { type, body },
      err => log('error', 'event handler threw', err),
    ),
    registerEventHandler: cb => moduleEvents.subscribe(({ type, body }) => cb(type, body)),
  };

  const adapter = new ShellV1Adapter(bindings);
  Runtime.create(adapter).catch(err => log('error', 'Runtime.create failed', err));

  const HOME = process.env.HOME ?? '~';
  const configSearchPaths = [
    ...(process.env.OPENCUES_HOME ? [process.env.OPENCUES_HOME] : []),
    `${host.cwd}/.cues`,
    `${HOME}/.cues`,
  ];
  const settingsFile = process.env.OPENCUES_HOME
    ? `${process.env.OPENCUES_HOME}/OPENCUES.md`
    : `${HOME}/.cues/OPENCUES.md`;
  // Build the multi-provider key bag here so Cycling's satellite
  // filter sees the same bag the Resolver dispatches against below.
  const apiKeys: Record<string, string | undefined> = { ...(host.llmApiKeys ?? {}) };
  if (host.llmApiKey && !apiKeys.GROQ_API_KEY) apiKeys.GROQ_API_KEY = host.llmApiKey;
  const shared = buildSharedRuntime(adapter, {
    log, configSearchPaths, settingsFile,
    getApiKeys: () => apiKeys,
  });
  configLoaderRef = shared.configLoader;

  const {
    configLoader, hlState, dynDefs,
    spanFillState, selectorSatelliteState, agentTaskState,
  } = shared;

  if (host.statusFilePath || host.statusSnapshotHook) {
    const statusline = new Statusline(adapter, hlState, dynDefs, {
      exportPath: host.statusFilePath ?? '',
      onSnapshot: host.statusSnapshotHook
        ? (payload) => host.statusSnapshotHook!(payload)
        : undefined,
    }, configLoader, spanFillState, selectorSatelliteState, agentTaskState);
    statusline.subscribe();
  }

  if (host.cursorStatePath && adapter.capabilities.includes('file-write')) {
    const cse = new CursorStateExport(adapter, { exportPath: host.cursorStatePath });
    cse.subscribe();
  }

  if (host.ttsScriptPath && adapter.capabilities.includes('spawn-process')) {
    const tts = new TTS(adapter, hlState, dynDefs, configLoader, {
      scriptPath: host.ttsScriptPath,
      rate: host.ttsRate !== undefined ? String(host.ttsRate) : undefined,
    }, spanFillState, selectorSatelliteState);
    tts.subscribe();
  }

  // `apiKeys` is built above (before buildSharedRuntime) so Cycling's
  // satellite filter sees the same bag.
  const hasAnyKey = Object.values(apiKeys).some(Boolean);
  // Resolver constructed even with no keys so MissingKeyFallbackSource
  // surfaces a visible in-buffer hint on `_` instead of silent no-op.
  const resolver = new Resolver(adapter, hlState, dynDefs, configLoader, {
    endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
    defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
    apiKeys,
    debounceMs: host.llmDebounceMs ?? 500,
    missingKeyFallbackMessage: hasAnyKey ? undefined : NATIVE_HOST_MISSING_KEY_MESSAGE,
    formatLLMErrorAsSubstitute: nativeHostFormatLLMError,
    keywordBoundSlotIndices: (text: string) => shared.blankFill.scan(text).map(s => s.index),
  }, spanFillState, agentTaskState, shared.blankLoading, shared.markdownRender, selectorSatelliteState,
  buildBlankContextProvider(configLoader, host.blanks, log));
  configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });

  // Hoist agentRewrite outside the `if (hasAnyKey)` block so the
  // resetBufferState path below can reach it. Mirrors oc/v1.14:264.
  let agentRewrite: AgentRewrite | null = null;
  if (hasAnyKey) {

    agentRewrite = new AgentRewrite(adapter, dynDefs, agentTaskState, {
      endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
      defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
      resolveLLM: () => buildAgentLLMResolver(configLoader, apiKeys),
      windowWords: () => parseInt(configLoader.opencuesState.settings.get('agent-window-words') ?? '0', 10) || 0,
      cadenceMs: () => parseInt(configLoader.opencuesState.settings.get('agent-debounce-ms') ?? '', 10),
      auditorPrompts: () => configLoader.composeAuditorPrompts(),
      maxConcurrentAuditors: () => parseInt(configLoader.opencuesState.settings.get('max-concurrent-auditors') ?? '', 10) || 0,
    });
    agentRewrite.start();
  }

  log('info', 'OpenCues runtime starting (Shell v1)', {
    host: 'shell',
    hostVersion: host.hostVersion,
    capabilities: adapter.capabilities,
  });

  if (process.env.OPENCUES_BRIDGE === '1') {
    startEventBridge({
      adapter,
      dispatchKey: (e) => keyEvents.emitUntilConsumed(e, err => log('error', 'key handler threw', err)),
      notifyTextChange: (text, cursor, source, previousText) => fireTextChange(text, cursor, source, previousText),
      notifyCursorChange: (text, cursor, source) => fireCursorChange(text, cursor, source),
      state: { hlState, dynDefs, spanFillState, selectorSatelliteState, agentTaskState },
      // Wire the SAME reset that the host's resetBufferState calls so the
      // bridge `reset` command drops DynDefs / SpanFill / SelectorSatellite /
      // runtime module caches / Resolver source rebuilds (including the
      // static TransformBlankSource variant pool). Without this binding
      // the bridge `reset` was a silent no-op on shell — any off-process
      // bridge driver calling it got a half-reset where the buffer
      // ephemeral state cleared but cached LLM rewrites kept returning.
      // The bridge is documented as a runtime introspection surface
      // (integrations/shell/CLAUDE.md § Debugging); the OC and chrome
      // adapters wire this same binding — shell was the outlier.
      resetBufferState: () => resetSharedBufferState({
        ...shared,
        resolver,
        ...(agentRewrite ? { agentRewrite } : {}),
      }),
    });
  }

  return {
    dispatchKey(event) {
      return keyEvents.emitUntilConsumed(event, err => log('error', 'key handler threw', err));
    },
    notifyTextChange(text, cursorOffset, source, previousText) {
      fireTextChange(text, cursorOffset, source, previousText);
    },
    notifyCursorChange(text, cursorOffset, source) {
      fireCursorChange(text, cursorOffset, source);
    },
    collectRenderDirectives(text, cursor) {
      // Observe-only (same contract as OC) — Cycling synchronously
      // writes text then forceRenders before onContentChange fires,
      // so any "drift" we'd synthesise here is the cycle, not the user.
      lastSeenText = text;
      lastSeenCursor = cursor;
      const ctx: RenderContext = { text, cursor, externalHighlights: [] };
      return renderEvents.collect(ctx, err => log('error', 'render handler threw', err));
    },
    resetBufferState() {
      resetSharedBufferState({
        ...shared,
        resolver,
        ...(agentRewrite ? { agentRewrite } : {}),
      });
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
