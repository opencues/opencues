// Chrome extension v1 boot entry.
//
// The content script's only job:
//   1. Build a ChromeBindings object from browser APIs (contenteditable,
//      document.addEventListener, chrome.storage).
//   2. Call boot(host) once on extension mount.
//   3. Forward keydown events to the returned BootResult.dispatchKey.
//
// Mirrors the OpenCode v1.4 boot shape so the two bands drift in
// lockstep when the runtime's module wiring evolves.
//
// Host constraints worth keeping in mind here:
//   - No spawnProcess (see adapter.ts). TTS uses Web Speech; blanks
//     that need external data (stocks/weather/HN) go through fetch().
//   - No TTS script path either — Chrome bypasses the TTS module
//     entirely for now; Web Speech wiring is a future addition.
//   - No live file watch — ConfigLoader.load() re-reads from
//     chrome.storage whenever the popup writes.

import { Runtime } from '../../../src/runtime';
import { ChromeV1Adapter, type ChromeBindings } from './adapter';
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
  BlankInvokeSpec,
  KeyEvent,
  LogLevel,
  ProcessHandle,
  RenderContext,
  RenderDirectives,
  TextChangeEvent,
  Unsubscribe,
} from '../../../src/adapter';

/** Chrome host info — CommonHostInfo plus the sandboxed-host extensions
 *  that don't apply to spawning hosts (opencode). */
export interface HostInfo extends CommonHostInfo {
  /**
   * Host-native blank dispatch. BlankFill + Cycling try this before
   * spawnProcess. Chrome implementations typically dispatch to
   * Web Audio (volume) / fetch() (stocks/weather/HN) / two-step LLM
   * (prompt-improver). Returns ProcessHandle or null when the
   * blankName isn't recognised (runtime falls through to spawnProcess).
   */
  blankInvoke?(spec: BlankInvokeSpec): ProcessHandle | null;
  /**
   * Subprocess execution. Passed by integrations that route through
   * the native-messaging host (`opencues install chrome-host`); they
   * forward the spec to the host via chrome.runtime.sendMessage →
   * service worker → native port. Without this, scripted blanks fail
   * with exitCode 127.
   */
  spawnProcess?(spec: import('../../../src/adapter').ProcessSpec): ProcessHandle;
  /**
   * Speak callback for the TTS module. Chrome extensions pass a Web
   * Speech-backed function here; falling back to the spawn path is
   * impossible in a content-script context.
   */
  speakFn?(text: string, rate?: string): void;
  /**
   * Custom httpAdapter to inject into the Resolver. Chrome extensions
   * can't use NodeHttpAdapter (no node:https); content scripts supply
   * their own fetch()-based adapter here.
   */
  httpAdapter?: unknown;
}

export interface BootResult {
  dispatchKey(event: KeyEvent): boolean;
  notifyTextChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  /** Cursor-only move (no text change). Drives cursor-navigate. */
  notifyCursorChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  collectRenderDirectives(text: string, cursor: number): RenderDirectives[];
  /**
   * Re-read configs from disk (or chrome.storage, whichever the adapter
   * backs readFile/readDir with). Used by the chrome extension to
   * hot-reload on `opencues sync chrome` — polls `dist/configs/.version`
   * and calls this when the hash changes. Returns a promise that
   * resolves when the reload completes.
   */
  reloadConfig(): Promise<void>;
  dispose(): void;
}

