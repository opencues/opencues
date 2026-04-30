// Chrome extension v1 HostAdapter — scaffold (Phase CE.0).
//
// The Chrome extension content script runs inside a web page; it cannot
// spawn processes or read files off disk. The adapter translates
// HostAdapter calls into browser APIs:
//
//   - get/setText → contenteditable.textContent + window.getSelection()
//   - onKey → document.addEventListener('keydown')
//   - onTextChange → content script fires on input/MutationObserver
//   - onRender → runtime subscribes, content script queries on its own
//                render triggers (CSS Highlight API updates).
//   - readFile/writeFile → chrome.storage.local backed (file path is
//                          the storage key).
//   - readDir → returns a baked manifest (cues/, blanks/) the
//               extension's esbuild config populates at build time.
//   - spawnProcess → not supported (extension is sandboxed). Blanks
//                    that need external state use fetch() from the
//                    content script or background worker instead.
//
// Mirrors the OpenCode v1.4 adapter shape deliberately — keeps both
// bands drifting in lockstep when the HostAdapter contract evolves.

import type {
  BlankInvokeSpec,
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
  DirEntry,
  LogLevel,
  Capability,
} from '../../../src/adapter';
import { HOST_ADAPTER_INTERFACE_VERSION } from '../../../src/adapter';

/**
 * Live bindings the Chrome-side content script supplies. These are the
 * browser-API shims: the adapter class is DOM-agnostic itself.
 */
export interface ChromeBindings {
  /** Extension version, e.g. "0.1.0". */
  hostVersion: string;
  /**
   * Symbolic root for config paths. The Chrome extension has no real
   * filesystem, so this is typically a sentinel like "/chrome-storage"
   * or the extension's id. ConfigLoader uses it to build `${cwd}/cues.md`
   * style keys that readFile/writeFile resolve against chrome.storage.
   */
  cwd: string;
  /** Reads the current input text from the focused contenteditable. */
  getText(): string;
  /** Reads the current caret offset (in plain-text characters). */
  getCursorOffset(): number;
  /** Writes new text into the contenteditable + re-selects cursor. */
  setText(text: string): void;
  /** Moves the caret to the given plain-text offset. */
  setCursorOffset(offset: number): void;
  /** Asks the content script to re-run its render pass (CSS Highlights). */
  forceRender(): void;
  /** Registers a key handler the content script's keydown listener fires. */
  registerKeyHandler(cb: (e: KeyEvent) => boolean): Unsubscribe;
  /** Registers a text-change handler — fires from input/MutationObserver. */
  registerTextChangeHandler(cb: (e: TextChangeEvent) => void): Unsubscribe;
  /** Registers a render handler — fires when the content script computes
   *  its next frame of highlights/dims. */
  registerRenderHandler(cb: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe;
  /** chrome.storage.local-backed or in-memory. Path is an arbitrary key. */
  readFile?(path: string): Promise<string | null>;
  /** Same as readFile — chrome.storage write. */
  writeFile?(path: string, content: string): Promise<void>;
  /** Bake-time manifest lookup (cues/, blanks/). Return null when unknown. */
  readDir?(path: string): Promise<readonly DirEntry[] | null>;
  /**
   * Push text asynchronously (BlankFill / Resolver). Same plumbing as
   * setText + cursor reposition in one call. Matches the OpenCode band.
   */
  pushText?(text: string, cursor?: number): void;
  /**
   * Optional blank dispatch for sandboxed hosts. BlankFill +
   * Cycling try this BEFORE spawnProcess. Returns ProcessHandle for
   * blanks the host knows; null falls through to spawnProcess
   * (which the chrome adapter resolves with exitCode 127).
   */
  blankInvoke?(spec: BlankInvokeSpec): ProcessHandle | null;
  log?(level: LogLevel, msg: string, data?: unknown): void;
}

/**
 * Capabilities Chrome advertises by default. spawn-process is NEVER
 * available. file-read/file-write cover chrome.storage-backed config.
 */
export const CHROME_V1_CAPABILITIES: readonly Capability[] = [
  'file-read',
  'file-write',
  'force-render',
  'render-override',
  'dim-ranges',
  'highlight-range',
];

export class ChromeV1Adapter implements HostAdapter {
  readonly interfaceVersion = HOST_ADAPTER_INTERFACE_VERSION;
  readonly hostName = 'chrome';
  readonly hostVersion: string;
  readonly cwd: string;
  readonly capabilities: readonly Capability[];

  private _disposed = false;

  constructor(private bindings: ChromeBindings) {
    this.hostVersion = bindings.hostVersion;
    this.cwd = bindings.cwd;
    // spawn-process is NEVER advertised — Chrome extensions can't spawn.
    const caps: Capability[] = [...CHROME_V1_CAPABILITIES];
    if (bindings.blankInvoke) caps.push('blank-invoke');
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
  blankInvoke(spec: BlankInvokeSpec): ProcessHandle | null {
    return this.bindings.blankInvoke?.(spec) ?? null;
  }
  spawnProcess(_spec: ProcessSpec): ProcessHandle {
    // Chrome extensions cannot spawn. Return a rejected handle so
    // callers that ignore capabilities surface the error instead of
    // hanging on a never-resolving Promise.
    return {
      result: Promise.resolve({
        exitCode: 127,
        stdout: '',
        stderr: 'spawnProcess not supported in chrome adapter',
        timedOut: false,
      }),
      kill: () => {},
    };
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
