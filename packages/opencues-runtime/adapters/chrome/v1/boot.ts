// Chrome extension v1 boot entry — Phase CE.0 scaffold.
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
//   - No spawnProcess (see adapter.ts). TTS uses Web Speech; controls
//     that need external data (stocks/weather/HN) go through fetch().
//   - No TTS script path either — Chrome bypasses the TTS module
//     entirely for now (Phase CE.6 will wire Web Speech through it).
//   - No live file watch — ConfigLoader.load() re-reads from
//     chrome.storage whenever the popup writes.

import { Runtime } from '../../../src/runtime';
import { ChromeV1Adapter, type ChromeBindings } from './adapter';
import { Statusline } from '../../../src/modules/statusline';
import { Resolver } from '../../../src/modules/resolver';
import { TTS } from '../../../src/modules/tts';
import { CursorStateExport } from '../../../src/modules/cursor-state-export';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { buildSharedRuntime, createLogFunction } from '../../../src/boot-common';
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
   * Host-native control dispatch. BlankFill + Cycling try this before
   * spawnProcess. Chrome implementations typically dispatch to
   * Web Audio (volume) / fetch() (stocks/weather/HN) / two-step LLM
   * (prompt-improver). Returns ProcessHandle or null when the
   * controlName isn't recognised (runtime falls through to spawnProcess,
   * which the chrome adapter resolves with exitCode 127).
   */
  blankInvoke?(spec: BlankInvokeSpec): ProcessHandle | null;
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

  const keyHandlers: Array<(e: KeyEvent) => boolean> = [];
  const textHandlers: Array<(e: TextChangeEvent) => void> = [];
  const renderHandlers: Array<(c: RenderContext) => RenderDirectives | null> = [];

  let lastSeenText: string | null = null;
  let lastSeenCursor = 0;
  const fireTextChange = (text: string, cursor: number, source: 'user' | 'runtime'): void => {
    const event: TextChangeEvent = {
      text,
      cursorOffset: cursor,
      previousText: lastSeenText ?? '',
      source,
    };
    for (const h of textHandlers) {
      try { h(event); } catch (err) { log('error', 'text handler threw', err); }
    }
    lastSeenText = text;
    lastSeenCursor = cursor;
  };

  const removeFrom = <T>(arr: T[], item: T): void => {
    const i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
  };

  const bindings: ChromeBindings = {
    hostVersion: host.hostVersion,
    cwd: host.cwd,
    getText: host.getText,
    getCursorOffset: host.getCursorOffset,
    setText: host.setText,
    setCursorOffset: host.setCursorOffset,
    forceRender: host.forceRender,
    registerKeyHandler: (cb) => {
      keyHandlers.push(cb);
      return () => removeFrom(keyHandlers, cb);
    },
    registerTextChangeHandler: (cb) => {
      textHandlers.push(cb);
      return () => removeFrom(textHandlers, cb);
    },
    registerRenderHandler: (cb) => {
      renderHandlers.push(cb);
      return () => removeFrom(renderHandlers, cb);
    },
    readFile: host.readFile,
    readDir: host.readDir,
    writeFile: host.writeFile,
    pushText: host.pushText,
    blankInvoke: host.blankInvoke,
    log,
  };

  const adapter = new ChromeV1Adapter(bindings);
  Runtime.create(adapter).catch(err => log('error', 'Runtime.create failed', err));

  // Universal state + ConfigLoader + Navigation/DimRender/Cycling/BlankFill
  // all live in boot-common.ts so the chrome and opencode bands can't
  // drift on subscription order or constructor args.
  const shared = buildSharedRuntime(adapter, { log });
  configLoaderRef = shared.configLoader;

  const {
    configLoader, hlState, dynDefs,
    spanFillState, selectorSatelliteState,
  } = shared;

  // Statusline — Chrome has no filesystem, so exportPath is '' (empty).
  // The snapshot hook delivers the payload to the content script, which
  // renders it into a floating div.
  if (host.statusSnapshotHook) {
    const statusline = new Statusline(adapter, hlState, dynDefs, {
      exportPath: '',
      onSnapshot: (payload) => host.statusSnapshotHook!(payload),
    }, configLoader, spanFillState, selectorSatelliteState);
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
  if (host.llmApiKey) {
    const resolver = new Resolver(adapter, hlState, dynDefs, configLoader, {
      endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: host.llmApiKey,
      defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
      debounceMs: host.llmDebounceMs ?? 500,
      httpAdapter: host.httpAdapter,
    }, spanFillState);
    configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });
  }

  log('info', 'OpenCues runtime starting (Chrome v1)', {
    host: 'chrome',
    hostVersion: host.hostVersion,
    capabilities: adapter.capabilities,
  });

  return {
    dispatchKey(event) {
      for (const h of keyHandlers) {
        try { if (h(event)) return true; } catch (err) {
          log('error', 'key handler threw', err);
        }
      }
      return false;
    },
    notifyTextChange(text, cursorOffset, source) {
      fireTextChange(text, cursorOffset, source);
    },
    collectRenderDirectives(text, cursor) {
      // Observe-only: update lastSeenText/Cursor without synthesising
      // events. See adapters/oc/REPAIR.md "Drift guard" for why
      // synthetic fires break runtime-initiated text writes.
      lastSeenText = text;
      lastSeenCursor = cursor;
      const ctx: RenderContext = { text, cursor, externalHighlights: [] };
      const out: RenderDirectives[] = [];
      for (const h of renderHandlers) {
        try {
          const d = h(ctx);
          if (d) out.push(d);
        } catch (err) {
          log('error', 'render handler threw', err);
        }
      }
      return out;
    },
    async reloadConfig() {
      // ConfigLoader.load() re-reads every search path, re-parses, and
      // fires onTextChange-style re-renders downstream. Used by the
      // chrome extension's .version polling loop.
      await shared.configLoader.load();
    },
    dispose() {
      adapter.dispose();
      keyHandlers.length = 0;
      textHandlers.length = 0;
      renderHandlers.length = 0;
    },
  };
}
