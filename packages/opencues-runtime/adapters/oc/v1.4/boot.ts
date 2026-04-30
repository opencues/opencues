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
import { Statusline } from '../../../src/modules/statusline';
import { Resolver } from '../../../src/modules/resolver';
import { TTS } from '../../../src/modules/tts';
import { CursorStateExport } from '../../../src/modules/cursor-state-export';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { buildSharedRuntime, createLogFunction } from '../../../src/boot-common';
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
   * Optional host-native control dispatch. Same shape as chrome's
   * controlInvoke — BlankFill + Cycling try this BEFORE spawnProcess so
   * shared TS controls (HackerNewsControl, etc.) win over the legacy
   * shell scripts in controls/. Returns null when the controlName
   * isn't in the host's registry; runtime then falls through to
   * spawnProcess (still works for OS controls like volume/brightness).
   */
  blankInvoke?(spec: import('../../../src/adapter').BlankInvokeSpec):
    import('../../../src/adapter').ProcessHandle | null;
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
  // Debug gating reads opencuesState.debugMode lazily so opencues.md
  // `debug-mode: on/off` hot-reloads without restart. DEBUG_OPENCUES env
  // is a bootstrap fallback for logs fired before ConfigLoader.load resolves.
  const log = createLogFunction({
    sink: (level, msg, data) => host.log?.(level, msg, data),
    isDebugEnabled: () => configLoaderRef?.loaded === true
      ? configLoaderRef.opencuesState.debugMode === 'on'
      : !!process.env.DEBUG_OPENCUES,
  });

  const keyHandlers: Array<(e: KeyEvent) => boolean> = [];
  const textHandlers: Array<(e: TextChangeEvent) => void> = [];
  const renderHandlers: Array<(c: RenderContext) => RenderDirectives | null> = [];

  // Text observation tracking. Used to populate `previousText` on
  // notifyTextChange events. We do NOT synthesise text-change events
  // when collectRenderDirectives sees drift — the bootstrap can't
  // reliably tell user-typed drift apart from a runtime-initiated
  // setText/pushText that hasn't yet flowed through SolidJS's
  // onContentChange (Cycling.cycleControl → setText → forceRender all
  // run synchronously, before onContentChange fires). Synthesising
  // 'user' there clears the highlight and the next Resolver pass
  // pollutes the now-unattributed word with LLM alts.
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
    blankInvoke: host.blankInvoke,
    pushText: host.pushText,
    log,
  };

  const adapter = new OpenCodeV14Adapter(bindings);
  Runtime.create(adapter).catch(err => log('error', 'Runtime.create failed', err));

  // Universal state + ConfigLoader + Navigation/DimRender/Cycling/BlankFill
  // all live in boot-common.ts so the chrome and opencode bands can't
  // drift on subscription order or constructor args. Tips come from
  // cues.md's `## Tips` block — no separate JSON file.
  const HOME = process.env.HOME ?? '~';
  const configSearchPaths = [
    ...(process.env.OPENCUES_HOME ? [process.env.OPENCUES_HOME] : []),
    `${host.cwd}/.opencues`,
    `${HOME}/.opencues`,
  ];
  const shared = buildSharedRuntime(adapter, { log, configSearchPaths });
  configLoaderRef = shared.configLoader; // wires isDebugEnabled to opencues.md

  const {
    configLoader, hlState, dynDefs,
    spanFillState, selectorSatelliteState, controlValues,
  } = shared;

  // Phase O.7 — Statusline (file-based) + O.12 — in-process snapshot
  // hook so the OpenCode footer can render the tip natively. Both sinks
  // are opt-in; either or both can be wired.
  if (host.statusFilePath || host.statusSnapshotHook) {
    const statusline = new Statusline(adapter, hlState, dynDefs, {
      exportPath: host.statusFilePath ?? '',
      onSnapshot: host.statusSnapshotHook
        ? (payload) => host.statusSnapshotHook!(payload)
        : undefined,
    }, configLoader, spanFillState, selectorSatelliteState, controlValues);
    statusline.subscribe();
  }

  // CursorStateExport — opt-in. The opencues-auto test harness reads
  // the export to drive automated runs; no in-tree consumer.
  if (host.cursorStatePath && adapter.capabilities.includes('file-write')) {
    const cse = new CursorStateExport(adapter, { exportPath: host.cursorStatePath });
    cse.subscribe();
  }

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
      debounceMs: host.llmDebounceMs ?? 500,
    }, spanFillState);
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
      fireTextChange(text, cursorOffset, source);
    },
    collectRenderDirectives(text, cursor) {
      // Observe-only — never synthesise textChange here (see comment by
      // lastSeenText declaration). Cycling.cycleControl + forceRender
      // race onContentChange and would otherwise look like user drift.
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
