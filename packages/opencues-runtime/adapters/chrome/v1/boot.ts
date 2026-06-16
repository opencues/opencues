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
import { buildSharedRuntime, createLogFunction, buildAgentLLMResolver, resetSharedBufferState } from '../../../src/boot-common';
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
  /**
   * Per-current-target capability — does the currently focused
   * element support cycling (Ctrl+Alt+arrow + visual band)?
   * Returns true for contenteditables, false for normal `<input>`
   * / `<textarea>` (Universal-Integration profile).
   *
   * When omitted, defaults to true at the adapter level — every
   * pre-existing host always cycles. Chrome's bootstrap supplies
   * this binding so cycleable sources are pruned dynamically as
   * focus moves between CE and normal-input targets.
   */
  supportsCycling?(): boolean;
  /**
   * Per-current-target capability — does the currently focused
   * element support background agent rewrites? Chrome returns false
   * on Quill (LinkedIn share composer) because Quill's Delta-model
   * selection doesn't sync from browser-set selections, so the
   * runtime-translated cursor passed to `pushText` is ignored by
   * Quill's internal cursor state and every keystroke after a rewrite
   * tick lands at Quill's model position rather than where the user
   * sees the caret. See adapter.ts § supportsAgentRewrite for the
   * full rationale + non-affected inline flows.
   */
  supportsAgentRewrite?(): boolean;
  /**
   * Optional — gathers AmbientContext for the focused field. See the
   * runtime adapter's AmbientContext for the contract; chrome's
   * implementation lives in `gatherAmbientContext` in the bootstrap.
   * The runtime gates calls on `ambient-context-mode` before calling.
   */
  getAmbientContext?(): import('../../../src/adapter').AmbientContext | null;
}

