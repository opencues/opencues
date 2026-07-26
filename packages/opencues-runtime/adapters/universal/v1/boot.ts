// Universal v1 host bootstrap — the no-cycling profile shared by every
// daemon-shaped host without a key/render channel (apple-notes, mac).
//
// The daemon is the "host app":
//   1. Build a UniversalBindings-shaped HostInfo around its text
//      channel (poll snapshots, AX events, …) and declare hostName.
//   2. Call boot(host) once per process.
//   3. On every buffer change, call
//      BootResult.notifyTextChange(text, cursor, source) — source is
//      'runtime' for the daemon's own write echoes, else 'user'.
//   4. On buffer switch (active note / focused element), call
//      resetBufferState().
//
// Structurally a slimmed clone of adapters/shell/v1/boot.ts: no key
// channel, no cursor channel, no render directives, no TTS, no
// AgentRewrite (supportsAgentRewrite() is false), no CursorStateExport,
// and no KataCoach — DELIBERATELY excluded, not deferred: kata's wiring
// contract requires observeKey as the FIRST key subscriber
// (docs/architecture/kata.md § host wiring), and this host's only key
// events are the daemon's synthetic `_` arms; there is no keyboard to
// observe, no Esc×3 escape hatch, and no statusline surface to render
// the coach. The universal/no-cycling profile prunes cycleable
// cues/blanks at registration via supportsCycling() — see
// docs/architecture/universal-integration.md.

import { Runtime } from '../../../src/runtime';
import { UniversalV1Adapter, type UniversalBindings } from './adapter';
import { startEventBridge } from '../../../src/event-bridge';
import { Statusline } from '../../../src/modules/statusline';
import { Resolver } from '../../../src/modules/resolver';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { buildSharedRuntime, createLogFunction, buildBlankContextProvider, buildBlankFetchProvider, resetSharedBufferState, buildCalendarContextIngest, NATIVE_HOST_MISSING_KEY_MESSAGE, nativeHostFormatLLMError } from '../../../src/boot-common';
import { buildBootApiKeys, pickAutoProvider } from '@opencues/core';
import { EventEmitter } from '../../../src/lib/event-emitter';
import type {
  CommonHostInfo,
  KeyEvent,
  TextChangeEvent,
} from '../../../src/adapter';

export interface HostInfo extends CommonHostInfo {
  /** Canonical host name ('apple-notes', 'mac', …) — reported to
   *  on-host routing and every log line. */
  hostName: string;
  spawnProcess?(spec: unknown): unknown;
  blankInvoke?(spec: import('../../../src/adapter').BlankInvokeSpec):
    import('../../../src/adapter').ProcessHandle | null;
  /** Soft answer-length budget for the current target field — see
   *  HostAdapter.getAnswerCharBudget (mac: Spotlight → 37). */
  getAnswerCharBudget?(): number | null;
  /** True when the current target field IS the query box, so the answer
   *  replaces the typed question — see HostAdapter.getAnswerReplacesQuery
   *  (mac: Spotlight → true). */
  getAnswerReplacesQuery?(): boolean;
}

