// Windows v1 HostAdapter.
//
// A system-wide Windows host. Unlike CC/OC/Gemini/shell the *editor*
// isn't ours and isn't even in this process — the text buffer lives in
// whatever Windows app the user is currently typing in (Notepad,
// WordPad, a WinForms/WPF dialog, an Office field, …). A thin
// Windows-native shim (native/OpenCuesWindows.cs) reads/writes that
// buffer via UI Automation and streams text/cursor/focus events over a
// socket to the WSL-side daemon (integrations/windows/src/hostd.cjs),
// which owns THIS adapter.
//
// The adapter therefore never touches UIA directly. It is fed a
// `WindowsBindings` object whose getText/getCursorOffset return the
// daemon's LOCAL MIRROR of the remote buffer (kept in sync by the
// shim's text events) and whose setText pushes a write command back
// across the socket. This is the same "host owns the buffer, adapter
// mirrors it" contract every other band follows — the mirror just
// happens to live one socket hop away from the real control.
//
// Phase 1 (this file): `supportsCycling` is pinned false. The host has
// no colour-overlay surface and intercepts no Ctrl+Alt+arrow chords, so
// the Universal-Integration profile prunes every cycleable cue/blank at
// registration (word-cues, selector/satellite, list/step blanks). What
// survives is the single-answer surface: `_` fluid-blank, transform-
// blank, and compute blanks (weather/stocks/…). See
// docs/architecture/universal-integration.md. Phase 2 will add a
// click-through overlay (painted from UIA bounding rects) + a
// low-level keyboard hook and flip `supportsCycling` to a per-field
// dynamic answer.
//
// Bindings shape is intentionally close to ShellBindings — the daemon
// is a plain event pump around a socket, structurally the same job the
// shell's OpenTUI wiring does around a textarea.

import type {
  HostAdapter,
  KeyEvent,
  KeyFilter,
  Range,
  RenderContext,
  RenderDirectives,
  TextChangeEvent,
  CursorChangeEvent,
  Unsubscribe,
  ProcessSpec,
  ProcessHandle,
  BlankInvokeSpec,
  DirEntry,
  LogLevel,
  Capability,
} from '../../../src/adapter';
import { HOST_ADAPTER_INTERFACE_VERSION } from '../../../src/adapter';

export interface WindowsBindings {
  hostVersion: string;
  cwd: string;
  getText(): string;
  getCursorOffset(): number;
  setText(text: string): void;
  setCursorOffset(offset: number): void;
  forceRender(): void;
  registerKeyHandler(cb: (e: KeyEvent) => boolean): Unsubscribe;
  registerTextChangeHandler(cb: (e: TextChangeEvent) => void): Unsubscribe;
  registerCursorChangeHandler(cb: (e: CursorChangeEvent) => void): Unsubscribe;
  registerRenderHandler(cb: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe;
  readFile?(path: string): Promise<string | null>;
  readDir?(path: string): Promise<readonly DirEntry[] | null>;
  writeFile?(path: string, content: string): Promise<void>;
  spawnProcess?(spec: ProcessSpec): ProcessHandle;
  blankInvoke?(spec: BlankInvokeSpec): ProcessHandle | null;
  pushText?(text: string, cursor?: number): void;
  log?(level: LogLevel, msg: string, data?: unknown): void;
  emitEvent?(type: string, body?: Record<string, unknown>): void;
  registerEventHandler?(cb: (type: string, body?: Record<string, unknown>) => void): Unsubscribe;
  /**
   * Dynamic per-field cycling answer. Phase 1 pins this to a constant
   * `false` (no overlay, no chord intercept). When phase 2 lands the
   * overlay the daemon will vary it by the current UIA target's
   * capabilities (TextPattern + bounding rects present → true).
   * Defaults to false when omitted.
   */
  supportsCycling?(): boolean;
}

// No render capabilities in phase 1 — there is no overlay yet, so the
// runtime's dim/highlight/markdown directives have nowhere to paint.
// They're still collected (harmless) but the host advertises no render
// caps, and `supportsCycling: false` prunes the sources that would rely
// on them. file-read/write + force-render are real (the daemon has a
// Node fs + a socket flush).
export const WINDOWS_V1_CAPABILITIES: readonly Capability[] = [
  'file-read',
  'file-write',
  'force-render',
];

export class WindowsV1Adapter implements HostAdapter {
  readonly interfaceVersion = HOST_ADAPTER_INTERFACE_VERSION;
  readonly hostName = 'windows';
  readonly hostVersion: string;
  readonly cwd: string;
  readonly capabilities: readonly Capability[];

  private _disposed = false;

  constructor(private bindings: WindowsBindings) {
    this.hostVersion = bindings.hostVersion;
    this.cwd = bindings.cwd;
    const caps: Capability[] = [...WINDOWS_V1_CAPABILITIES];
    if (bindings.spawnProcess) caps.push('spawn-process');
    if (bindings.blankInvoke) caps.push('blank-invoke');
    this.capabilities = caps;
  }

  // Phase 1: never a cycling surface. Delegates to the binding so
  // phase 2 can make it per-field dynamic without touching this class.
  supportsCycling(): boolean {
    try { return this.bindings.supportsCycling?.() ?? false; } catch { return false; }
  }

  getText(): string {
    try { return this.bindings.getText(); } catch { return ''; }
  }
  getCursorOffset(): number {
    try { return this.bindings.getCursorOffset(); } catch { return 0; }
  }
  getSelection(): Range | null { return null; }

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
  onCursorChange(handler: (e: CursorChangeEvent) => void): Unsubscribe {
    return this.bindings.registerCursorChangeHandler(handler);
  }
  onRender(handler: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe {
    return this.bindings.registerRenderHandler(handler);
  }

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
  blankInvoke(spec: BlankInvokeSpec): ProcessHandle | null {
    return this.bindings.blankInvoke?.(spec) ?? null;
  }
  pushText(text: string, cursor?: number): void {
    this.bindings.pushText?.(text, cursor);
  }

  log(level: LogLevel, msg: string, data?: unknown): void {
    this.bindings.log?.(level, msg, data);
  }
  emitEvent(type: string, body?: Record<string, unknown>): void {
    this.bindings.emitEvent?.(type, body);
  }
  onEvent(handler: (type: string, body?: Record<string, unknown>) => void): Unsubscribe {
    return this.bindings.registerEventHandler?.(handler) ?? (() => {});
  }
  dispose(): void {
    this._disposed = true;
  }
}
