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

/**
 * Cursor-only change — fired when the cursor moves WITHOUT the text
 * changing (mouse click, arrow keys without typing, programmatic cursor
 * jump). Hosts that can't distinguish cursor-only moves from text
 * changes can omit `onCursorChange` entirely; the runtime degrades to
 * "highlight follows typing only".
 */
export interface CursorChangeEvent {
  readonly text: string;
  readonly cursorOffset: number;
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
 * Host-native blank invocation. Sandboxed hosts (Chrome extension,
 * browser-only TUIs) can't spawn processes to run `volume.sh up` or
 * `weather-blank.sh get`. `blankInvoke` lets them fulfil the same
 * contract via their native API layer — Web Audio for volume,
 * fetch() for stocks/weather/HN, etc.
 *
 * BlankFill + Cycling check `adapter.blankInvoke` BEFORE
 * `spawnProcess`; hosts that return null fall through to the spawn
 * path. Hosts that return a ProcessHandle take ownership of the call
 * and the returned stdout is interpreted identically to a script's
 * stdout (same exitCode/timedOut semantics).
 *
 * The `blankName` field identifies which blank to invoke (declared in
 * blanks/<name>/BLANK.md, e.g. "volume").
 */
export interface BlankInvokeSpec {
  /** Blank name as declared in blanks/<name>/BLANK.md (e.g. "volume"). */
  readonly blankName: string;
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
  | 'blank-invoke'
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
 * fields (chrome adds blankInvoke/speakFn/httpAdapter, opencode adds
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
   *  at least one api key is available (either `llmApiKey` legacy or
   *  any entry in `llmApiKeys`). */
  llmApiKey?: string;
  llmEndpoint?: string;
  llmDefaultModel?: string;
  llmDebounceMs?: number;
  /**
   * API keys keyed by provider env-var name (GROQ_API_KEY,
   * OPENROUTER_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, …). Boot reads
   * `process.env` and forwards whichever keys are set. The runtime's
   * provider resolver picks the right one based on `llm-provider:` /
   * `<feature>-provider:` CUES.md settings.
   *
   * Hosts that can't read process.env (Chrome) populate this from a
   * settings UI / chrome.storage. Legacy `llmApiKey` is still honoured
   * as the GROQ_API_KEY when this map isn't supplied.
   */
  llmApiKeys?: Readonly<Record<string, string | undefined>>;
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
  /**
   * Optional cursor-only event. Hosts that can detect cursor moves
   * without text changes (selection-change events, focus subscription,
   * etc.) emit this; hosts that can't omit the property entirely.
   * Subscribers must handle the missing-method case gracefully.
   */
  onCursorChange?(handler: (event: CursorChangeEvent) => void): Unsubscribe;
  onRender(handler: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe;

  spawnProcess(spec: ProcessSpec): ProcessHandle;
  /**
   * Host-native blank invocation. Optional — when present, BlankFill
   * + Cycling try it BEFORE spawnProcess, falling through to the spawn
   * path if this returns null. Covered by the `blank-invoke`
   * capability when present.
   */
  blankInvoke?(spec: BlankInvokeSpec): ProcessHandle | null;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * List directory entries (single level, no recursion). Optional —
   * adapters whose host has no notion of directories return null.
   * Covered by the `file-read` capability when present.
   */
  readDir?(path: string): Promise<readonly DirEntry[] | null>;

  log(level: LogLevel, msg: string, data?: unknown): void;

  /**
   * Structured event sink — modules call this at lifecycle boundaries
   * (resolver.completed, blank.substituted, transform-blank.pass, …) so
   * subscribers can observe the runtime as a stream of point-in-time
   * facts rather than parsing log lines.
   *
   * Optional + always called via `?.` so it's a true no-op when no one
   * subscribes (i.e. normal user sessions). The internal event-bridge
   * wires the corresponding sink when armed; published events flow into
   * `/tmp/opencues-events-<pid>.jsonl`.
   *
   * `type` is dot-namespaced (`<module>.<verb>`). `body` is anything
   * JSON-serialisable. Modules may emit any type; consumers tolerate
   * unknowns.
   */
  emitEvent?(type: string, body?: Record<string, unknown>): void;

  /**
   * Subscribe to the structured event stream emitted via emitEvent.
   * Optional in the same sense as emitEvent — hosts that can't fan
   * out events (or no bridge is subscribed) leave it undefined;
   * subscribers must handle the missing-method case gracefully.
   */
  onEvent?(handler: (type: string, body?: Record<string, unknown>) => void): Unsubscribe;

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
