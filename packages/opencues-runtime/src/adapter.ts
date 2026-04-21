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

/**
 * Host-native control invocation. Sandboxed hosts (Chrome extension,
 * browser-only TUIs) can't spawn processes to run `volume.sh up` or
 * `weather-blank.sh get`. `controlInvoke` lets them fulfil the same
 * contract via their native API layer — Web Audio for volume,
 * fetch() for stocks/weather/HN, etc.
 *
 * BlankFill + Cycling check `adapter.controlInvoke` BEFORE
 * `spawnProcess`; hosts that return null fall through to the spawn
 * path. Hosts that return a ProcessHandle take ownership of the call
 * and the returned stdout is interpreted identically to a script's
 * stdout (same exitCode/timedOut semantics).
 */
export interface ControlInvokeSpec {
  /** Control name as declared in controls/<name>/cue.md (e.g. "volume"). */
  readonly controlName: string;
  /** Action verb — typically "get" / "set" / "up" / "down" but arbitrary. */
  readonly action: string;
  /** Action args. For "get" on a blank: [keyword, ...contextWords]. */
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
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
  | 'control-invoke'
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

/**
 * Base shape of the HostInfo argument that each adapter band's `boot()`
 * accepts. Hosts extend this with their own host-specific optional
 * fields (chrome adds controlInvoke/speakFn/httpAdapter, opencode adds
 * spawnProcess/ttsScriptPath, etc.).
 *
 * Why this exists: declaring HostInfo independently in each adapter
 * caused field-name drift — `apiUrl` vs `endpoint`, `tipsPath` typo
 * variants, etc. — that didn't surface until live testing because the
 * bootstraps used `as any`-shaped casts to bridge them. Pinning the
 * common subset here makes drift a tsc error.
 */
export interface CommonHostInfo {
  readonly hostVersion: string;
  readonly cwd: string;
  getText(): string;
  getCursorOffset(): number;
  setText(text: string): void;
  setCursorOffset(offset: number): void;
  forceRender(): void;
  readFile?(path: string): Promise<string | null>;
  readDir?(path: string): Promise<readonly DirEntry[] | null>;
  writeFile?(path: string, content: string): Promise<void>;
  pushText?(text: string, cursor?: number): void;
  log?(level: LogLevel, msg: string, data?: unknown): void;
  /** File path the Statusline module exports the JSON snapshot to.
   *  Hosts that have no filesystem (chrome) leave this unset. */
  statusFilePath?: string;
  /** In-process callback fired with the statusline payload on every
   *  state change. Mutually-optional with statusFilePath. */
  statusSnapshotHook?(payload: unknown): void;
  /** File path / virtual key for the cursor-state-export JSON. Used by
   *  the headless test harness. */
  cursorStatePath?: string;
  /** TTS rate (defaults to 2). Both shells (script-based) and browser
   *  (Web Speech) honour the same numeric scale. */
  ttsRate?: string | number;
  /** Optional LLM resolver fields. Resolver only constructs when
   *  llmApiKey is set. */
  llmApiKey?: string;
  llmEndpoint?: string;
  llmDefaultModel?: string;
  llmDebounceMs?: number;
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
  /**
   * Async text push, bypassing the dispatch return path. Used by modules
   * (BlankFill, Resolver) that need to commit text changes outside a key
   * dispatch — the host must propagate the new value through whatever
   * channel its own typing path uses (e.g. onChange callback). When the
   * host can't satisfy this, the implementation may be a no-op.
   */
  pushText?(text: string, cursorOffset?: number): void;

  onKey(filter: KeyFilter | null, handler: (event: KeyEvent) => boolean): Unsubscribe;
  onTextChange(handler: (event: TextChangeEvent) => void): Unsubscribe;
  onRender(handler: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe;

  spawnProcess(spec: ProcessSpec): ProcessHandle;
  /**
   * Host-native control invocation. Optional — when present, BlankFill
   * + Cycling try it BEFORE spawnProcess, falling through to the spawn
   * path if this returns null. Covered by the `control-invoke`
   * capability when present.
   */
  controlInvoke?(spec: ControlInvokeSpec): ProcessHandle | null;
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
