// Claude Code v2.1 HostAdapter.
//
// The adapter is a thin shim: cli.js bootstrap constructs a HostBindings object
// carrying references to the host's internals (extracted via seam bindings),
// and this adapter adapts those bindings to the HostAdapter interface.

import {
  AdapterUnsupportedError,
  HOST_ADAPTER_INTERFACE_VERSION,
  type Capability,
  type BlankInvokeSpec,
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

  /** Optional: read a file (absolute path). Resolves to null if missing. */
  readFile?(path: string): Promise<string | null>;

  /** Optional: list directory entries (absolute path). Resolves to null if missing. */
  readDir?(path: string): Promise<readonly { name: string; isDirectory: boolean }[] | null>;

  /** Optional: write a file (absolute path). Overwrites if exists. */
  writeFile?(path: string, content: string): Promise<void>;

  /** Optional: spawn a child process. Detached/fire-and-forget supported. */
  spawnProcess?(spec: ProcessSpec): ProcessHandle;

  /**
   * Optional host-native blank dispatch. Same shape as chrome's
   * blankInvoke — BlankFill + Cycling try this BEFORE spawnProcess
   * so shared TS blanks win over the legacy shell scripts.
   */
  blankInvoke?(spec: BlankInvokeSpec): ProcessHandle | null;

  /** Optional: async text push (calls captured onChange or equivalent). */
  pushText?(text: string, cursor?: number): void;

  log?(level: LogLevel, msg: string, data?: unknown): void;

  /** Structured event sink. Optional — fans out to subscribers
   *  registered via registerEventHandler. See HostAdapter.emitEvent. */
  emitEvent?(type: string, body?: Record<string, unknown>): void;
  /** Register an event subscriber. Returns unsub. Optional. */
  registerEventHandler?(cb: (type: string, body?: Record<string, unknown>) => void): Unsubscribe;
}

/**
 * Capabilities the v2.1 adapter advertises.
 *
 * `file-read` is listed because Runtime.create requires it; when the host
 * doesn't supply a `readFile` binding the adapter resolves every read to
 * null — the documented fallback. ConfigLoader wires real file access
 * through HostBindings when available.
 */
