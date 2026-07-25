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
  // ─── Markdown render ranges ────────────────────────────────────────
  // Populated by MarkdownRender after an LLM substitution lands. The
  // ranges are CHARACTER ranges into the buffer text — they include the
  // markdown syntax characters themselves (`**`, `*`, `` ` ``, etc.) so
  // the renderer can decide whether to dim the markers or not. Native
  // hosts insert ANSI escapes; chrome translates into per-site styling
  // (Phase 2). All optional — MarkdownRender omits the field entirely
  // when no markdown is detected, keeping the directive cheap.
  boldRanges?: readonly Range[];
  italicRanges?: readonly Range[];
  codeRanges?: readonly Range[];
  strikeRanges?: readonly Range[];
  headingRanges?: readonly Range[];
  listRanges?: readonly Range[];
  // ─── Per-range colour overrides ────────────────────────────────────
  // Currently emitted only by BlankLoadingAnimator (per-frame loading
  // colours from `blank-loading-colors-ansi` / `blank-loading-colors-rgb`).
  // Terminal hosts consume `ansi` (an ANSI fg token: named colour, 256
  // index, or `bright_*`); chrome consumes `rgb` (a #rrggbb string).
  // Both can be set; the host picks the one it can render.
  coloredRanges?: readonly ColoredRange[];
}

export interface ColoredRange extends Range {
  readonly ansi?: string;
  readonly rgb?: string;
}

export interface Range {
  readonly start: number;
  readonly end: number;
}

export interface HighlightRange extends Range {
  readonly color?: string;
}

/**
 * OS-level sandbox config for a single spawnProcess invocation.
 * Populated by blank-fill from the blank's frontmatter; honored by
 * each host's spawn wrapper (via `wrapWithBwrap` from
 * `security/sandbox-runner.ts`). Hosts on platforms without a
 * sandbox implementation (or with the sandbox tool missing — e.g.
 * `bwrap` not installed on Linux) MUST fall back to running the
 * spec unwrapped: the path sandbox + audit log still apply, just
 * not OS-level confinement.
 */
export interface SandboxConfig {
  /** 'strict' = wrap with bwrap (read-only fs, no net, isolated PID/IPC).
   *  'off' (or undefined) = run unwrapped. */
  readonly mode?: 'strict' | 'off';
  /** Network policy inside the sandbox. Defaults to 'deny'. */
  readonly net?: 'allow' | 'deny';
  /** Filesystem-write policy for the blank's own folder. Defaults to 'ro'.
   *  /tmp is always rw inside a fresh tmpfs that dies with the process. */
  readonly fs?: 'ro' | 'rw';
  /** Folder bind-mounted into the sandbox at the same path it has on
   *  the host. Typically the blank's own folder so the script can
   *  load colocated assets. */
  readonly workdir?: string;
}

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly detached?: boolean;
  readonly input?: string;
  readonly sandbox?: SandboxConfig;
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
  /**
   * The inverse of a file write the invoked blank performed (sentinel →
   * IDENTITY.md, note → NOTES.md), attached by `createBlankInvoke` when
   * the blank exposes one. BlankFill records it into the undo journal;
   * replaying `inverseOp` through the blank path re-runs the blank's own
   * validator by construction. Absent on the spawnProcess path and on
   * hosts that wrap blankInvoke without forwarding extra fields —
   * undo then simply can't revert that file write (degrades, never lies).
   */
  readonly writeInverse?: BlankWriteInverse;
}

/** A recorded blank-write inversion — both ops are ordinary blank
 *  invocations ({keyword, args} as `blankInvoke`'s get-action speaks
 *  them), never raw file bytes. */
