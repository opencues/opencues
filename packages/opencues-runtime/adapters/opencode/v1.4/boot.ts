// Single entry point for the OpenCode v1.4 host bootstrap (Phase O.1).
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
import { Navigation } from '../../../src/modules/navigation';
import { DimRender } from '../../../src/modules/dim-render';
import { Cycling } from '../../../src/modules/cycling';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { Statusline } from '../../../src/modules/statusline';
import { Resolver } from '../../../src/modules/resolver';
import { TTS } from '../../../src/modules/tts';
import { BlankFill } from '../../../src/modules/blank-fill';
import { CursorStateExport } from '../../../src/modules/cursor-state-export';
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

/** Minimal host info the OpenCode-side patch supplies. */
export interface HostInfo {
  readonly hostVersion: string;
  readonly cwd: string;
  /** TextareaRenderable + SolidJS store accessors. */
  getText(): string;
  getCursorOffset(): number;
  setText(text: string): void;
  setCursorOffset(offset: number): void;
  forceRender(): void;
  /** Optional file I/O. Bun and node:fs both work. */
  readFile?(path: string): Promise<string | null>;
  readDir?(path: string): Promise<readonly { name: string; isDirectory: boolean }[] | null>;
  writeFile?(path: string, content: string): Promise<void>;
  spawnProcess?(spec: unknown): unknown;
  pushText?(text: string, cursor?: number): void;
  /** Optional logger — defaults to no-op. */
  log?(level: LogLevel, msg: string, data?: unknown): void;
  /** Optional: tips JSON path. */
  tipsPath?: string;
  /** Optional: statusline export path. */
  statusFilePath?: string;
  /**
   * Optional: cursor-state-export JSON path. Used by the opencues-auto
   * test harness to drive automated runs.
   */
  cursorStatePath?: string;
  /** Optional: TTS script path. */
  ttsScriptPath?: string;
  ttsRate?: string | number;
  /** Optional: LLM resolver — only constructs when llmApiKey set. */
  llmApiKey?: string;
  llmEndpoint?: string;
  llmDefaultModel?: string;
  llmDebounceMs?: number;
}

export interface BootResult {
  /** Call from useKeyboard's callback. Returns true if OpenCues consumed the event. */
  dispatchKey(event: KeyEvent): boolean;
  /** Call when the prompt input value changes (from onInput). */
  notifyTextChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
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
  // so opencues.md `debug-mode: on/off` hot-reloads without restart.
  // DEBUG_OPENCUES env is a bootstrap fallback for logs fired before
  // ConfigLoader.load resolves.
  let configLoaderRef: ConfigLoader | null = null;
  const isDebugEnabled = (): boolean => {
    if (configLoaderRef?.loaded) {
      return configLoaderRef.opencuesState.debugMode === 'on';
    }
    return !!process.env.DEBUG_OPENCUES;
  };
  const log = (level: LogLevel, msg: string, data?: unknown): void => {
    // error/warn/info always flow through; debug is gated.
    if (level === 'debug' && !isDebugEnabled()) return;
    if (host.log) {
      try { host.log(level, msg, data); } catch { /* swallow */ }
    }
  };

  const keyHandlers: Array<(e: KeyEvent) => boolean> = [];
  const textHandlers: Array<(e: TextChangeEvent) => void> = [];
  const renderHandlers: Array<(c: RenderContext) => RenderDirectives | null> = [];

  const removeFrom = <T>(arr: T[], item: T): void => {
    const i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
  };

  const bindings: OpenCodeBindings = {
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
    spawnProcess: host.spawnProcess as OpenCodeBindings['spawnProcess'],
    pushText: host.pushText,
    log,
  };

  const adapter = new OpenCodeV14Adapter(bindings);
  Runtime.create(adapter).catch(err => log('error', 'Runtime.create failed', err));