export interface BootResult {
  /**
   * Carries the daemon's synthetic standalone-`_` KeyEvents that arm
   * the resolver/BlankFill explicit-`_` gate (a polled host has no
   * keystrokes, and the gate's other freshness signal — underscore
   * count increasing between events — fails on coarse per-poll diffs).
   * Shape: `text` = buffer WITHOUT the marker char, `cursorOffset` =
   * the marker's index. Also serves the event-bridge contract.
   */
  dispatchKey(event: KeyEvent): boolean;
  notifyTextChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  /**
   * Wipe per-buffer runtime state. The daemon MUST call this whenever
   * the active note switches — spans tracked against the previous
   * note's text are meaningless against the new buffer. Idempotent.
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
  const moduleEvents = new EventEmitter<{ type: string; body?: Record<string, unknown> }>();

  let lastSeenText: string | null = null;
  const fireTextChange = (text: string, cursor: number, source: 'user' | 'runtime'): void => {
    textEvents.emit(
      { text, cursorOffset: cursor, previousText: lastSeenText ?? '', source },
      err => log('error', 'text handler threw', err),
    );
    lastSeenText = text;
  };

  const bindings: UniversalBindings = {
    hostName: host.hostName,
    hostVersion: host.hostVersion,
    cwd: host.cwd,
    getText: host.getText,
    getCursorOffset: host.getCursorOffset,
    setText: host.setText,
    setCursorOffset: host.setCursorOffset,
    forceRender: host.forceRender,
    registerKeyHandler: cb => keyEvents.subscribe(cb),
    registerTextChangeHandler: cb => textEvents.subscribe(cb),
    readFile: host.readFile,
    readDir: host.readDir,
    writeFile: host.writeFile,
    spawnProcess: host.spawnProcess as UniversalBindings['spawnProcess'],
    blankInvoke: host.blankInvoke,
    pushText: host.pushText,
    getAnswerCharBudget: host.getAnswerCharBudget,
    getAnswerReplacesQuery: host.getAnswerReplacesQuery,
    log,
    emitEvent: (type, body) => moduleEvents.emit(
      { type, body },
      err => log('error', 'event handler threw', err),
    ),
    registerEventHandler: cb => moduleEvents.subscribe(({ type, body }) => cb(type, body)),
  };

  const adapter = new UniversalV1Adapter(bindings);
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
  // Boot key bag with the standard precedence (host keys → process.env
  // → ~/.cues/.env from `opencues set-key`) — same call as shell/oc, so
  // a key the user set once reaches this host too.
  const apiKeys = buildBootApiKeys(host.llmApiKeys, host.llmApiKey, (m) => log('info', m));
  const shared = buildSharedRuntime(adapter, {
    log, configSearchPaths, settingsFile,
    getApiKeys: () => apiKeys,
    blanks: host.blanks,
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

  // "Usable LLM" = any env key OR the zero-key subscription-CLI rung
  // (pickAutoProvider's last rung: claude/codex binary present) —
  // mirrors shell/v1 so a keyless subscription setup still dispatches.
  const hasAnyKey = Object.values(apiKeys).some(Boolean) || pickAutoProvider(apiKeys) !== null;
  // Calendar-context: native read of the shared calendar.json snapshot
  // ($OPENCUES_HOME first, then ~/.cues), refreshed on a timer. Live
  // holder — the resolver reads it fresh each pass. Mirrors shell/v1:223.
  // Inert (undefined) with no feed configured, so hosts on this band
  // that never run `opencues calendar add` are byte-identical to before.
  const calendarContextHolder = buildCalendarContextIngest(log);
  const resolver = new Resolver(adapter, hlState, dynDefs, configLoader, {
    endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
    defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
    apiKeys,
    debounceMs: host.llmDebounceMs ?? 500,
    missingKeyFallbackMessage: hasAnyKey ? undefined : NATIVE_HOST_MISSING_KEY_MESSAGE,
    formatLLMErrorAsSubstitute: nativeHostFormatLLMError,
    keywordBoundSlotIndices: (text: string) => shared.blankFill.scan(text).map(s => s.index),
    calendarContext: calendarContextHolder,
  }, spanFillState, agentTaskState, shared.blankLoading, shared.markdownRender, selectorSatelliteState,
  buildBlankContextProvider(configLoader, host.blanks, log),
  buildBlankFetchProvider(configLoader, host.blanks, log));
  configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });

  log('info', `OpenCues runtime starting (universal v1, host: ${host.hostName})`, {
    host: host.hostName,
    hostVersion: host.hostVersion,
    capabilities: adapter.capabilities,
  });

  if (process.env.OPENCUES_BRIDGE === '1') {
    startEventBridge({
      adapter,
      dispatchKey: (e) => keyEvents.emitUntilConsumed(e, err => log('error', 'key handler threw', err)),
      notifyTextChange: (text, cursor, source) => fireTextChange(text, cursor, source),
      notifyCursorChange: () => { /* no cursor channel */ },
      state: { hlState, dynDefs, spanFillState, selectorSatelliteState, agentTaskState },
      resetBufferState: () => resetSharedBufferState({ ...shared, resolver }),
    });
  }

  return {
    dispatchKey(event) {
      return keyEvents.emitUntilConsumed(event, err => log('error', 'key handler threw', err));
    },
    notifyTextChange(text, cursorOffset, source) {
      fireTextChange(text, cursorOffset, source);
    },
    resetBufferState() {
      resetSharedBufferState({ ...shared, resolver });
    },
    dispose() {
      adapter.dispose();
      // Stop the calendar refresh timer — without this a disposed boot
      // leaves an interval alive (hangs test runners, leaks on daemon
      // re-boot). The holder is undefined when no feed is configured.
      calendarContextHolder?.stop();
      keyEvents.clear();
      textEvents.clear();
      moduleEvents.clear();
    },
  };
}
