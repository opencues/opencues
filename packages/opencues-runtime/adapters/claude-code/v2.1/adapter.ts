// Claude Code v2.1 HostAdapter — Phase 1 minimum viable surface.
//
// The adapter is a thin shim: cli.js bootstrap constructs a HostBindings object
// carrying references to the host's internals (extracted via seam bindings),
// and this adapter adapts those bindings to the HostAdapter interface.
//
// For Phase 1 we only implement what Navigation needs. Later phases extend
// HostBindings and this adapter in parallel.

import {
  AdapterUnsupportedError,
  HOST_ADAPTER_INTERFACE_VERSION,
  type Capability,
  type HostAdapter,
  type KeyEvent,
  type KeyFilter,
  type LogLevel,
  type Modifiers,
  type ProcessHandle,
  type ProcessSpec,
  type Range,
  type RenderContext,
  type RenderDirectives,
  type TextChangeEvent,
  type Unsubscribe,
} from '../../../src/adapter';

/**
 * Bindings supplied by the cli.js bootstrap. The bootstrap captures identifier
 * references via seam predicates and hands them in here.
 */
export interface HostBindings {
  readonly hostVersion: string;
  readonly cwd: string;

  /** Current input buffer snapshot. */
  getText(): string;
  getCursorOffset(): number;

  /**
   * Replace the input buffer. The v2.1 mechanism is to set the parent-held
   * value via onChange + clear the InputZone. Bootstrap provides the concrete
   * implementation because the identifiers live inside cli.js.
   */
  setText(text: string): void;
  setCursorOffset(offset: number): void;

  /**
   * Force the input component to re-render without a buffer change. In v2.1
   * this is the zero-width-space toggle trick.
   */
  forceRender(): void;

  /** Register a key handler. Returns unsub. */
  registerKeyHandler(cb: (event: KeyEvent) => boolean): Unsubscribe;
  /** Register a render handler. Returns unsub. */
  registerRenderHandler(cb: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe;
  /** Register a text-change handler. Returns unsub. */
  registerTextChangeHandler(cb: (event: TextChangeEvent) => void): Unsubscribe;

  log?(level: LogLevel, msg: string, data?: unknown): void;
}

/**
 * Capabilities the v2.1 adapter advertises in Phase 1.
 *
 * `file-read` is listed because Runtime.create requires it, but the Phase 1
 * implementation resolves every read to null — the documented fallback. Phase 3
 * (ConfigLoader) wires real file access through HostBindings.
 */
const V21_CAPABILITIES: readonly Capability[] = [
  'file-read',
  'force-render',
  'render-override',
  'dim-ranges',
  'highlight-range',
];

export class ClaudeCodeV21Adapter implements HostAdapter {
  readonly interfaceVersion = HOST_ADAPTER_INTERFACE_VERSION;
  readonly hostName = 'claude-code';
  readonly hostVersion: string;
  readonly capabilities: readonly Capability[];
  readonly cwd: string;

  private _disposed = false;
  private _keySubs = new Map<symbol, { filter: KeyFilter | null; handler: (e: KeyEvent) => boolean }>();
  private _rootKeyUnsub: Unsubscribe | null = null;
  private _rootRenderUnsub: Unsubscribe | null = null;

  constructor(
    private bindings: HostBindings,
    capabilities: readonly Capability[] = V21_CAPABILITIES,
  ) {
    this.hostVersion = bindings.hostVersion;
    this.cwd = bindings.cwd;
    this.capabilities = capabilities;
  }

  // ─── State reads ───────────────────────────────────────────────────────
  getText(): string {
    try { return this.bindings.getText(); } catch { return ''; }
  }
  getCursorOffset(): number {
    try { return this.bindings.getCursorOffset(); } catch { return 0; }
  }
  getSelection(): Range | null { return null; }

  // ─── State writes ──────────────────────────────────────────────────────
  setText(text: string): void {
    if (this._disposed) return;
    try { this.bindings.setText(text); } catch (err) {
      this.log('error', 'setText failed', err);
    }
  }
  setCursorOffset(offset: number): void {
    if (this._disposed) return;
    const text = this.getText();
    const clamped = Math.max(0, Math.min(offset, text.length));
    try { this.bindings.setCursorOffset(clamped); } catch (err) {
      this.log('error', 'setCursorOffset failed', err);
    }
  }
  forceRender(): void {
    if (this._disposed) return;
    if (!this.capabilities.includes('force-render')) return;
    try { this.bindings.forceRender(); } catch (err) {
      this.log('error', 'forceRender failed', err);
    }
  }

  // ─── Events ────────────────────────────────────────────────────────────
  onKey(filter: KeyFilter | null, handler: (e: KeyEvent) => boolean): Unsubscribe {
    const token = Symbol('keySub');
    this._keySubs.set(token, { filter, handler });
    this._ensureRootKeySubscription();
    return () => {
      this._keySubs.delete(token);
    };
  }

  onTextChange(handler: (e: TextChangeEvent) => void): Unsubscribe {
    return this.bindings.registerTextChangeHandler(handler);
  }

  onRender(handler: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe {
    return this.bindings.registerRenderHandler(handler);
  }

  // ─── I/O ───────────────────────────────────────────────────────────────
  spawnProcess(_spec: ProcessSpec): ProcessHandle {
    return {
      result: Promise.reject(new AdapterUnsupportedError('spawn-process')),
      kill: () => {},
    };
  }
  async readFile(_path: string): Promise<string | null> { return null; }
  async writeFile(_path: string, _content: string): Promise<void> {
    throw new AdapterUnsupportedError('file-write');
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────
  log(level: LogLevel, msg: string, data?: unknown): void {
    if (this.bindings.log) {
      try { this.bindings.log(level, msg, data); } catch { /* swallow */ }
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._keySubs.clear();
    if (this._rootKeyUnsub) {
      try { this._rootKeyUnsub(); } catch { /* swallow */ }
      this._rootKeyUnsub = null;
    }
    if (this._rootRenderUnsub) {
      try { this._rootRenderUnsub(); } catch { /* swallow */ }
      this._rootRenderUnsub = null;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────
  private _ensureRootKeySubscription(): void {
    if (this._rootKeyUnsub) return;
    this._rootKeyUnsub = this.bindings.registerKeyHandler((event: KeyEvent) => {
      for (const sub of this._keySubs.values()) {
        if (!matchesFilter(event, sub.filter)) continue;
        let consumed: boolean;
        try {
          consumed = sub.handler(event);
        } catch (err) {
          this.log('error', 'onKey handler threw', err);
          consumed = false;
        }
        if (consumed) return true;
      }
      return false;
    });
  }
}

export function matchesFilter(event: KeyEvent, filter: KeyFilter | null): boolean {
  if (!filter) return true;
  if (filter.keys && !filter.keys.includes(event.key)) return false;
  if (filter.requireModifiers) {
    for (const m of filter.requireModifiers) {
      if (!event.modifiers[m]) return false;
    }
  }
  if (filter.forbidModifiers) {
    for (const m of filter.forbidModifiers) {
      if (event.modifiers[m]) return false;
    }
  }
  return true;
}

export function normaliseKeyEvent(raw: {
  key?: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  option?: boolean;
  shift?: boolean;
  super?: boolean;
}, text: string, cursorOffset: number): KeyEvent {
  const modifiers: Modifiers = {
    ctrl: !!raw.ctrl,
    alt: !!(raw.alt || raw.option || raw.meta),
    shift: !!raw.shift,
    meta: !!raw.super,
  };
  return {
    key: raw.key ?? '',
    modifiers,
    text,
    cursorOffset,
  };
}