export interface BlankWriteInverse {
  readonly file: 'IDENTITY.md' | 'NOTES.md';
  readonly blankName: string;
  readonly inverseOp: { readonly keyword: string; readonly args: readonly string[] };
  readonly forwardOp: { readonly keyword: string; readonly args: readonly string[] };
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
  | 'change-source'
  // Host can render true-colour (RGB/HEX) on directive ranges — chrome
  // sets this. Terminal hosts (CC / OC / gemini) leave it unset, which
  // routes through ANSI escapes instead.
  | 'render-rgb-color';

/**
 * Sanitized, low-fan-out context describing the field a user is
 * currently filling. Used by FluidBlankSource (only) to disambiguate
 * vague fluid-blank requests — e.g. an `_` in a field labelled
 * "Destination" on flights.google.com should resolve differently than
 * the same `_` on airbnb.com.
 *
 * Security contract — every field is treated as UNTRUSTED input.
 * Reading rules (host-side gatherer):
 *   - SINGLE-FIELD only. No sibling field labels. No sibling field
 *     values, ever. The adjacent "email" input next to the `_` field
 *     does not appear here.
 *   - Page-level metadata is limited to title, description, and the
 *     origin+path portion of the URL (no query string, no fragment).
 *   - Hosts MUST return null for sensitive fields (password, CC, OTP).
 *
 * Sink rules (core-side consumer in FluidBlankSource):
 *   - Sanitized (NFKC, control-char strip, length caps, sentinel
 *     escape) before going into a prompt.
 *   - Only injected as a labelled UNTRUSTED block — the LLM is told
 *     to use it for disambiguation, never as instructions.
 *   - The fluid-blank prompt MUST contain no other system data
 *     (cwd, env, agent state, recent history). The single security
 *     invariant the feature relies on.
 *
 * OpenCues as a whole MUST NOT plug ambient context into anything
 * with side effects — no tool handlers, no exec layers, no
 * structured-output channels that escape the text buffer. Worst-case
 * if a label contains a prompt injection: the LLM produces wrong
 * text, the user sees it before submitting. That envelope is the
 * security boundary.
 *
 * Feature is OFF by default. Gated by the `ambient-context-mode`
 * scalar in OPENCUES.md (off | on). When off, the host adapter's
 * getAmbientContext returns null — the core never sees this shape.
 */
export interface AmbientContext {
  /** Visible field label — from `<label for>` / wrapping `<label>` /
   *  aria-labelledby resolution. */
  readonly label?: string;
  /** placeholder attribute. */
  readonly placeholder?: string;
  /** aria-label attribute (when label is otherwise missing). */
  readonly ariaLabel?: string;
  /** aria-description attribute. */
  readonly ariaDescription?: string;
  /** input type (text / email / search / url / textarea / contenteditable). */
  readonly inputType?: string;
  /** document.title. */
  readonly pageTitle?: string;
  /** location.origin + location.pathname — query + fragment stripped. */
  readonly pageUrl?: string;
  /** `<meta name="description">` content. */
  readonly pageDescription?: string;
}

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
  /**
   * Optional registry of built-in blank instances. When supplied, the
   * runtime constructs a `blankContextProvider` that snapshots
   * context-eligible blanks (those with `as-context: safe|raw` in
   * BLANK.md) and surfaces their current values as ambient tokens for
   * fluid-blank. Without this map, `blank-context-mode` in OPENCUES.md
   * is silently inert. See docs/features/blank-as-context.md.
   *
   * Hosts already build this map for `blankInvoke`; passing it here
   * too is a one-line wire. Optional so adapters that don't ship
   * built-in blanks (chrome host-process flow) can omit it.
   */
  blanks?: ReadonlyMap<string, import('./blanks/types').Blank>;
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
  /**
   * Provider override from a host-level UI (e.g. chrome popup's
   * Provider dropdown). When set, overrides OPENCUES.md's
   * `llm-provider:` scalar; empty string / undefined means "no
   * override — runtime auto-routes via `pickAutoProvider`". Values:
   * 'groq' | 'cerebras' | 'openai' | 'anthropic' | 'gemini' | 'openrouter'.
   */
  llmProvider?: string;
  llmDebounceMs?: number;
  /**
   * API keys keyed by provider env-var name (GROQ_API_KEY,
   * OPENROUTER_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, …). Boot reads
   * `process.env` and forwards whichever keys are set. The runtime's
   * provider resolver picks the right one based on `llm-provider:` /
   * `<feature>-provider:` OPENCUES.md settings.
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

  /**
   * True iff the host currently provides a CYCLING SURFACE — i.e. it
   * intercepts Ctrl+Alt+arrow keys AND paints visual feedback for the
   * user to step between alternatives.
   *
   * Dynamic, not static: chrome attaches to both contenteditables (full
   * cycling surface) AND plain `<input>` / `<textarea>` (Universal
   * Integration profile — no overlay, no key dispatch). The current
   * focused-target type determines the answer.
   *
   * The Resolver reads this when building sources from config — every
   * cycleable source (word-cues, selector/satellite blanks, list
   * blanks, script-backed cycling blanks like volume/brightness) is
   * dropped at registration time when this returns false. Single-
   * answer sources (FluidBlankSource, TransformBlankSource, compute
   * blanks like weather/stocks) survive.
   *
   * Defaults to true when the adapter omits the method — every
   * pre-existing host has cycling.
   */
  supportsCycling?(): boolean;

