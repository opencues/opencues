// OpenCode v1.4 HostAdapter — minimum viable scaffold (Phase O.1).
//
// OpenCode's TUI is built on @opentui/core + @opentui/solid + solid-js.
// The Prompt component (component/prompt/index.tsx) holds a
// TextareaRenderable as `input` and the SolidJS store entry
// `store.prompt.input`. We bridge HostAdapter through these.
//
// At O.1 only the methods used by the bootstrap path + Phase 1
// Navigation are implemented for real. The rest stub out so the
// runtime starts cleanly even on a partially-wired host.

import type {
  HostAdapter,
  KeyEvent,
  KeyFilter,
  Range,
  RenderContext,
  RenderDirectives,
  TextChangeEvent,
  Unsubscribe,
  ProcessSpec,
  ProcessHandle,
  ControlInvokeSpec,
  DirEntry,
  LogLevel,
  Capability,
} from '../../../src/adapter';
import { HOST_ADAPTER_INTERFACE_VERSION } from '../../../src/adapter';

/**
 * Live bindings the OpenCode-side patch supplies. SolidJS reactivity
 * makes most of these direct closures over signals/refs.
 */
export interface OpenCodeBindings {
  hostVersion: string;
  cwd: string;
  /** Reads the current input text from the SolidJS store / TextareaRenderable. */
  getText(): string;
  /** Reads the current cursor position. */
  getCursorOffset(): number;
  /** Writes new text into the store + textarea ref. */
  setText(text: string): void;
  /** Sets the cursor position. */
  setCursorOffset(offset: number): void;
  /** Forces a re-render via OpenTUI's renderer.requestRender(). */
  forceRender(): void;
  /** Registers a key handler to fire from useKeyboard's callback. */
  registerKeyHandler(cb: (e: KeyEvent) => boolean): Unsubscribe;
  /** Registers a text-change handler — fires when prompt input changes. */
  registerTextChangeHandler(cb: (e: TextChangeEvent) => void): Unsubscribe;
  /** Registers a render handler — fires per-render with directives target. */
  registerRenderHandler(cb: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe;
  /** Optional file I/O. */
  readFile?(path: string): Promise<string | null>;
  readDir?(path: string): Promise<readonly DirEntry[] | null>;
  writeFile?(path: string, content: string): Promise<void>;
  /** Optional spawn (Bun.spawn or node:child_process). */
  spawnProcess?(spec: ProcessSpec): ProcessHandle;
  /**
   * Optional host-native control dispatch. Same shape as chrome's
   * controlInvoke — BlankFill + Cycling try this BEFORE spawnProcess so
   * shared TS controls (HackerNewsControl, etc.) win over the legacy
   * shell scripts in controls/. Returns null when the controlName
   * isn't in the host's registry.
   */
  controlInvoke?(spec: ControlInvokeSpec): ProcessHandle | null;
  /** Optional async text push — for fills that happen outside a key dispatch. */
  pushText?(text: string, cursor?: number): void;
  log?(level: LogLevel, msg: string, data?: unknown): void;
}

/** Capabilities OpenCode advertises by default. spawn-process opt-in via host bindings. */
export const OPENCODE_V14_CAPABILITIES: readonly Capability[] = [
  'file-read',
  'file-write',
  'force-render',
  'render-override',
  'dim-ranges',
  'highlight-range',
];

export class OpenCodeV14Adapter implements HostAdapter {
  readonly interfaceVersion = HOST_ADAPTER_INTERFACE_VERSION;
  readonly hostName = 'opencode';
  readonly hostVersion: string;
  readonly cwd: string;
  readonly capabilities: readonly Capability[];

  private _disposed = false;

  constructor(private bindings: OpenCodeBindings) {
    this.hostVersion = bindings.hostVersion;
    this.cwd = bindings.cwd;
    const caps: Capability[] = [...OPENCODE_V14_CAPABILITIES];
    if (bindings.spawnProcess) caps.push('spawn-process');
    if (bindings.controlInvoke) caps.push('control-invoke');
    this.capabilities = caps;
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
    try { this.bindings.setCursorOffset(Math.max(0, offset)); } catch (err) {
      this.log('error', 'setCursorOffset failed', err);
    }
  }
  forceRender(): void {
    if (this._disposed) return;
    try { this.bindings.forceRender(); } catch (err) {
      this.log('error', 'forceRender failed', err);
    }
  }

  // ─── Events ────────────────────────────────────────────────────────────
  onKey(filter: KeyFilter | null, handler: (e: KeyEvent) => boolean): Unsubscribe {
    if (!filter) return this.bindings.registerKeyHandler(handler);
    const wrapped = (e: KeyEvent): boolean => {
      if (filter.keys && filter.keys.length > 0 && !filter.keys.includes(e.key)) return false;
      if (filter.requireModifiers) for (const m of filter.requireModifiers) if (!e.modifiers[m]) return false;
      if (filter.forbidModifiers) for (const m of filter.forbidModifiers) if (e.modifiers[m]) return false;
      return handler(e);
    };
    return this.bindings.registerKeyHandler(wrapped);
  }
  onTextChange(handler: (e: TextChangeEvent) => void): Unsubscribe {
    return this.bindings.registerTextChangeHandler(handler);
  }
  onRender(handler: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe {
    return this.bindings.registerRenderHandler(handler);
  }

  // ─── I/O ───────────────────────────────────────────────────────────────
  readFile(path: string): Promise<string | null> {
    return this.bindings.readFile?.(path) ?? Promise.resolve(null);
  }
  readDir(path: string): Promise<readonly DirEntry[] | null> {
    return this.bindings.readDir?.(path) ?? Promise.resolve(null);
  }
  writeFile(path: string, content: string): Promise<void> {
    return this.bindings.writeFile?.(path, content) ?? Promise.resolve();
  }
  spawnProcess(spec: ProcessSpec): ProcessHandle {
    if (!this.bindings.spawnProcess) throw new Error('spawnProcess not supported');
    return this.bindings.spawnProcess(spec);
  }
  /**
   * Forward to the host's controlInvoke binding when one is supplied
   * (opencode now ships shared TS controls — HackerNewsControl etc. —
   * via this path so they don't need a shell). Returns null when the
   * binding isn't wired or the controlName isn't registered; runtime
   * then falls through to spawnProcess for the legacy shell scripts.
   */
  controlInvoke(spec: ControlInvokeSpec): ProcessHandle | null {
    return this.bindings.controlInvoke?.(spec) ?? null;
  }
  pushText(text: string, cursor?: number): void {
    this.bindings.pushText?.(text, cursor);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────
  log(level: LogLevel, msg: string, data?: unknown): void {
    this.bindings.log?.(level, msg, data);
  }
  dispose(): void {
    this._disposed = true;
  }
}
