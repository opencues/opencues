// VS Code v1 host bootstrap.
//
// The extension glue's job (integrations/vscode/src/extension.ts):
//   1. Build a VscodeBindings object over the VS Code extension API —
//      buffer closures reading through a single current-editor pointer.
//   2. Call boot(host) once on activation.
//   3. Forward contributed-command invocations to BootResult.dispatchKey
//      as synthesized KeyEvents (VS Code exposes no raw key stream).
//   4. On onDidChangeTextDocument (filtered to the current document,
//      source-reclassified), call notifyTextChange + collect render
//      directives, which the glue paints as editor decorations.
//   5. Call resetBufferState() on every real document switch, undo/redo,
//      external mutation, and doc close (PLAN.md D3 / Q14).
//
// Wiring mirrors shell/v1 (the other self-owned host) with chrome/v1's
// dynamic capability probes threaded through. The band deliberately
// contains no `vscode`-module imports — everything host-API-shaped
// lives in the integration glue, so this file stays testable in plain
// Node (same rule as every other band).

import { Runtime } from '../../../src/runtime';
import { VscodeV1Adapter, type VscodeBindings } from './adapter';
import { startEventBridge } from '../../../src/event-bridge';
import { Statusline } from '../../../src/modules/statusline';
import { Resolver } from '../../../src/modules/resolver';
import { AgentRewrite } from '../../../src/modules/agent-rewrite';
import { TTS } from '../../../src/modules/tts';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { buildSharedRuntime, createLogFunction, buildAgentLLMResolver, buildBlankContextProvider, buildBlankFetchProvider, resetSharedBufferState, NATIVE_HOST_MISSING_KEY_MESSAGE, nativeHostFormatLLMError } from '../../../src/boot-common';
import { EventEmitter } from '../../../src/lib/event-emitter';
import type {
  CommonHostInfo,
  KeyEvent,
  RenderContext,
  RenderDirectives,
  TextChangeEvent,
  CursorChangeEvent,
  BlankInvokeSpec,
  ProcessHandle,
  ProcessSpec,
} from '../../../src/adapter';

/** Default AgentRewrite window when the user hasn't set
 *  `agent-window-words`. Non-zero ON THIS BAND ONLY (every other host
 *  defaults 0/off): VS Code is the first genuinely large-buffer host,
 *  and an unbounded whole-document rewrite per tick is the wrong
 *  default cost profile (PLAN.md D14). An explicit OPENCUES.md value —
 *  including `0` to restore whole-buffer — always wins. */
export const VSCODE_DEFAULT_AGENT_WINDOW_WORDS = 400;

/** Band-default resolution for `agent-window-words`: absent/blank/
 *  unparsable → VSCODE_DEFAULT_AGENT_WINDOW_WORDS; any explicit number
 *  (including 0 = whole-buffer) wins. Exported for boot.test.ts. */
export function resolveAgentWindowWords(raw: string | undefined): number {
  const parsed = raw === undefined || raw === '' ? NaN : parseInt(raw, 10);
  return Number.isNaN(parsed) ? VSCODE_DEFAULT_AGENT_WINDOW_WORDS : parsed;
}

export interface HostInfo extends CommonHostInfo {
  spawnProcess?(spec: ProcessSpec): ProcessHandle;
  blankInvoke?(spec: BlankInvokeSpec): ProcessHandle | null;
  /** In-process TTS (D16). The spawn path hard-codes `bash` + a staged
   *  speak.sh, which breaks on Windows VS Code hosts; the glue passes a
   *  speakFn when it can provide one, else TTS is skipped. */
  speakFn?: (text: string, rate?: string) => void;
  ttsScriptPath?: string;
  supportsCycling?(): boolean;
  supportsAgentRewrite?(): boolean;
}

export interface BootResult {
  dispatchKey(event: KeyEvent): boolean;
  notifyTextChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  notifyCursorChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  collectRenderDirectives(text: string, cursor: number): RenderDirectives[];
  /**
   * Wipe per-buffer runtime state (DynDefs, HighlightState, SpanFill,
   * SelectorSatellite, resolver build key, module caches). The glue
   * MUST fire this on: active-editor change to a different document,
   * document close, undo/redo, detected external mutation (formatter /
   * other extension), and IME commit. See
   * docs/architecture/universal-integration.md § resetBufferState and
   * PLAN.md Q14. Idempotent.
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

  const bindings: VscodeBindings = {
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
    spawnProcess: host.spawnProcess,
    blankInvoke: host.blankInvoke,
    pushText: host.pushText,
    log,
    emitEvent: (type, body) => moduleEvents.emit(
      { type, body },
      err => log('error', 'event handler threw', err),
    ),
    registerEventHandler: cb => moduleEvents.subscribe(({ type, body }) => cb(type, body)),
    supportsCycling: host.supportsCycling,
    supportsAgentRewrite: host.supportsAgentRewrite,
  };

  const adapter = new VscodeV1Adapter(bindings);
  Runtime.create(adapter).catch(err => log('error', 'Runtime.create failed', err));

  const HOME = process.env.HOME ?? '~';
  // host.cwd is the workspace root the glue resolved — NEVER
  // process.cwd(), which is arbitrary in an extension host (OC LF-4).
  const configSearchPaths = [
    ...(process.env.OPENCUES_HOME ? [process.env.OPENCUES_HOME] : []),
    `${host.cwd}/.cues`,
    `${HOME}/.cues`,
  ];
  const settingsFile = process.env.OPENCUES_HOME
    ? `${process.env.OPENCUES_HOME}/OPENCUES.md`
    : `${HOME}/.cues/OPENCUES.md`;
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

  // TTS: speakFn wins (D16); the spawn path is accepted only when the
  // glue explicitly stages a script AND the host can spawn.
  if (host.speakFn || (host.ttsScriptPath && adapter.capabilities.includes('spawn-process'))) {
    const tts = new TTS(adapter, hlState, dynDefs, configLoader, {
      scriptPath: host.ttsScriptPath,
      speakFn: host.speakFn,
      rate: host.ttsRate !== undefined ? String(host.ttsRate) : undefined,
    }, spanFillState, selectorSatelliteState);
    tts.subscribe();
  }

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
      windowWords: () => resolveAgentWindowWords(configLoader.opencuesState.settings.get('agent-window-words')),
      cadenceMs: () => parseInt(configLoader.opencuesState.settings.get('agent-debounce-ms') ?? '', 10),
      auditorPrompts: () => configLoader.composeAuditorPrompts(),
      maxConcurrentAuditors: () => parseInt(configLoader.opencuesState.settings.get('max-concurrent-auditors') ?? '', 10) || 0,
    });
    agentRewrite.start();
  }

  log('info', 'OpenCues runtime starting (VS Code v1)', {
    host: 'vscode',
    hostVersion: host.hostVersion,
    capabilities: adapter.capabilities,
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
      // Observe-only (same contract as shell/OC) — Cycling synchronously
      // writes text then forceRenders before the change event fires, so
      // any "drift" synthesized here would be the cycle, not the user.
      lastSeenText = text;
      lastSeenCursor = cursor;
      const ctx: RenderContext = { text, cursor, externalHighlights: [] };
      return renderEvents.collect(ctx, err => log('error', 'render handler threw', err));
    },
    resetBufferState() {
      // Also resets the boot-closure diff baseline: the next document's
      // first change event must not diff against the previous document.
      lastSeenText = null;
      lastSeenCursor = 0;
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