  /**
   * Optional — whether the currently-focused target supports background
   * agentic rewrite (the `agentically <task> _` workflow + AgentRewrite
   * module). When this returns false, AgentRewrite refuses to arm a
   * task on the current target and skips its debounce-driven LLM tick
   * for any already-armed task whose live buffer is on this target.
   *
   * Used by chrome on Quill targets (LinkedIn share composer): Quill
   * intercepts every `execCommand` insert through a `beforeinput`
   * handler with its own Delta-model pipeline, then runs an asynchronous
   * MutationObserver + selection-observer reconcile. That reconcile
   * doesn't sync browser-set selections back into Quill's internal
   * model, so the runtime-translated cursor passed to `pushText` lands
   * the BROWSER caret in the right place but Quill ignores it for
   * subsequent typing — every keystroke after a rewrite tick goes to
   * Quill's model position (end of buffer / start of buffer / wherever
   * its delta cursor ended up). Result: the user types into the wrong
   * location after every tick, making agent-rewrite unusable on Quill.
   *
   * Inline single-substitution flows on the same target (transform-blank,
   * fluid-blank, word-cues, etc.) are unaffected because their cursor
   * is computed deterministically from the substitute span — they don't
   * round-trip through `getCursorOffset` and they only mutate one text
   * node, which Quill's Delta-model selection-shift handles correctly.
   *
   * Defaults to true when the adapter omits the method.
   *
   * Dynamic — re-evaluated per current target. A host whose support
   * varies by focused element (e.g. chrome with both contenteditable
   * and Quill editors on the same page) must check `currentTarget` at
   * call time.
   */
  supportsAgentRewrite?(): boolean;

  /**
   * Optional — describes the field the user is currently filling, for
   * fluid-blank disambiguation. See AmbientContext above for the full
   * security contract.
   *
   * Returns null when (a) the `ambient-context-mode` scalar is off
   * (default), (b) the host can't gather field metadata, or (c) the
   * current focused field is sensitive (password / CC / OTP). Hosts
   * that omit the method entirely are treated the same as returning
   * null.
   *
   * Dynamic — re-evaluated per current target, like supportsCycling.
   */
  getAmbientContext?(): AmbientContext | null;

  /**
   * Optional — when true, LLM-emitted markdown markers (`**bold**`,
   * `*italic*`, …) are written to the buffer VERBATIM instead of the
   * default strip-then-render-natively pipeline (markdown-substitute /
   * MarkdownRender). For hosts with no styling surface whose current
   * target is a markdown-native composer (Discord renders `**bold**`
   * at send), stripping would silently destroy the user's requested
   * styling with nowhere to re-render it.
   *
   * Dynamic — re-evaluated per substitution, like supportsCycling
   * (the windows host varies it by the focused app). Hosts that omit
   * the method keep the strip+render path unchanged.
   */
  markdownPassthrough?(): boolean;

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
