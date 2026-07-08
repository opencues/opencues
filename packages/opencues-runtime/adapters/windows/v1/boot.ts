// Windows v1 host bootstrap.
//
// Runs INSIDE WSL (or any Node host) — it is the brain; the Windows
// machine only runs the thin UIA shim that feeds it. The daemon
// (integrations/windows/src/hostd.cjs) builds a WindowsBindings object
// backed by its socket + buffer mirror, calls boot(host) once, and then:
//   1. Forwards shim text events to notifyTextChange.
//   2. Forwards shim cursor events to notifyCursorChange.
//   3. Forwards shim key events (phase 2) to dispatchKey.
//   4. On adapter.setText, ships a write command back to the shim.
//
// Wiring mirrors the Shell v1 band (buildSharedRuntime → Resolver +
// AgentRewrite + Statusline), minus the terminal-only modules (Kata,
// TTS, cursor-state export) which have no Windows surface in phase 1.
// `supportsCycling: false` (Universal-Integration profile) means the
// resolver prunes every cycleable source at build time — only the
// single-answer surface (fluid-blank / transform-blank / compute
// blanks) is registered.

import { Runtime } from '../../../src/runtime';
import { buildBootApiKeys, pickAutoProvider } from '@opencues/core';
import { WindowsV1Adapter, type WindowsBindings } from './adapter';
import { startEventBridge } from '../../../src/event-bridge';
import { Statusline } from '../../../src/modules/statusline';
import { Resolver } from '../../../src/modules/resolver';
import { AgentRewrite } from '../../../src/modules/agent-rewrite';
import { ConfigLoader } from '../../../src/modules/config-loader';
import {
  buildSharedRuntime,
  createLogFunction,
  buildAgentLLMResolver,
  identityDehydrationFor,
  buildBlankContextProvider,
  buildBlankFetchProvider,
  resetSharedBufferState,
  NATIVE_HOST_MISSING_KEY_MESSAGE,
  nativeHostFormatLLMError,
} from '../../../src/boot-common';
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
  blankInvoke?(spec: import('../../../src/adapter').BlankInvokeSpec):
    import('../../../src/adapter').ProcessHandle | null;
  /** Dynamic cycling answer. Phase 1 leaves it undefined → false. */
  supportsCycling?(): boolean;
}

export interface BootResult {
  dispatchKey(event: KeyEvent): boolean;
  notifyTextChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  notifyCursorChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  collectRenderDirectives(text: string, cursor: number): RenderDirectives[];
  /**
   * Wipe per-buffer runtime state (DynDefs, HighlightState, SpanFill,
   * SelectorSatellite). The Windows host attaches to MANY independent
   * fields across apps, so the daemon MUST fire this on every focus
   * change — the canonical multi-buffer trigger from
   * docs/architecture/universal-integration.md. Also fire on external
   * buffer replacement (a UIA value-change we didn't originate).
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

  const bindings: WindowsBindings = {
    hostVersion: host.hostVersion,
    cwd: host.cwd,
    getText: host.getText,
    getCursorOffset: host.getCursorOffset,
    setText: host.setText,
    setCursorOffset: host.setCursorOffset,
    forceRender: host.forceRender,
    supportsCycling: host.supportsCycling,
    registerKeyHandler: cb => keyEvents.subscribe(cb),
    registerTextChangeHandler: cb => textEvents.subscribe(cb),
    registerCursorChangeHandler: cb => cursorEvents.subscribe(cb),
    registerRenderHandler: cb => renderEvents.subscribe(cb),
    readFile: host.readFile,
    readDir: host.readDir,
    writeFile: host.writeFile,
    spawnProcess: host.spawnProcess as WindowsBindings['spawnProcess'],
    blankInvoke: host.blankInvoke,
    pushText: host.pushText,
    log,
    emitEvent: (type, body) => moduleEvents.emit(
      { type, body },
      err => log('error', 'event handler threw', err),
    ),
    registerEventHandler: cb => moduleEvents.subscribe(({ type, body }) => cb(type, body)),
  };

  const adapter = new WindowsV1Adapter(bindings);
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

  // Same multi-provider key bag every native host builds — resolved
  // from WSL's own process.env + ~/.cues/.env. This is the concrete
  // "plugged into WSL main OC" join: the Windows host dispatches with
  // the exact keys `claude-cues` / `oc-shell` use.
  const apiKeys = buildBootApiKeys(host.llmApiKeys, host.llmApiKey, (m) => log('info', m));
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

  // "Usable LLM" = any env key OR the zero-key subscription-CLI rung.
  const hasAnyKey = Object.values(apiKeys).some(Boolean) || pickAutoProvider(apiKeys) !== null;
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
  buildBlankContextProvider(configLoader, host.blanks, log),
  buildBlankFetchProvider(configLoader, host.blanks, log));
  configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });

  let agentRewrite: AgentRewrite | null = null;
  if (hasAnyKey) {
    agentRewrite = new AgentRewrite(adapter, dynDefs, agentTaskState, {
      endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
      defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
      resolveLLM: () => buildAgentLLMResolver(configLoader, apiKeys),
      identityDehydration: () => identityDehydrationFor(configLoader),
      windowWords: () => parseInt(configLoader.opencuesState.settings.get('agent-window-words') ?? '0', 10) || 0,
      cadenceMs: () => parseInt(configLoader.opencuesState.settings.get('agent-debounce-ms') ?? '', 10),
      auditorPrompts: () => configLoader.composeAuditorPrompts(),
      maxConcurrentAuditors: () => parseInt(configLoader.opencuesState.settings.get('max-concurrent-auditors') ?? '', 10) || 0,
    });
    agentRewrite.start();
  }

  log('info', 'OpenCues runtime starting (Windows v1)', {
    host: 'windows',
    hostVersion: host.hostVersion,
    capabilities: adapter.capabilities,
    supportsCycling: adapter.supportsCycling(),
  });

  if (process.env.OPENCUES_BRIDGE === '1') {
    startEventBridge({
      adapter,
      dispatchKey: (e) => keyEvents.emitUntilConsumed(e, err => log('error', 'key handler threw', err)),
      notifyTextChange: (text, cursor, source) => fireTextChange(text, cursor, source),
      notifyCursorChange: (text, cursor, source) => fireCursorChange(text, cursor, source),
      state: { hlState, dynDefs, spanFillState, selectorSatelliteState, agentTaskState },
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
    notifyTextChange(text, cursorOffset, source) {
      fireTextChange(text, cursorOffset, source);
    },
    notifyCursorChange(text, cursorOffset, source) {
      fireCursorChange(text, cursorOffset, source);
    },
    collectRenderDirectives(text, cursor) {
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
