// HostAdapter interface v1 — see refactor.md §2.
// This file contains TYPES ONLY. No implementations, no imports from implementations.

export interface Modifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

export interface KeyFilter {
  keys?: readonly string[];
  requireModifiers?: readonly ('ctrl' | 'alt' | 'shift' | 'meta')[];
  forbidModifiers?: readonly ('ctrl' | 'alt' | 'shift' | 'meta')[];
}

export interface KeyEvent {
  readonly key: string;
  readonly modifiers: Modifiers;
  readonly text: string;
  readonly cursorOffset: number;
}

export interface TextChangeEvent {
  readonly text: string;
  readonly cursorOffset: number;
  readonly previousText: string;
  readonly source: 'user' | 'runtime' | 'host' | 'unknown';
}

export interface RenderContext {
  readonly text: string;
  readonly cursor: number;
  readonly externalHighlights: readonly ExternalHighlight[];
}

export interface ExternalHighlight {
  readonly start: number;
  readonly end: number;
  readonly priority?: number;
  readonly kind?: 'shimmer' | 'selection' | 'caret' | 'other';
}

export interface RenderDirectives {
  textOverride?: string;
  dimRanges?: readonly Range[];
  highlight?: HighlightRange;
}

export interface Range {
  readonly start: number;
  readonly end: number;
}

export interface HighlightRange extends Range {
  readonly color?: string;
}

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly detached?: boolean;
  readonly input?: string;
}

export interface ProcessHandle {
  readonly result: Promise<ProcessResult>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export type Capability =
  | 'shimmer'
  | 'render-override'
  | 'dim-ranges'
  | 'highlight-range'
  | 'selection'
  | 'spawn-process'
  | 'file-read'
  | 'file-write'
  | 'force-render'
  | 'change-source';

export type Unsubscribe = () => void;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const HOST_ADAPTER_INTERFACE_VERSION = 1;

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface HostAdapter {
  readonly interfaceVersion: number;

  readonly hostName: string;
  readonly hostVersion: string;
  readonly capabilities: readonly Capability[];
  readonly cwd: string;

  getText(): string;
  getCursorOffset(): number;
  getSelection(): Range | null;

  setText(text: string): void;
  setCursorOffset(offset: number): void;
  forceRender(): void;

  onKey(filter: KeyFilter | null, handler: (event: KeyEvent) => boolean): Unsubscribe;
  onTextChange(handler: (event: TextChangeEvent) => void): Unsubscribe;
  onRender(handler: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe;

  spawnProcess(spec: ProcessSpec): ProcessHandle;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * List directory entries (single level, no recursion). Optional —
   * adapters whose host has no notion of directories return null.
   * Covered by the `file-read` capability when present.
   */
  readDir?(path: string): Promise<readonly DirEntry[] | null>;

  log(level: LogLevel, msg: string, data?: unknown): void;

  dispose(): void;
}

export class AdapterUnsupportedError extends Error {
  constructor(capability: string) {
    super(`host adapter does not support: ${capability}`);
    this.name = 'AdapterUnsupportedError';
  }
}

export class AdapterIOError extends Error {
  constructor(op: string, cause: unknown) {
    super(`adapter I/O failed: ${op}`);
    this.name = 'AdapterIOError';
    (this as unknown as { cause: unknown }).cause = cause;
  }
}