export interface BootResult {
  dispatchKey(event: KeyEvent): boolean;
  notifyTextChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  /** Cursor-only move (no text change). Drives cursor-navigate. */
  notifyCursorChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  collectRenderDirectives(text: string, cursor: number): RenderDirectives[];
  /**
   * Read a current OPENCUES.md scalar value from the live opencuesState.
   * Returns undefined when the loader isn't ready yet or the scalar
   * isn't set. Hosts use this for host-scoped tunables (chrome reads
   * `dim-mix` here so cycling it via `opencues settings _` takes
   * effect without round-tripping through popup storage).
   */
  getSetting(scalar: string): string | undefined;
  /**
   * Re-read configs from disk (or chrome.storage, whichever the adapter
   * backs readFile/readDir with). Used by the chrome extension to
   * hot-reload on `opencues sync chrome` — polls `dist/configs/.version`
   * and calls this when the hash changes. Returns a promise that
   * resolves when the reload completes.
   */
  reloadConfig(): Promise<void>;
  /**
   * Mutate the live LLM api-key bag and force the Resolver +
   * AgentRewrite + user-blanks-registry to re-resolve their per-source
   * provider/key tuples on the NEXT dispatch — no page reload required.
   *
   * Why this exists: chrome.storage carries the host-pushed env keys.
   * Without this method, a user who installs chrome-host AFTER opening
   * a tab (or rotates a key in their .env mid-session) would have a
   * resolver pinned to the keys that were present at boot, and every
   * LLM dispatch would silently no-op until they reloaded the tab.
   *
   * Implementation: the apiKeys reference passed at boot is mutable.
   * This method wipes it in place and re-fills from `newKeys`, then
   * calls `Resolver.rebuildResolver()` so build-sources picks up the
   * new bag. Sources that cached an old key are rebuilt; in-flight LLM
   * calls already dispatched complete with their old credentials
   * (acceptable — they're transient).
   *
   * No-op when the boot didn't construct a resolver (i.e. boot had no
   * keys at all). For that case page reload is still required —
   * documented in `integrations/chrome/CLAUDE.md`.
   */
  updateApiKeys(newKeys: Readonly<Record<string, string | undefined>>): void;
  /**
   * Mutate the live LLM provider / model / endpoint overrides and
   * rebuild the Resolver so the next dispatch picks them up — no page
   * reload required. Mirrors `updateApiKeys`'s in-place mutation
   * model. Used by the chrome popup's Save handler so flipping
   * provider / model / API URL takes effect without a hard-refresh.
   *
   * Fields are independent — pass only the ones that changed. Empty
   * string clears that override (so OPENCUES.md scalars take over);
   * undefined leaves the existing override unchanged.
   *
   * AgentRewrite (when constructed) is not mutated here — its
   * `resolveLLM` thunk already re-reads from `configLoader.opencuesState`
   * on every tick, so OPENCUES.md edits hot-reload there separately.
   * In `deferToChromeHost: false` mode the agentic feature continues
   * to follow OPENCUES.md rather than the popup's three fields; if
   * that gap matters in practice, plumb the overrides through
   * AgentRewriteOptions in a follow-up.
   */
  updateLlmConfig(patch: {
    provider?: string;
    model?: string;
    endpoint?: string;
  }): void;
  /**
   * Subscribe to module-emitted lifecycle events (markdown.styled,
   * blank.substituted, agent-rewrite.round-completed, etc.). The
   * content-script bootstrap uses this for `markdown.styled` payloads
   * — the per-style range info lets chrome apply native bold / italic
   * markup over the live DOM after the runtime has written the
   * stripped text.
   */
  onModuleEvent(handler: (type: string, body?: Record<string, unknown>) => void): () => void;
  /**
   * Reset per-buffer runtime state — DynDefs, HighlightState, SpanFill,
   * SelectorSatellite. Callers are responsible for emitting this signal
   * whenever the buffer was mutated outside the runtime's setText path,
   * which invalidates every span / word-index the runtime currently
   * tracks. Concretely, chrome's content script calls this for:
   *
   *   - Focused-field switch (focusin / focusout). Chrome's normal-input
   *     mode attaches to many independent `<input>` elements in one page;
   *     each is its own buffer with its own word-position semantics.
   *
   *   - Buffer-replacing input events (beforeinput.inputType ∈
   *     {historyUndo, historyRedo, insertFromPaste, insertCompositionText}).
   *     Browser-managed undo restores text without restoring the runtime's
   *     spans; paste / IME commit write text the runtime didn't author.
   *
   * Without this, leftover state corrupts the next buffer's behaviour in
   * non-obvious ways — fluid-blank substitutions blocked by stale
   * blank-bound DynDefs from a prior field; phantom highlights anchored
   * to character offsets that no longer exist after an undo; selector-
   * satellite cycle that resumes against the wrong buffer.
   *
   * Implementation lives in `resetSharedBufferState` (boot-common.ts) so
   * every band wipes the same state objects.
   *
   * Idempotent — safe to call repeatedly (focus-change spam, input-event
   * bursts during paste or IME composition).
   */
  resetBufferState(): void;
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
  // Module-event bus (markdown.styled, blank.substituted, etc.) —
  // bindings.emitEvent posts onto it, BootResult.onModuleEvent subscribes.
  // The shape is (type, body) so the chrome content-script bootstrap can
  // pattern-match on the event name.
  type ModuleEventPayload = { type: string; body?: Record<string, unknown> };
  const moduleEvents = new EventEmitter<ModuleEventPayload>();

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
    supportsCycling: host.supportsCycling,
    supportsAgentRewrite: host.supportsAgentRewrite,
    getAmbientContext: host.getAmbientContext,
    log,
    emitEvent: (type, body) => {
      moduleEvents.emit({ type, body }, err => log('error', 'module-event handler threw', err));
    },
    registerEventHandler: (cb) => moduleEvents.subscribe(({ type, body }) => cb(type, body)),
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
  //
  // `apiKeys` is the LIVE mutable bag — `updateApiKeys` below mutates
  // it in place (rather than reassigning) so the resolver's
  // `options.apiKeys` reference stays valid across key swaps. This is
  // what makes mid-session host-key pushes actually reach the
  // resolver on the next dispatch instead of requiring a tab reload.
  const apiKeys: Record<string, string | undefined> = { ...(host.llmApiKeys ?? {}) };
  if (host.llmApiKey && !apiKeys.GROQ_API_KEY) apiKeys.GROQ_API_KEY = host.llmApiKey;
  const hasAnyKey = Object.values(apiKeys).some(Boolean);
  let liveResolver: Resolver | null = null;
  // Construct the Resolver even when no API keys are present. The
  // MissingKeyFallbackSource (added by buildSourcesFromConfig when no
  // LLM source could wire up) substitutes `_` with a host-specific
  // in-buffer hint — "open the extension popup". Without the resolver
  // being constructed at all, the fallback would never fire and the
  // user types `_` to silent nothing.
  // Resolver options held as a named local so `updateLlmConfig` below
  // can mutate provider/endpoint/model overrides in place — the
  // Resolver holds this same object reference via `this.options` and
  // re-reads the override fields on every `rebuildResolver()`. Same
  // pattern as `apiKeys` (the live bag passed by reference).
  const resolverOpts: {
    endpoint: string;
    apiKey: string;
    defaultModel: string;
    providerOverride?: string;
    endpointOverride?: string;
    modelOverride?: string;
    apiKeys: Record<string, string | undefined>;
    debounceMs: number;
    httpAdapter: unknown;
    missingKeyFallbackMessage?: string;
    formatLLMErrorAsSubstitute?: (reason: 'invalid-api-key' | 'network' | 'rate-limit' | 'endpoint-not-found' | 'model-not-found' | 'insufficient-credits' | 'bad-request', err?: Error) => string;
  } = {
    endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
    defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
    // Popup-supplied overrides win over OPENCUES.md scalars (chrome
    // user's local intent beats the synced ~/.cues/ snapshot). Empty
    // string / undefined falls through to the settings scalar.
    providerOverride: (host.llmProvider && host.llmProvider.length > 0) ? host.llmProvider : undefined,
    endpointOverride: (host.llmEndpoint && host.llmEndpoint.length > 0) ? host.llmEndpoint : undefined,
    modelOverride: (host.llmDefaultModel && host.llmDefaultModel.length > 0) ? host.llmDefaultModel : undefined,
    apiKeys,
    debounceMs: host.llmDebounceMs ?? 500,
    httpAdapter: host.httpAdapter,
  };
  if (true) {
    // Pass resolverOpts by reference (NOT spread) so updateLlmConfig's
    // in-place mutations propagate to this.options on every rebuild.
    // Final two fields are inline because they're host-specific and
    // never change after boot.
    const resolver = new Resolver(adapter, hlState, dynDefs, configLoader, Object.assign(resolverOpts, {
      // Chrome-specific user-facing message — points the user at the
      // extension popup, where the API-key inputs live.
      missingKeyFallbackMessage: hasAnyKey ? undefined : '[OpenCues: no API key — open the extension popup]',
      // Chrome-specific formatter for runtime LLM failures. Every
      // user-actionable reason maps to a one-line in-buffer hint that
      // tells the user where to look in chrome. LLM-internal issues
      // (malformed JSON, no-span) stay silent regardless.
      formatLLMErrorAsSubstitute: (reason: 'invalid-api-key' | 'network' | 'rate-limit' | 'endpoint-not-found' | 'model-not-found' | 'insufficient-credits' | 'bad-request'): string => {
        // Provider's own JSON error deliberately NOT inlined — it can
        // be ugly, leak details, or vary wildly across providers. The
        // reason class + actionable hint is enough.
        switch (reason) {
          case 'invalid-api-key':    return '[OpenCues: API key rejected (401/403) — open the extension popup and re-enter it]';
          case 'endpoint-not-found': return '[OpenCues: provider endpoint returned 404 — check the API URL in the extension popup]';
          case 'model-not-found':    return '[OpenCues: model not available for the chosen provider — pick a Model that matches the selected Provider in the extension popup]';
          case 'insufficient-credits': return '[OpenCues: provider rejected the request — out of credits / quota. Top up the account, or switch Provider in the extension popup to one whose key has credit.]';
          case 'rate-limit':         return '[OpenCues: provider rate-limit hit (429) — wait a moment or switch provider in the popup]';
          case 'network':            return '[OpenCues: network error — provider unreachable. Check connectivity, then retry.]';
          case 'bad-request':        return '[OpenCues: provider returned 400 (bad request) — check the Model name matches the selected Provider in the popup]';
        }
      },
      keywordBoundSlotIndices: (text: string) => shared.blankFill.scan(text).map(s => s.index),
      runIntegration: shared.integrationRunner ?? undefined,
      runTokenIntegration: shared.tokenIntegrationRunner ?? undefined,
      runRewritePolish: shared.rewritePolishRunner ?? undefined,
    }), spanFillState, agentTaskState, shared.blankLoading, shared.markdownRender, selectorSatelliteState);
    configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });
    liveResolver = resolver;

    if (hasAnyKey) {
      const httpAdapter = host.httpAdapter as { post(url: string, body: string, headers: Record<string, string>): Promise<string> };
      const agentRewrite = new AgentRewrite(adapter, dynDefs, agentTaskState, {
        endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
        apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
        defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
        httpAdapter,
        resolveLLM: () => buildAgentLLMResolver(configLoader, apiKeys),
        // Sliding-window mode (lazy thunk so OPENCUES.md edits take effect
        // without a restart). 0 = full-buffer; useful for long docs in
        // textareas where token cost dominates.
        windowWords: () => parseInt(configLoader.opencuesState.settings.get('agent-window-words') ?? '0', 10) || 0,
        cadenceMs: () => parseInt(configLoader.opencuesState.settings.get('agent-debounce-ms') ?? '', 10),
        auditorPrompts: () => configLoader.composeAuditorPrompts(),
        maxConcurrentAuditors: () => parseInt(configLoader.opencuesState.settings.get('max-concurrent-auditors') ?? '', 10) || 0,
      });
      agentRewrite.start();
    }
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
    getSetting(scalar) {
      // Read the live opencuesState scalar. Returns undefined when
      // the loader hasn't run yet (chrome's first focus before
      // configLoader.load() resolves) so callers can fall back to a
      // host-side default cleanly.
      if (!shared.configLoader.loaded) return undefined;
      return shared.configLoader.opencuesState.settings.get(scalar);
    },
    updateApiKeys(newKeys) {
      // Mutate in place — the resolver holds the same reference via
      // its options.apiKeys, and rebuilds sources from it on demand.
      // Re-assigning the local `apiKeys` variable wouldn't propagate.
      for (const k of Object.keys(apiKeys)) delete apiKeys[k];
      for (const [k, v] of Object.entries(newKeys)) {
        if (typeof v === 'string' && v.length > 0) apiKeys[k] = v;
      }
      // Force resolver rebuild so sources pick up new credentials on
      // the next dispatch. No-op when no resolver exists (boot had no
      // keys; user must reload tab to construct one fresh — building
      // a resolver from nothing mid-session would require tearing
      // down + recreating AgentRewrite too, which is out of scope).
      if (liveResolver) {
        liveResolver.rebuildResolver();
        log('info', '[opencues] updateApiKeys: resolver rebuilt with new key set');
      } else {
        log('warn',
          '[opencues] updateApiKeys: no resolver to update (boot had no keys). ' +
          'Reload the tab to construct one from the new keys.');
      }
    },
    updateLlmConfig(patch) {
      // Mutate the same resolverOpts reference the Resolver holds.
      // Empty string CLEARS the override (settings scalar takes over);
      // undefined leaves the field unchanged.
      if (patch.provider !== undefined) {
        resolverOpts.providerOverride = patch.provider.length > 0 ? patch.provider : undefined;
      }
      if (patch.endpoint !== undefined) {
        resolverOpts.endpointOverride = patch.endpoint.length > 0 ? patch.endpoint : undefined;
        // Also update the legacy single-key endpoint fallback so
        // sources that don't read endpointOverride still see the
        // new value.
        if (patch.endpoint.length > 0) resolverOpts.endpoint = patch.endpoint;
      }
      if (patch.model !== undefined) {
        resolverOpts.modelOverride = patch.model.length > 0 ? patch.model : undefined;
        if (patch.model.length > 0) resolverOpts.defaultModel = patch.model;
      }
      if (liveResolver) {
        liveResolver.rebuildResolver();
        log('info', '[opencues] updateLlmConfig: resolver rebuilt', {
          provider: resolverOpts.providerOverride ?? '(settings)',
          model: resolverOpts.modelOverride ?? '(settings)',
          endpoint: resolverOpts.endpointOverride ?? '(settings)',
        });
      } else {
        log('warn', '[opencues] updateLlmConfig: no resolver to update — reload tab');
      }
    },
    onModuleEvent(handler) {
      return moduleEvents.subscribe(({ type, body }) => handler(type, body));
    },
    resetBufferState() {
      // Wipe set + rationale lives in boot-common.ts's
      // `resetSharedBufferState` so every band stays in lockstep.
      resetSharedBufferState(shared);
      // Reset lastSeen so the next collectRenderDirectives doesn't
      // diff against a stale snapshot from the prior buffer. This
      // piece is local to the chrome boot closure (each band tracks
      // its own diff baseline) so it doesn't belong in the shared
      // helper.
      lastSeenText = '';
      lastSeenCursor = 0;
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