const V21_CAPABILITIES: readonly Capability[] = [
  'file-read',
  'file-write',
  'spawn-process',
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
    // Merge in 'blank-invoke' when the host wired a registry. Same
    // pattern as the chrome adapter — runtime modules check this cap
    // before trying blankInvoke (otherwise BlankFill skips the path
    // and goes straight to spawnProcess for everything).
    const merged: Capability[] = [...capabilities];
    if (bindings.blankInvoke && !merged.includes('blank-invoke')) {
      merged.push('blank-invoke');
    }
    this.capabilities = merged;
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
    // The HostAdapter contract says we clamp to [0, text.length], but on
    // Claude Code v2.1 bindings.getText is a closure over a long-gone
    // InputStateHandler invocation — we cannot read live text here.
    // Callers (e.g. Cycling) clamp against the text they're about to apply.
    try { this.bindings.setCursorOffset(Math.max(0, offset)); } catch (err) {
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
  pushText(text: string, cursor?: number): void {
    if (this._disposed) return;
    if (!this.bindings.pushText) return;
    try { this.bindings.pushText(text, cursor); } catch (err) {
      this.log('error', 'pushText failed', err);
    }
  }

  spawnProcess(spec: ProcessSpec): ProcessHandle {
    if (!this.bindings.spawnProcess) {
      return {
        result: Promise.reject(new AdapterUnsupportedError('spawn-process')),
        kill: () => {},
      };
    }
    try { return this.bindings.spawnProcess(spec); } catch (err) {
      this.log('error', 'spawnProcess failed', err);
      return {
        result: Promise.reject(err),
        kill: () => {},
      };
    }
  }
  /**
   * Forward to the host's blankInvoke binding when wired. Returns null
   * when the binding isn't present or the blankName isn't registered;
   * BlankFill + Cycling then fall through to spawnProcess for the legacy
   * shell scripts.
   */
  blankInvoke(spec: BlankInvokeSpec): ProcessHandle | null {
    return this.bindings.blankInvoke?.(spec) ?? null;
  }
  async readFile(path: string): Promise<string | null> {
    if (!this.bindings.readFile) return null;
    try { return await this.bindings.readFile(path); } catch (err) {
      this.log('error', 'readFile failed', err);
      return null;
    }
  }
  async readDir(path: string): Promise<readonly { name: string; isDirectory: boolean }[] | null> {
    if (!this.bindings.readDir) return null;
    try { return await this.bindings.readDir(path); } catch (err) {
      this.log('error', 'readDir failed', err);
      return null;
    }
  }
  async writeFile(path: string, content: string): Promise<void> {
    if (!this.bindings.writeFile) throw new AdapterUnsupportedError('file-write');
    try { await this.bindings.writeFile(path, content); } catch (err) {
      this.log('error', 'writeFile failed', err);
      throw err;
    }
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────
  log(level: LogLevel, msg: string, data?: unknown): void {
    if (this.bindings.log) {
      try { this.bindings.log(level, msg, data); } catch { /* swallow */ }
    }
  }
  emitEvent(type: string, body?: Record<string, unknown>): void {
    try { this.bindings.emitEvent?.(type, body); } catch { /* swallow */ }
  }
  onEvent(handler: (type: string, body?: Record<string, unknown>) => void): Unsubscribe {
    return this.bindings.registerEventHandler?.(handler) ?? (() => {});
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

/**
 * Compute the zero-width-char-toggled text that forces React to re-render the
 * input component without visibly changing content. Matches v1's mechanism
 * : strip any trailing ZWS/ZWNJ, then append the
 * opposite of whatever was previously there. Callers pass the result to
 * `InputZone.fromText(newText, columns, offset)` and return it from the
 * KeyDispatcher.
 *
 * Pure function, no side effects — the toggle is derived from the input text
 * itself, which React's render cycle keeps consistent with the parent's value.
 */
export function toggleZeroWidth(text: string): string {
  const stripped = text.replace(/[\u200B\u200C]+$/, '');
  // If the original ended with ZWS (\u200B), flip to ZWNJ (\u200C). Otherwise
  // (ends with ZWNJ, or no trailing ZW chars at all) use ZWS. This mirrors
  // v1's `if(_parentHasB) \u200C else \u200B` branching.
  const endedWithZws = text.length > stripped.length && text.charCodeAt(stripped.length) === 0x200b;
  return stripped + (endedWithZws ? '\u200c' : '\u200b');
}

// Mac Terminal.app emits Ctrl+Option+arrow as `\x1b\x1b[A` (double-ESC + CSI)
// with no Ctrl byte anywhere in the stream. The double-ESC byte prefix is a
// unique structural signature — it's only produced by Mac Terminal.app for
// this exact chord. Every other terminal (Ghostty, iTerm2, Linux xterm,
// Windows Terminal) uses xterm modifier-encoded CSI like `\x1b[1;7A` for
// Ctrl+Alt+arrow with the Ctrl bit present, so the synth is a no-op there.
//
// We gate on the raw byte sequence (`\x1b\x1b[`) rather than on `raw.option`,
// because both Ink and OpenTUI parsers ALSO set `option: true` for
// xterm-modifier CSI with bit 2 set (plain Alt+arrow → `\x1b[1;3A`). Gating
// on the byte signature instead of the parsed flag ensures the synth only
// affects Mac Terminal.app's specific encoding and can NEVER hijack
// plain Alt+arrow on Linux/Windows (word-jump muscle memory preserved).
const MAC_DOUBLE_ESC_ARROW_KEYS = new Set(['up', 'down', 'left', 'right']);

export function normaliseKeyEvent(raw: {
  key?: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  option?: boolean;
  shift?: boolean;
  super?: boolean;
  sequence?: string;
}, text: string, cursorOffset: number): KeyEvent {
  const keyName = (raw.key ?? '').toLowerCase();
  const isMacDoubleEscArrow =
    typeof raw.sequence === 'string' &&
    raw.sequence.startsWith('\x1b\x1b[') &&
    MAC_DOUBLE_ESC_ARROW_KEYS.has(keyName);
  const macDoubleEscCtrlSynth = isMacDoubleEscArrow && !raw.ctrl;
  const modifiers: Modifiers = {
    ctrl: !!raw.ctrl || macDoubleEscCtrlSynth,
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