  // Phase O.5+ — ConfigLoader (cueMap + folder cues + opencues.md).
  // Loads asynchronously; modules tolerate empty config until ready.
  const tipsPath = host.tipsPath ?? `${process.env.HOME ?? '~'}/.claude/claude-code-tips.json`;
  const configLoader = new ConfigLoader(adapter, { tipsPath });
  configLoaderRef = configLoader; // wire isDebugEnabled to opencues.md
  configLoader.subscribe();
  configLoader.load().catch(err => log('error', 'ConfigLoader.load failed', err));

  // State classes first (declared in dependency order).
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const controlValues = new ControlValuesCache();
  const spanFillState = new SpanFillState();
  const dismissedBlanks = new DismissedBlanks();
  const selectorSatelliteState = new SelectorSatelliteState();

  // Phase O.3 + O.8 — Navigation, span/satellite-aware.
  const navigation = new Navigation(adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState);
  navigation.subscribe();

  // Phase O.4 + O.8 — DimRender, span/satellite-aware.
  const dimRender = new DimRender(adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState);
  dimRender.subscribe();

  // Phase O.5 + O.8 — Cycling. Full state set (span/dismissed/SS/control values).
  const cycling = new Cycling(adapter, hlState, dynDefs, configLoader, spanFillState, dismissedBlanks, selectorSatelliteState, controlValues);
  cycling.subscribe();

  // Phase O.8 — BlankFill. The `_` keystroke kicks off auto-populate
  // (sync stepValues) + async script fills (blankScript).
  const blankFill = new BlankFill(adapter, configLoader, spanFillState, dismissedBlanks, selectorSatelliteState, dynDefs);
  configLoader.load().then(() => blankFill.subscribe()).catch(() => { /* logged */ });

  // Phase O.7 — Statusline (file-based, doesn't touch OpenCode's own
  // status bar). Opt-in via host.statusFilePath.
  if (host.statusFilePath) {
    const statusline = new Statusline(adapter, hlState, dynDefs, {
      exportPath: host.statusFilePath,
    }, configLoader, spanFillState, selectorSatelliteState, controlValues);
    statusline.subscribe();
  }

  // CursorStateExport — opt-in. The opencues-auto test harness reads
  // the export to drive automated runs; no in-tree consumer.
  if (host.cursorStatePath && adapter.capabilities.includes('file-write')) {
    const cse = new CursorStateExport(adapter, { exportPath: host.cursorStatePath });
    cse.subscribe();
  }

  // TTS gets span + selector/satellite states for tip routing.
  // (Reconstructed below to include them — see Phase O.7.)

  // Phase O.7 — TTS. Opt-in via host.ttsScriptPath + spawn-process cap.
  if (host.ttsScriptPath && adapter.capabilities.includes('spawn-process')) {
    const tts = new TTS(adapter, hlState, dynDefs, configLoader, {
      scriptPath: host.ttsScriptPath,
      rate: host.ttsRate !== undefined ? String(host.ttsRate) : undefined,
    }, spanFillState, selectorSatelliteState);
    tts.subscribe();
  }

  // Phase O.7 — LLM Resolver. Opt-in via host.llmApiKey.
  if (host.llmApiKey) {
    const resolver = new Resolver(adapter, hlState, dynDefs, configLoader, {
      endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: host.llmApiKey,
      defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
      debounceMs: host.llmDebounceMs,
    });
    // Subscribe AFTER ConfigLoader.load — otherwise rebuildResolver sees
    // no cuesConfig/blanksConfig and bails. Mirrors CC v2.1 boot.
    configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });
  }

  log('info', 'OpenCues runtime starting (OpenCode v1.4)', {
    host: 'opencode',
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
      const event: TextChangeEvent = {
        text,
        cursorOffset,
        previousText: '',
        source,
      };
      for (const h of textHandlers) {
        try { h(event); } catch (err) { log('error', 'text handler threw', err); }
      }
    },
    collectRenderDirectives(text, cursor) {
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
