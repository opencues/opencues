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
import { HighlightState } from '../../../src/state/highlight-state';
import { DynDefs } from '../../../src/state/dyn-defs';
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
  const log = (level: LogLevel, msg: string, data?: unknown): void => {
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
  configLoader.subscribe();
  configLoader.load().catch(err => log('error', 'ConfigLoader.load failed', err));

  // Phase O.3 — Navigation. Same module as CC; host-agnostic.
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const navigation = new Navigation(adapter, hlState, dynDefs, configLoader);
  navigation.subscribe();

  // Phase O.4 — DimRender. Subscribes to onRender; the patch fires
  // it via collectRenderDirectives + extmark application.
  const dimRender = new DimRender(adapter, hlState, dynDefs, configLoader);
  dimRender.subscribe();

  // Phase O.5 — Cycling. Ctrl+Alt+Up/Down rotates static alts +
  // step patterns + script controls. Span/satellite/dismissed states
  // wait for O.7.
  const cycling = new Cycling(adapter, hlState, dynDefs, configLoader);
  cycling.subscribe();

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
