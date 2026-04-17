// Single entry point for the Claude Code v2.1 host bootstrap.
//
// The tweakcc patch's only job is to:
//   1. require() this module from cli.js's createRequire context.
//   2. Call boot(hostInfo) once on first key dispatch.
//   3. Use the returned BootResult helpers from the KeyDispatcher and
//      from the wrapped renderedValue expression.
//
// Everything else — adapter construction, state, module subscription,
// Runtime lifecycle, error capture — lives here. That keeps the patch
// surface tiny and decouples the runtime's internal layout from the patch.

import { Runtime } from '../../../src/runtime';
import { ClaudeCodeV21Adapter, type HostBindings, normaliseKeyEvent, toggleZeroWidth } from './adapter';
import { Navigation } from '../../../src/modules/navigation';
import { DimRender } from '../../../src/modules/dim-render';
import { HighlightState } from '../../../src/state/highlight-state';
import { DynDefs } from '../../../src/state/dyn-defs';
import { applyDirectives } from '../../../src/render-directives';
import type {
  KeyEvent,
  LogLevel,
  RenderContext,
  RenderDirectives,
  TextChangeEvent,
  Unsubscribe,
} from '../../../src/adapter';

/** Minimal host info the patch supplies. boot() builds HostBindings from it. */
export interface HostInfo {
  readonly hostVersion: string;
  readonly cwd: string;
  /** Snapshot of the current input text. */
  getText(): string;
  /** Snapshot of the current cursor offset. */
  getCursorOffset(): number;
  /** Optional logger. Defaults to a no-op unless DEBUG_OPENCUES is set. */
  log?(level: LogLevel, msg: string, data?: unknown): void;
}

/** Raw key event from the host (Ink-style flag names are tolerated). */
export interface RawKeyEvent {
  key?: string;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  option?: boolean;
  shift?: boolean;
  super?: boolean;
}

export interface BootResult {
  readonly adapter: ClaudeCodeV21Adapter;
  readonly hlState: HighlightState;
  readonly dynDefs: DynDefs;
  /** Whether boot completed without error. */
  readonly failed: boolean;

  /**
   * Run a raw host key event through every registered onKey handler.
   * Returns true if any handler consumed the event.
   */
  dispatchKey(rawEvent: RawKeyEvent, text: string, cursorOffset: number): boolean;

  /**
   * Read-and-clear the pendingRender flag. The patch should call this after
   * a consumed dispatchKey and, if true, return a freshly-built InputZone
   * with `toggleRenderText(text)` to force a host re-render.
   */
  consumePendingRender(): boolean;

  /** Pure ZWS/ZWNJ toggle — host calls this when rebuilding the InputZone. */
  toggleRenderText(text: string): string;

  /**
   * Wrap a host-rendered string through every onRender handler, applying
   * each handler's RenderDirectives via applyDirectives. Pass-through if
   * no handlers are subscribed or the input isn't a string.
   */
  applyRender(rendered: unknown, text: string, cursorOffset: number): unknown;
}

/**
 * Construct the runtime, subscribe modules, return host-facing helpers.
 *
 * Synchronous: subscriptions land before this function returns, so the
 * very first key dispatch after boot() is fully wired. Runtime.create is
 * called fire-and-forget for capability validation + startup logging only.
 */
export function boot(host: HostInfo): BootResult {
  const log = (level: LogLevel, msg: string, data?: unknown): void => {
    if (host.log) {
      try { host.log(level, msg, data); } catch { /* swallow */ }
    } else if (process.env.DEBUG_OPENCUES) {
      // eslint-disable-next-line no-console
      console.error(`[opencues][${level}] ${msg}`, data ?? '');
    }
  };

  // Handler arrays + state owned by this boot. Adapter's HostBindings hooks
  // into them so adapter.onKey/onRender/onTextChange feed these arrays.
  const keyHandlers: Array<(e: KeyEvent) => boolean> = [];
  const renderHandlers: Array<(c: RenderContext) => RenderDirectives | null> = [];
  const textHandlers: Array<(e: TextChangeEvent) => void> = [];
  let pendingRender = false;

  const removeFrom = <T>(arr: T[], item: T): void => {
    const i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
  };

  const bindings: HostBindings = {
    hostVersion: host.hostVersion,
    cwd: host.cwd,
    getText: () => { try { return host.getText(); } catch { return ''; } },
    getCursorOffset: () => { try { return host.getCursorOffset(); } catch { return 0; } },
    setText: () => { /* no-op for navigation+highlight */ },
    setCursorOffset: () => { /* no-op for navigation+highlight */ },
    forceRender: () => { pendingRender = true; },
    registerKeyHandler: (cb): Unsubscribe => {
      keyHandlers.push(cb);
      return () => removeFrom(keyHandlers, cb);
    },
    registerRenderHandler: (cb): Unsubscribe => {
      renderHandlers.push(cb);
      return () => removeFrom(renderHandlers, cb);
    },
    registerTextChangeHandler: (cb): Unsubscribe => {
      textHandlers.push(cb);
      return () => removeFrom(textHandlers, cb);
    },
    log,
  };

  const adapter = new ClaudeCodeV21Adapter(bindings);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();

  // Subscribe modules synchronously so the very first key dispatch is wired.
  const navigation = new Navigation(adapter, hlState, dynDefs);
  navigation.subscribe();
  const dimRender = new DimRender(adapter, hlState, dynDefs);
  dimRender.subscribe();

  // Fire-and-forget Runtime.create — used only for capability validation +
  // startup logging. Modules don't depend on its completion.
  Runtime.create(adapter).catch(err => {
    log('error', 'Runtime.create failed', err);
  });

  let handlerErrLogged = false;

  return {
    adapter,
    hlState,
    dynDefs,
    failed: false,

    dispatchKey(rawEvent, text, cursorOffset) {
      const event = normaliseKeyEvent(rawEvent, text, cursorOffset);
      for (const handler of keyHandlers) {
        try {
          if (handler(event)) return true;
        } catch (err) {
          if (!handlerErrLogged) {
            handlerErrLogged = true;
            log('error', 'key handler error', err);
          }
        }
      }
      return false;
    },

    consumePendingRender() {
      if (!pendingRender) return false;
      pendingRender = false;
      return true;
    },

    toggleRenderText(text) {
      return toggleZeroWidth(text);
    },

    applyRender(rendered, text, cursorOffset) {
      if (typeof rendered !== 'string') return rendered;
      if (renderHandlers.length === 0) return rendered;
      const ctx: RenderContext = {
        text,
        cursor: cursorOffset,
        externalHighlights: [],
      };
      let out = rendered;
      for (const handler of renderHandlers) {
        try {
          const directives = handler(ctx);
          if (directives) out = applyDirectives(out, directives);
        } catch (err) {
          log('error', 'render handler error', err);
        }
      }
      return out;
    },
  };
}