export function boot(host: HostInfo): BootResult {
  // Debug gating mirrors OpenCode's pattern — reads opencuesState.debugMode
  // lazily so the popup can flip it without restart.
  let configLoaderRef: ConfigLoader | null = null;
  // Debug gating reads opencuesState.debugMode lazily so the popup/file
  // edit can flip it without restart. No DEBUG_OPENCUES env fallback in
  // the browser — pre-load default is off.
  const log = createLogFunction({
    sink: (level, msg, data) => host.log?.(level, msg, data),
    isDebugEnabled: () => configLoaderRef?.loaded === true
      && configLoaderRef.opencuesState.debugMode === 'on',
  });

  const keyEvents = new EventEmitter<KeyEvent, boolean>();
  const textEvents = new EventEmitter<TextChangeEvent>();
  const cursorEvents = new EventEmitter<import('../../../src/adapter').CursorChangeEvent>();
  const renderEvents = new EventEmitter<RenderContext, RenderDirectives | null>();

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

  const bindings: ChromeBindings = {
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
    pushText: host.pushText,
    blankInvoke: host.blankInvoke,
    spawnProcess: host.spawnProcess,
    log,
  };

  const adapter = new ChromeV1Adapter(bindings);
  Runtime.create(adapter).catch(err => log('error', 'Runtime.create failed', err));

  // Universal state + ConfigLoader + Navigation/DimRender/Cycling/BlankFill
  // all live in boot-common.ts so the chrome and opencode bands can't
  // drift on subscription order or constructor args.
  const shared = buildSharedRuntime(adapter, {
    log,
    configSearchPaths: ['/chrome-storage/.cues'],
    settingsFile: '/chrome-storage/.cues/OPENCUES.md',
  });
  configLoaderRef = shared.configLoader;

  const {
    configLoader, hlState, dynDefs,
    spanFillState, selectorSatelliteState, agentTaskState,
  } = shared;

  // Statusline — Chrome has no filesystem, so exportPath is '' (empty).
  // The snapshot hook delivers the payload to the content script, which
  // renders it into a floating div.
  if (host.statusSnapshotHook) {
    const statusline = new Statusline(adapter, hlState, dynDefs, {
      exportPath: '',
      onSnapshot: (payload) => host.statusSnapshotHook!(payload),
    }, configLoader, spanFillState, selectorSatelliteState, agentTaskState);
    statusline.subscribe();
  }

  // CursorStateExport — opt-in via host.cursorStatePath. Useful for
  // test harnesses that drive the extension via chrome.storage reads.
  if (host.cursorStatePath && adapter.capabilities.includes('file-write')) {
    const cse = new CursorStateExport(adapter, { exportPath: host.cursorStatePath });
    cse.subscribe();
  }

  // TTS — opt-in via host.speakFn. Chrome routes tip → Web Speech via
  // the runtime TTS module's speakFn option (no spawnProcess in a
  // content-script context).
  if (host.speakFn) {
    const tts = new TTS(adapter, hlState, dynDefs, configLoader, {
      speakFn: host.speakFn,
      rate: host.ttsRate !== undefined ? String(host.ttsRate) : undefined,
    }, spanFillState, selectorSatelliteState);
    tts.subscribe();
  }

  // Resolver — opt-in via llmApiKey. Chrome injects its own fetch-
  // based httpAdapter because NodeHttpAdapter (node:https) doesn't
  // exist in a content-script context.
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
      httpAdapter: host.httpAdapter,
    }, spanFillState, agentTaskState, shared.blankLoading);
    configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });

    const httpAdapter = host.httpAdapter as { post(url: string, body: string, headers: Record<string, string>): Promise<string> };
    const agentRewrite = new AgentRewrite(adapter, dynDefs, agentTaskState, {
      endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
      defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
      httpAdapter,
      resolveLLM: () => buildAgentLLMResolver(configLoader, apiKeys),
      // Sliding-window mode (lazy thunk so CUES.md edits take effect
      // without a restart). 0 = full-buffer; useful for long docs in
      // textareas where token cost dominates.
      windowWords: () => parseInt(configLoader.opencuesState.settings.get('agent-window-words') ?? '0', 10) || 0,
      cadenceMs: () => parseInt(configLoader.opencuesState.settings.get('agent-debounce-ms') ?? '', 10),
      auditorPrompts: () => configLoader.composeAuditorPrompts(),
      maxConcurrentAuditors: () => parseInt(configLoader.opencuesState.settings.get('max-concurrent-auditors') ?? '', 10) || 0,
    });
    agentRewrite.start();
  }

  log('info', 'OpenCues runtime starting (Chrome v1)', {
    host: 'chrome',
    hostVersion: host.hostVersion,
    capabilities: adapter.capabilities,
  });

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
      // Observe-only: update lastSeenText/Cursor without synthesising
      // events. See adapters/oc/REPAIR.md "Drift guard" for why
      // synthetic fires break runtime-initiated text writes.
      lastSeenText = text;
      lastSeenCursor = cursor;
      const ctx: RenderContext = { text, cursor, externalHighlights: [] };
      return renderEvents.collect(ctx, err => log('error', 'render handler threw', err));
    },
    async reloadConfig() {
      // ConfigLoader.load() re-reads every search path, re-parses, and
      // fires onTextChange-style re-renders downstream. Used by the
      // chrome extension's .version polling loop.
      await shared.configLoader.load();
    },
    dispose() {
      adapter.dispose();
      keyEvents.clear();
      textEvents.clear();
      cursorEvents.clear();
      renderEvents.clear();
    },
  };
}
