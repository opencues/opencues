// Universal v1 HostAdapter — the no-cycling profile.
//
// Unlike the editor bands, the "buffer" is whatever text channel the
// hosting daemon serves: a polled Notes.app note (apple-notes), the
// focused AX text element of any app (mac), …. There may be no real
// key events and no render surface — the universal/no-cycling profile
// (docs/architecture/universal-integration.md). The daemon supplies
// text + cursor (real or synthesized at the `_` marker), fires
// onTextChange per buffer change, and owns the write-back mechanics
// (CAS HTML splice, AX range replace, …). Host identity comes from
// bindings.hostName — never hard-coded here.
//
// Bindings shape mirrors ShellBindings minus the key/cursor/render
// registration so band drift against shell/v1 stays easy to audit.

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

export interface UniversalBindings {
  /** Canonical host name reported to on-host routing and logs —
   *  'apple-notes', 'mac', … The band is host-generic; identity is
   *  the ONE thing each daemon must declare (a hard-coded name here
   *  made the mac host masquerade as apple-notes for `on-host:`
   *  scoping — caught in the 2026-07-12 rename). */
  hostName: string;
  hostVersion: string;
  cwd: string;
  getText(): string;
  getCursorOffset(): number;
  setText(text: string): void;
  setCursorOffset(offset: number): void;
  forceRender(): void;
  /**
   * No physical keyboard reaches this host — the ONLY key events are
   * synthetic standalone-`_` arms the daemon dispatches when a poll
   * shows a fresh marker in the edited region. They feed the resolver/
   * BlankFill explicit-`_` gate through the same onUnderscoreKey path
   * real keyboards use (see universal.scenarios.test.ts).
   */
  registerKeyHandler(cb: (e: KeyEvent) => boolean): Unsubscribe;
  registerTextChangeHandler(cb: (e: TextChangeEvent) => void): Unsubscribe;
  readFile?(path: string): Promise<string | null>;
  readDir?(path: string): Promise<readonly DirEntry[] | null>;
  writeFile?(path: string, content: string): Promise<void>;
  spawnProcess?(spec: ProcessSpec): ProcessHandle;
  blankInvoke?(spec: BlankInvokeSpec): ProcessHandle | null;
  pushText?(text: string, cursor?: number): void;
  log?(level: LogLevel, msg: string, data?: unknown): void;
  emitEvent?(type: string, body?: Record<string, unknown>): void;
  registerEventHandler?(cb: (type: string, body?: Record<string, unknown>) => void): Unsubscribe;
}

// No render-capable surface: the daemon cannot dim, highlight, or paint.
// force-render is a no-op the runtime is allowed to call.
export const APPLE_NOTES_V1_CAPABILITIES: readonly Capability[] = [
  'file-read',
  'file-write',
  'force-render',
];

export class UniversalV1Adapter implements HostAdapter {
  readonly interfaceVersion = HOST_ADAPTER_INTERFACE_VERSION;
  readonly hostName: string;
  readonly hostVersion: string;
  readonly cwd: string;
  readonly capabilities: readonly Capability[];

  private _disposed = false;

  constructor(private bindings: UniversalBindings) {
    this.hostName = bindings.hostName;
    this.hostVersion = bindings.hostVersion;
    this.cwd = bindings.cwd;
    const caps: Capability[] = [...APPLE_NOTES_V1_CAPABILITIES];
    if (bindings.spawnProcess) caps.push('spawn-process');
    if (bindings.blankInvoke) caps.push('blank-invoke');
    this.capabilities = caps;
  }

  // Polled channel with no colour surface and no key interception:
  // every cycleable cue/blank must be pruned at registration.
  supportsCycling(): boolean { return false; }
  // Background whole-note rewrites over a polled CAS channel are too
  // risky for v1 — a merge landing between polls would fight the user.
  supportsAgentRewrite(): boolean { return false; }

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
    // No render surface — deliberate no-op.
  }

  onKey(filter: KeyFilter | null, handler: (e: KeyEvent) => boolean): Unsubscribe {
    // Carries ONLY the daemon's synthetic `_` arm events (see the
    // UniversalBindings.registerKeyHandler doc). Filter logic mirrors
    // shell/v1 so the resolver's `{ keys: ['_'] }` subscription works.
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
  onCursorChange(_handler: (e: CursorChangeEvent) => void): Unsubscribe {
    return () => {};
  }
  onRender(_handler: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe {
    return () => {};
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
