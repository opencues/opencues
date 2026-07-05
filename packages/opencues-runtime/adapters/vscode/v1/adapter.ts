// VS Code v1 HostAdapter.
//
// Self-owned integration: the extension at `integrations/vscode/` is
// our own build artifact (no upstream fork to patch — see
// integrations/vscode/PLAN.md D1). The extension glue constructs a
// VscodeBindings object over the VS Code extension API (TextDocument /
// TextEditor / window events) and hands it to boot().
//
// Bindings shape follows shell/v1 (the other self-owned host) with the
// chrome/v1 additions: dynamic per-target capability probes
// (supportsCycling / supportsAgentRewrite — re-evaluated per resolve
// via the resolver build key) and a real getSelection. The "target"
// here is the active TextEditor; the glue re-points its closures on
// onDidChangeActiveTextEditor and calls BootResult.resetBufferState()
// on every real document switch (PLAN.md D3).

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

export interface VscodeBindings {
  hostVersion: string;
  cwd: string;
  getText(): string;
  getCursorOffset(): number;
  getSelection?(): Range | null;
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
  /** Language-allowlist + scheme/writability + doc-size verdict for the
   *  focused document. Feeds the resolver build key, so a verdict flip
   *  on editor switch rebuilds sources without a reload. */
  supportsCycling?(): boolean;
  /** Whether the focused document should run background agent rewrites
   *  (off for over-gate documents unless agent-window-words bounds the
   *  call — PLAN.md D14). */
  supportsAgentRewrite?(): boolean;
}

// No 'render-override': decorations style the buffer text but cannot
// display text that differs from it, so the band never claims
// textOverride support.
export const VSCODE_V1_CAPABILITIES: readonly Capability[] = [
  'file-read',
  'file-write',
  'force-render',
  'dim-ranges',
  'highlight-range',
  'selection',
  'change-source',
  // Decorations paint true colour — opts into the RGB path of
  // BlankLoadingAnimator (colours from `blank-loading-colors-rgb`).
  'render-rgb-color',
];

export class VscodeV1Adapter implements HostAdapter {
  readonly interfaceVersion = HOST_ADAPTER_INTERFACE_VERSION;
  readonly hostName = 'vscode';
  readonly hostVersion: string;
  readonly cwd: string;
  readonly capabilities: readonly Capability[];

  private _disposed = false;

  constructor(private bindings: VscodeBindings) {
    this.hostVersion = bindings.hostVersion;
    this.cwd = bindings.cwd;
    const caps: Capability[] = [...VSCODE_V1_CAPABILITIES];
    if (bindings.spawnProcess) caps.push('spawn-process');
    if (bindings.blankInvoke) caps.push('blank-invoke');
    this.capabilities = caps;
  }

  getText(): string {
    try { return this.bindings.getText(); } catch { return ''; }
  }
  getCursorOffset(): number {
    try { return this.bindings.getCursorOffset(); } catch { return 0; }
  }
  getSelection(): Range | null {
    try { return this.bindings.getSelection?.() ?? null; } catch { return null; }
  }

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

  supportsCycling(): boolean {
    // Null-safe default true, matching chrome/v1 — a missing probe means
    // "no gate", not "no cycling".
    try { return this.bindings.supportsCycling?.() ?? true; } catch { return true; }
  }
  supportsAgentRewrite(): boolean {
    try { return this.bindings.supportsAgentRewrite?.() ?? true; } catch { return true; }
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
