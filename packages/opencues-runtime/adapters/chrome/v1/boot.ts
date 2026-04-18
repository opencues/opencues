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
import { Navigation } from '../../../src/modules/navigation';
import { DimRender } from '../../../src/modules/dim-render';
import { Cycling } from '../../../src/modules/cycling';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { Statusline } from '../../../src/modules/statusline';
import { Resolver } from '../../../src/modules/resolver';
import { BlankFill } from '../../../src/modules/blank-fill';
import { HighlightState } from '../../../src/state/highlight-state';
import { DynDefs } from '../../../src/state/dyn-defs';
import { ControlValuesCache } from '../../../src/state/control-values';
import { SpanFillState } from '../../../src/state/span-fill';
import { DismissedBlanks } from '../../../src/state/dismissed-blanks';
import { SelectorSatelliteState } from '../../../src/state/selector-satellite';
import type {
  KeyEvent,
  LogLevel,
  RenderContext,
  RenderDirectives,
  TextChangeEvent,
  Unsubscribe,
} from '../../../src/adapter';

/** Minimal host info the Chrome content script supplies. */
export interface HostInfo {
  readonly hostVersion: string;
  readonly cwd: string;
  getText(): string;
  getCursorOffset(): number;
  setText(text: string): void;
  setCursorOffset(offset: number): void;
  forceRender(): void;
  readFile?(path: string): Promise<string | null>;
  readDir?(path: string): Promise<readonly { name: string; isDirectory: boolean }[] | null>;
  writeFile?(path: string, content: string): Promise<void>;
  pushText?(text: string, cursor?: number): void;
  /** Optional logger — defaults to console.log with [opencues] prefix. */
  log?(level: LogLevel, msg: string, data?: unknown): void;
  /** Optional: tips JSON virtual path (chrome.storage key). */
  tipsPath?: string;
  /**
   * Optional: in-process callback fired with the statusline payload on
   * every state change. The content script renders the tip into its
   * floating status-bar div from this.
   */
  statusSnapshotHook?(payload: unknown): void;
  /** Optional: LLM resolver — only constructs when llmApiKey set. */
  llmApiKey?: string;
  llmEndpoint?: string;
  llmDefaultModel?: string;
  llmDebounceMs?: number;
  /**
   * Optional: custom httpAdapter to inject into the Resolver. Chrome
   * extensions can't use NodeHttpAdapter (no node:https); content
   * scripts supply their own fetch()-based adapter here.
   */
  httpAdapter?: unknown;
}

export interface BootResult {
  dispatchKey(event: KeyEvent): boolean;
  notifyTextChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  collectRenderDirectives(text: string, cursor: number): RenderDirectives[];
  dispose(): void;
}

export function boot(host: HostInfo): BootResult {
  // Debug gating mirrors OpenCode's pattern — reads opencuesState.debugMode
  // lazily so the popup can flip it without restart.
  let configLoaderRef: ConfigLoader | null = null;
  const isDebugEnabled = (): boolean => {
    if (configLoaderRef?.loaded) {
      return configLoaderRef.opencuesState.debugMode === 'on';
    }
    // No DEBUG_OPENCUES env in the browser — default off pre-load.
    return false;
  };
  const log = (level: LogLevel, msg: string, data?: unknown): void => {
    if (level === 'debug' && !isDebugEnabled()) return;
    if (host.log) {
      try { host.log(level, msg, data); } catch { /* swallow */ }
    }
  };

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
    log,
  };

  const adapter = new ChromeV1Adapter(bindings);
  Runtime.create(adapter).catch(err => log('error', 'Runtime.create failed', err));

  // ConfigLoader — chrome.storage-backed. Same tipsPath pattern; the
  // content script translates "~/.claude/claude-code-tips.json" (or
  // whatever) into a storage key lookup.
  const tipsPath = host.tipsPath ?? 'chrome:tips.json';
  const configLoader = new ConfigLoader(adapter, { tipsPath });
  configLoaderRef = configLoader;
  configLoader.subscribe();
  configLoader.load().catch(err => log('error', 'ConfigLoader.load failed', err));

  // State classes (declared in dependency order, same as OpenCode).
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const controlValues = new ControlValuesCache();
  const spanFillState = new SpanFillState();
  const dismissedBlanks = new DismissedBlanks();
  const selectorSatelliteState = new SelectorSatelliteState();

  const navigation = new Navigation(adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState);
  navigation.subscribe();

  const dimRender = new DimRender(adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState);
  dimRender.subscribe();

  const cycling = new Cycling(adapter, hlState, dynDefs, configLoader, spanFillState, dismissedBlanks, selectorSatelliteState, controlValues);
  cycling.subscribe();

  const blankFill = new BlankFill(adapter, configLoader, spanFillState, dismissedBlanks, selectorSatelliteState, dynDefs);
  configLoader.load().then(() => blankFill.subscribe()).catch(() => { /* logged */ });

  // Statusline — Chrome has no filesystem, so exportPath is '' (empty).
  // The snapshot hook delivers the payload to the content script, which
  // renders it into a floating div.
  if (host.statusSnapshotHook) {
    const statusline = new Statusline(adapter, hlState, dynDefs, {
      exportPath: '',
      onSnapshot: (payload) => host.statusSnapshotHook!(payload),
    }, configLoader, spanFillState, selectorSatelliteState, controlValues);
    statusline.subscribe();
  }

  // CursorStateExport — no real consumer in-browser yet, so skip
  // unless a future phase wires it to chrome.storage for automation.

  // TTS — Chrome uses Web Speech via a separate adapter rather than
  // the script-spawning TTS module. Phase CE.6 will route tips through
  // the module with a hostFn-based speak instead of spawnProcess.

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
    });
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
      // events. See adapters/opencode/REPAIR.md "Drift guard" for why
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
    dispose() {
      adapter.dispose();
      keyHandlers.length = 0;
      textHandlers.length = 0;
      renderHandlers.length = 0;
    },
  };
}
