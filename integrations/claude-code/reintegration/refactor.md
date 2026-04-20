# Refactor: plug-and-play integration design

**Status:** Design v1.0 — ready for implementation. Every section below is locked. Deviations during implementation get proposed as amendments, not made silently.

---

## 1. Goals and non-goals

### Goals

- **Shrink the patch surface to ~8 seams.** Current reintegration has 22 discrete injection points across 3 patch files. Target: every seam maps to a semantic shape predicate (not a brittle regex on minified names).
- **Move all feature code off `globalThis` and into a normal npm package (`opencues-runtime`).** The patch becomes a thin adapter; the library is unit-testable without Claude Code.
- **Support Claude Code version bumps as ~1-hour adapter updates**, not reintegration marathons. New CC minor version → add a new adapter band targeting its exact shapes; runtime unchanged.
- **Fail safe at runtime, fail loud at install.** A broken upgrade shouldn't break the user's CC — it should refuse to install with a clear "version not supported" message. After install, runtime malfunctions must degrade to "no OpenCues features" rather than "broken editor."
- **Establish a durable HostAdapter contract** that survives without breaking changes for the foreseeable future, so future editors (not just Claude Code) can host OpenCues by implementing the same interface.

### Non-goals

- **Not rewriting cues-core.** Resolver, sources, control-blank logic stay as they are. They're already platform-agnostic.
- **Not solving CC API plugin model.** Upstreaming a plugin hook to Anthropic is a downstream goal after this refactor; we don't wait for it.
- **Not supporting arbitrary hosts in v1.** Interface is designed to allow other editors, but we only build a Claude Code adapter in the first implementation.
- **Not regressing current features.** Every reintegrated feature (through Step 37) must still work after migration. No dropping capabilities for architectural purity.
- **Not changing user-visible config.** `cues.md`, `controls.md`, `opencues.md`, folder-based discovery — all stay as they are.

---

## 2. HostAdapter interface — locked v1.0

The keystone. Everything else depends on it. This interface must survive years of Claude Code evolution without breaking changes.

### 2.1 Design principles

- **Text + integer cursor offsets are the universal surface.** No InputZone, no React props, no host-internal types leak through.
- **Sync for input state, async for I/O.** Getting/setting text is sync and cheap. Spawning processes, reading files, HTTP — async, returns Promises.
- **Capability flags over feature flags.** Adapters advertise what they support; runtime queries before using optional features. Adding a capability is non-breaking.
- **Subscribe-and-unsubscribe.** Every event subscription returns an `Unsubscribe` function. Enables clean shutdown and makes reference counting explicit.
- **No globalThis in the contract.** The adapter holds host-side state. The runtime holds the adapter reference and nothing else.
- **Fail gracefully by default.** Getters return sensible empties when things go wrong. Setters log-and-continue. Only async I/O rejects promises.
- **Source attribution on events.** Handlers know whether a text change came from user typing, our own `setText`, or the host itself. Solves most re-entrancy headaches from the current reintegration.
- **Interface versioning.** Adapters declare which interface version they implement. Runtime detects mismatch at startup.

### 2.2 Full TypeScript definition

```typescript
// ─── Modifiers ────────────────────────────────────────────────────────────

export interface Modifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

// ─── Key filters (for onKey subscription) ────────────────────────────────

export interface KeyFilter {
  /** Match only these logical keys. Omit to match all. */
  keys?: readonly string[];
  /** All listed modifiers must be present. Omit to match any modifier state. */
  requireModifiers?: readonly ('ctrl' | 'alt' | 'shift' | 'meta')[];
  /** Any listed modifier must be absent. */
  forbidModifiers?: readonly ('ctrl' | 'alt' | 'shift' | 'meta')[];
}

// ─── Events ───────────────────────────────────────────────────────────────

export interface KeyEvent {
  /** Logical key: "left", "right", "up", "down", "enter", "escape", "tab",
   *  "backspace", "delete", "home", "end", "pageup", "pagedown", or a single
   *  printable code point. Host normalises terminal escape sequences into
   *  these logical names before dispatch. */
  readonly key: string;
  readonly modifiers: Modifiers;
  /** Snapshot of text at the moment the key fired. Runtime should trust
   *  this rather than re-reading — avoids races with setText inside handlers. */
  readonly text: string;
  /** Cursor offset in code points, 0-indexed from start of text. */
  readonly cursorOffset: number;
}

export interface TextChangeEvent {
  readonly text: string;
  readonly cursorOffset: number;
  /** Previous text, for diff-style change detection. */
  readonly previousText: string;
  /** Who caused this change. Load-bearing for re-entrancy handling. */
  readonly source: 'user' | 'runtime' | 'host' | 'unknown';
}

export interface RenderContext {
  readonly text: string;
  readonly cursor: number;
  /** Host-native highlight ranges — shimmer, selection, caret, etc.
   *  Always an array (never null). Empty if adapter lacks `shimmer` capability. */
  readonly externalHighlights: readonly ExternalHighlight[];
}

export interface ExternalHighlight {
  readonly start: number;
  readonly end: number;
  /** Higher priority wins on overlap. */
  readonly priority?: number;
  readonly kind?: 'shimmer' | 'selection' | 'caret' | 'other';
}

// ─── Render directives (runtime → host) ───────────────────────────────────

export interface RenderDirectives {
  /** Full replacement for the rendered text. ANSI codes allowed. Only
   *  honoured if adapter advertises `render-override`. */
  textOverride?: string;
  /** Character ranges to render dimmed. Only honoured if `dim-ranges`. */
  dimRanges?: readonly Range[];
  /** Character range to render highlighted. Only honoured if `highlight-range`. */
  highlight?: HighlightRange;
}

export interface Range {
  readonly start: number;
  readonly end: number;
}

export interface HighlightRange extends Range {
  /** ANSI color hint (adapter may ignore). */
  readonly color?: string;
}

// ─── Process spawning ─────────────────────────────────────────────────────

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Fire-and-forget. The returned handle's `result` promise never resolves. */
  readonly detached?: boolean;
  /** Stdin data to pipe to the process. */
  readonly input?: string;
}

export interface ProcessHandle {
  readonly result: Promise<ProcessResult>;
  /** No-op if the process has already finished or was detached. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

// ─── Capability enumeration ───────────────────────────────────────────────

export type Capability =
  | 'shimmer'           // externalHighlights populated on render
  | 'render-override'   // RenderDirectives.textOverride is respected
  | 'dim-ranges'        // RenderDirectives.dimRanges is respected
  | 'highlight-range'   // RenderDirectives.highlight is respected
  | 'selection'         // getSelection returns non-null when user has a selection
  | 'spawn-process'     // spawnProcess produces a real subprocess
  | 'file-read'         // readFile resolves real file contents
  | 'file-write'        // writeFile writes real files
  | 'force-render'      // forceRender triggers a render (not a no-op)
  | 'change-source';    // TextChangeEvent.source is accurate (not always 'unknown')

// ─── Unsubscribe handle ───────────────────────────────────────────────────

export type Unsubscribe = () => void;

// ─── Log levels ───────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ─── HostAdapter ──────────────────────────────────────────────────────────

/** Current version of the HostAdapter interface. Adapters declare which
 *  version they target via `adapter.interfaceVersion`. Runtime fails loud
 *  at init if major versions differ.
 *
 *  Semantic versioning: MAJOR increments only on breaking changes.
 *  MINOR increments add optional capabilities or event fields. */
export const HOST_ADAPTER_INTERFACE_VERSION = 1;

export interface HostAdapter {
  // Interface version
  readonly interfaceVersion: number;

  // Metadata
  readonly hostName: string;
  readonly hostVersion: string;
  readonly capabilities: readonly Capability[];
  readonly cwd: string;

  // Input state — reads
  getText(): string;
  getCursorOffset(): number;
  /** User's text selection range, or null if no selection or unsupported. */
  getSelection(): Range | null;

  // Input state — writes
  setText(text: string): void;
  setCursorOffset(offset: number): void;
  /** Force a re-render cycle. Hides implementation details like zero-width
   *  char toggles. No-op if `force-render` capability absent. */
  forceRender(): void;

  // Event subscriptions — each returns an Unsubscribe
  /** Subscribe to key events. If `filter` is provided, only matching events
   *  reach the handler — avoids hot-path overhead for disinterested keys. */
  onKey(filter: KeyFilter | null, handler: (event: KeyEvent) => boolean): Unsubscribe;
  onTextChange(handler: (event: TextChangeEvent) => void): Unsubscribe;
  onRender(handler: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe;

  // I/O — all async
  spawnProcess(spec: ProcessSpec): ProcessHandle;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;

  // Diagnostics
  log(level: LogLevel, msg: string, data?: unknown): void;

  // Lifecycle
  /** Release all resources. Idempotent. After dispose, event subscriptions
   *  will deliver no more events. */
  dispose(): void;
}
```

### 2.3 Invariants and contracts

| Rule | Rationale |
|---|---|
| Getters never throw. | Runtime reads these in hot paths. Exceptions here cascade. |
| Getters return sensible defaults if unreachable: `""`, `0`, `null`. | Runtime treats empties as "no current state"; simpler than null-checking. |
| Setters never throw. Log via `adapter.log('error', ...)` on failure. | Runtime usually can't recover from "can't set text." |
| `setText` may trigger `onTextChange` synchronously OR asynchronously. | Host-dependent. Runtime must not assume order. |
| `setCursorOffset` out of range clamps silently to `[0, text.length]`. | Runtime computes offsets from text that may have since changed. |
| `forceRender` without `force-render` capability is a no-op, not an error. | Graceful degradation. |
| `onKey` handler returning `true` means "consumed" — host suppresses default. First-true-wins among multiple handlers. | Standard event dispatch semantics. |
| `onKey` with `filter` MUST pre-filter before calling the handler. | Hot-path optimisation is load-bearing for perceived latency. |
| `onRender` handler returning `null`/`undefined`/`{}` means "no directives." | Pit-of-success default. |
| `externalHighlights` is always a non-null array. Empty if `shimmer` absent. | Removes null checks from consumer code. |
| `TextChangeEvent.source` is `'unknown'` if adapter lacks `change-source` capability. | Adapter opts in only when it can actually attribute. |
| `spawnProcess` with `detached: true` returns a handle whose `result` promise never resolves. | Caller opts into fire-and-forget explicitly. |
| `readFile` returns `null` for missing files, rejects for permission/I-O errors. | Distinguishes common normal-case from unusual failure. |
| `writeFile` creates parent directories. Atomic-ish (temp + rename). | Matches ergonomic expectations. |
| `log` is synchronous. Adapter may buffer but flushes on crash/dispose. | Ordering guarantees when debugging. |
| `dispose` is idempotent. | Defensive against double-dispose in shutdown races. |
| Handlers may throw. Adapter catches, logs via `log('error', ...)`, never propagates to host. | One bad handler can't take down the host. |
| `interfaceVersion` is immutable; adapters cannot change it after construction. | Runtime caches version check. |

### 2.4 Re-entrancy and dispatch timing

Two scenarios the runtime must survive:

- **Sync dispatch:** `onKey` handler calls `adapter.setText(...)`, and `onTextChange` fires synchronously inside the setText call — before `setText` returns.
- **Async dispatch:** `onTextChange` queues to the next tick.

**Contract:** adapter picks, runtime tolerates both. Runtime's `onTextChange` handler MUST be re-entrant — it cannot rely on local state being stable across an inner `setText` call. If it needs strict ordering, it reads state via getters at the top of each handler rather than caching from a previous handler.

**Source attribution** helps here: handlers that only care about user-typed changes can filter `event.source === 'user'` and ignore their own echo. This replaces most of the defensive guards (`_pendingBlankFills`, `_pendingAutoPopulate` dedup flags) the current reintegration needed.

### 2.5 Required methods vs capability-gated behaviours

**Required for any adapter** (minimum viable host):
- Metadata: `interfaceVersion`, `hostName`, `hostVersion`, `capabilities`, `cwd`
- State reads: `getText`, `getCursorOffset`, `getSelection`
- State writes: `setText`, `setCursorOffset`, `forceRender`
- Events: `onKey`, `onTextChange`, `onRender`
- I/O: `spawnProcess`, `readFile`, `writeFile`
- Diagnostics: `log`
- Lifecycle: `dispose`

**Capability-gated behaviours:**

| Behaviour | Capability | Fallback when absent |
|---|---|---|
| `getSelection()` returning non-null | `selection` | Always returns `null` |
| `externalHighlights` populated | `shimmer` | Always `[]` |
| `RenderDirectives.textOverride` honoured | `render-override` | Ignored |
| `RenderDirectives.dimRanges` honoured | `dim-ranges` | Ignored |
| `RenderDirectives.highlight` honoured | `highlight-range` | Ignored |
| `spawnProcess` produces real subprocess | `spawn-process` | Handle rejects with "unsupported" |
| `readFile` reads real file | `file-read` | Resolves to `null` |
| `writeFile` writes real file | `file-write` | Rejects with "unsupported" |
| `forceRender` triggers render | `force-render` | No-op |
| `TextChangeEvent.source` accurate | `change-source` | Always `'unknown'` |

Runtime checks `adapter.capabilities.includes('...')` before relying on optional features.

### 2.6 Lifecycle

```typescript
// At startup — adapter is injected into the host environment
const adapter: HostAdapter = createClaudeCodeAdapter(/* host-specific args */);

// Runtime constructs, subscribes to events, loads config
const runtime = await Runtime.create(adapter, { configDir: adapter.cwd });

// Normal operation — adapter dispatches events, runtime responds

// At shutdown
await runtime.dispose();   // unsubscribes handlers, cancels pending work
adapter.dispose();         // host-side cleanup
```

**Guarantees:**
- Runtime must subscribe during `Runtime.create`. Adapters may emit events immediately afterward (e.g. an initial render).
- Handlers are delivered in subscription order.
- After `runtime.dispose()`, no runtime code will execute in response to adapter events.
- After `adapter.dispose()`, all pending I/O is cancelled, handles reject. Subsequent method calls are no-ops.

### 2.7 Reasoning for non-obvious choices

**Why `setText` is void, not Promise<void>?**
Input state mutations should feel synchronous to the runtime. Async work is absorbed internally by the adapter; runtime treats it as "intent recorded." Verification happens via getters.

**Why `TextChangeEvent.source` has an `'unknown'` value?**
Adapters that can't reliably attribute (e.g., can't distinguish a programmatic setText from user echo in some React internals) report `'unknown'`. Runtime handles `unknown` defensively — same behaviour as the current reintegration. Opt-in attribution via the `change-source` capability for adapters that can do better.

**Why `onRender` is required, not gated?**
The runtime must have a render hook to paint highlights. Without it, no visual feedback. Making it required forces every adapter to at least fire it; capabilities then gate what the handler's return value can actually deliver.

**Why no `onFocusChange` / `onActive`?**
Intentionally excluded. Claude Code input is always-focused in practice. Add later if a concrete use case emerges.

**Why `log` takes a `LogLevel` arg rather than per-level methods?**
Uniform filtering. Adapters can route by level without interface sprawl.

**Why is `cwd` on the adapter?**
Decouples runtime from Node. Runs in browser extensions, sandboxed contexts, etc. without assuming a filesystem.

**Why `spawnProcess` returns a handle instead of a bare Promise?**
`kill()` is needed. Runtime cancels in-flight scripts when the user's text has shifted past the blank being filled.

**Why does `onRender` have runtime declare directives per-render rather than push imperatively?**
Host owns render timing. Same principle as React. Runtime declares intent per render; host composes.

**Why `getSelection` on day one, even though we don't use it?**
Forward compatibility. Adding it post-v1 would be a breaking change. Runtime modules for "cycle selection" become possible later without an interface bump.

**Why `interfaceVersion` as a single number rather than semver?**
Adapters test a single comparison: `adapter.interfaceVersion === HOST_ADAPTER_INTERFACE_VERSION` (for strict match) or `>=` (forward-compat). Runtime logic stays simple. MINOR additions (new optional capabilities) don't change the number — they're additive and detected via the capabilities array.

---

## 3. Capability flags

Every optional feature gates on a capability. This section enumerates them in detail, with: purpose, fallback behaviour, and upgrade compatibility.

| Capability | Gates | Fallback when absent | Notes |
|---|---|---|---|
| `shimmer` | `RenderContext.externalHighlights` being populated | Always `[]` — runtime never gets shimmer data | Required for clean shimmer-aware highlight suppression. Can be polyfilled by a future host from DOM-like segment inspection. |
| `render-override` | `RenderDirectives.textOverride` being applied | Host ignores the field, renders original text | Required for ANSI-colored word highlights. Without it, runtime is navigation-only. |
| `dim-ranges` | `RenderDirectives.dimRanges` being applied | Field ignored | Number-dimming, span-dimming both depend on this. |
| `highlight-range` | `RenderDirectives.highlight` being applied | Field ignored | Keyword highlight color depends on this. Adapter may implement as text override if finer control isn't available. |
| `selection` | `getSelection()` returning non-null | Always returns null | Future: selection-based cycling. Not used today. |
| `spawn-process` | `spawnProcess()` producing a subprocess | Handle result rejects with `AdapterUnsupportedError` | Required for all script-backed controls (volume, brightness, weather, stocks, hn, prompt, answer, config). |
| `file-read` | `readFile()` reading filesystem | Resolves to `null` | Required for config loading (cues.md etc.). Runtime can't start without it. |
| `file-write` | `writeFile()` writing filesystem | Rejects with `AdapterUnsupportedError` | Required for statusline export. Runtime degrades to "no statusline" without it. |
| `force-render` | `forceRender()` triggering render | No-op | Required for navigation (which needs a re-render without text change). Without it, highlights update only on next real text change. |
| `change-source` | `TextChangeEvent.source` being accurate | Always `'unknown'` | Enables cleaner re-entrancy handling. Runtime works without it but with more defensive guards. |

**Minimum viable host** (runtime starts but is crippled): `file-read`.  
**Minimum useful host** (navigation + tips): `file-read`, `render-override`, `dim-ranges`, `highlight-range`, `force-render`.  
**Full host** (everything): all ten capabilities.

The Claude Code adapter for v2.1.110 implements all ten.

### 3.1 Capability detection at Runtime.create

```typescript
async function create(adapter: HostAdapter, config: RuntimeConfig): Promise<Runtime> {
  if (adapter.interfaceVersion !== HOST_ADAPTER_INTERFACE_VERSION) {
    throw new Error(
      `HostAdapter interface version mismatch: runtime expects ` +
      `${HOST_ADAPTER_INTERFACE_VERSION}, adapter reports ${adapter.interfaceVersion}`
    );
  }
  if (!adapter.capabilities.includes('file-read')) {
    throw new Error(`HostAdapter missing required capability: file-read`);
  }
  adapter.log('info', `OpenCues runtime starting`, {
    host: adapter.hostName,
    hostVersion: adapter.hostVersion,
    capabilities: adapter.capabilities,
  });
  // ...
}
```

Missing required capability = hard fail. Missing optional capability = degrade silently (runtime feature list in the debug log reflects what's available).

---

## 4. Seam catalog

The current patches inject at ~22 anchor points. Semantically these collapse to **8 seams**. Each seam is one AST shape predicate in the new architecture.

### 4.1 Seam enumeration

| # | Seam | Purpose | Current anchor(s) | AST shape |
|---|---|---|---|---|
| S1 | **KeyDispatcher** | Function that handles terminal key events (switch on `key`). Inject key handlers. | `/function ([$\w]+)\(([$\w]+),([$\w]+)\)\{switch\(\2\.key\)\{case"escape":/` | `FunctionDeclaration` where body starts with `SwitchStatement` on param's `.key` property, with a `"escape"` case |
| S2 | **InputStateHandler** | React component that owns input state. Has `{value, onChange, externalOffset, onOffsetChange}` destructured from props. Inject state-sync IIFE. | `/function ([$\w]+)\(\{value:[$\w]+,onChange:[$\w]+,[^}]+externalOffset:[$\w]+,onOffsetChange:[$\w]+[^}]+\}\)/` | `FunctionDeclaration` or `FunctionExpression` with first param `ObjectPattern` having keys `{value, onChange, externalOffset, onOffsetChange}` |
| S3 | **RenderedValueReturn** | The `return {handleKeyDown, renderedValue: ...}` object inside the input handler. Inject render wrapping and IIFE sibling. | `/return\{handleKeyDown:([$\w]+),renderedValue:/` | `ReturnStatement` whose argument is `ObjectExpression` with properties `handleKeyDown` and `renderedValue` |
| S4 | **InputZoneClass** | The `X.fromText(text, cols, offset)` static method call. Extract class reference for cursor-mutation helpers. | `/([$\w]+)=([$\w]+)\.fromText\(([$\w]+),([$\w]+),([$\w]+)\)/` | `AssignmentExpression` or `VariableDeclarator` whose init is `CallExpression` to a `.fromText` member |
| S5 | **SegmentRenderer** | The render-side function that destructures `{text, highlights}` from its first arg. Inject external-highlight export. | `/function [$\w]+\([$\w]+\)\{let [$\w]+=s\(\d+\),\{text:[$\w]+,highlights:([$\w]+)\}=[$\w]+,[$\w]+;/` | `FunctionDeclaration` with first param, body starts with `VariableDeclaration` containing `ObjectPattern` on param with keys `{text, highlights}` |
| S6 | **StatusLineRefreshDebounce** | The debounced callback that re-runs the statusline. Inject a reference export so runtime can trigger refreshes imperatively. | `/([$\w]+)=Wn\(\(\)=>\(\w+\)\(([A-Z])\),300\)/` OR `useCallback` variant | `VariableDeclarator` whose init is `CallExpression` to a debounce wrapper (name varies) with a 300ms timeout and a refetch closure |
| S7 | **RequireFunction** | The `createRequire(import.meta.url)` setup in ESM output. Extract the `require` function reference for child_process/fs access. | `/var [$\w]+=[$\w]+\(import\.meta\.url\)/` (approximate) | `VariableDeclaration` whose init calls `createRequire` or its toESM-wrapped variant |
| S8 | **RuntimeInitHook** | A bootstrap point where we can run our own startup code once at module load. Today this is inside the input-handler IIFE; ideally a dedicated early-exec seam. | None today (piggybacks on S2) | `Program.body` — find the last `VariableDeclaration` before the first `FunctionDeclaration` in the top-level scope; insert a `globalThis.__oc = ...` assignment after it |

### 4.2 Seam consolidation from the current 22 anchors

| Current anchor group | Collapses to |
|---|---|
| "Key dispatcher entry", "Escape case", "Raw sequence fallback" | **S1** |
| "Input handler location" (×3, different extractions), "Return statement" | **S2** + **S3** |
| "Cursor state export location" | Same as **S2** — no new seam; runtime reads state via adapter |
| "RenderedValue 3/4/5-param", "Rainbow wrapping" | **S3** (one seam, handles all signatures via AST) |
| "Highlight visual rendering IIFE" | **S3** (injection point for runtime's render-override directive) |
| "External highlights injection" | **S5** |
| "Clear-on-typing IIFE (main)", "Invisible char stripping", "Parent value storage" | Subsumed into runtime logic (not seams) |
| "Cues-core initialisation" | **S8** |
| "Cycle alternatives function" | Runtime module (not seam) |
| "Status line refresh trigger" | **S6** |
| "Control overrides JSON" | Runtime config (not seam) |

Net: 22 → 8. Each of the 8 has a shape predicate in `seams.ts`; the patch's only job is to run those predicates against the AST, extract bindings, and emit a ~10-line adapter shim per seam that wires the binding into `globalThis.__oc`.

### 4.3 Shape predicates (sketch)

One file, one function per seam:

```typescript
// seams.ts
import { parse, walk, Node } from 'acorn';

export interface SeamMatch {
  readonly node: Node;
  readonly bindings: Readonly<Record<string, string>>;
}

export function findKeyDispatcher(ast: Node): SeamMatch | null { /* ... */ }
export function findInputStateHandler(ast: Node): SeamMatch | null { /* ... */ }
export function findRenderedValueReturn(ast: Node): SeamMatch | null { /* ... */ }
export function findInputZoneClass(ast: Node): SeamMatch | null { /* ... */ }
export function findSegmentRenderer(ast: Node): SeamMatch | null { /* ... */ }
export function findStatusLineRefresh(ast: Node): SeamMatch | null { /* ... */ }
export function findRequireFunction(ast: Node): SeamMatch | null { /* ... */ }
export function findRuntimeInitHook(ast: Node): SeamMatch | null { /* ... */ }
```

Each predicate:
1. Walks the AST using acorn-walk.
2. Matches node shape against the seam's semantic pattern.
3. Returns the node + extracted identifier names.
4. Returns null if no match (caller throws at apply time → fail-loud).

Regex fallback: each predicate internally may try a regex first for speed, fall back to AST walk if regex misses. AST walk is authoritative.

### 4.4 Version bands

For Claude Code minor version bumps that change shape (not just names), we ship a new adapter:

```
packages/opencues-runtime/adapters/claude-code/
├── v2.1/
│   ├── seams.ts          # shape predicates for v2.1.x
│   └── adapter.ts        # adapter assembly
├── v2.2/                  # added when v2.2 ships
│   ├── seams.ts
│   └── adapter.ts
└── shared/               # version-agnostic helpers
    └── cursor-helpers.ts
```

Version detection: read CC's `package.json` in the install, match `<MAJOR>.<MINOR>`, route to matching adapter. Unknown version → fail install with "unsupported CC version; add an adapter at `claude-code/v<N>.<M>/`."

---

## 5. Runtime architecture

### 5.1 Module layout

```
packages/opencues-runtime/src/
├── index.ts              # public API: create(), Runtime class
├── runtime.ts            # Runtime orchestrator
├── modules/
│   ├── navigation.ts     # Ctrl+Alt+Left/Right navigation
│   ├── cycling.ts        # Ctrl+Alt+Up/Down alt/step/selector/satellite
│   ├── blank-fill.ts     # resolver-driven auto-populate
│   ├── dim-render.ts     # RenderDirectives calc (highlight, dim, span)
│   ├── tts.ts            # text-to-speech spawn
│   ├── statusline.ts     # writeStatusFile payload
│   └── config-loader.ts  # cues.md / controls.md / opencues.md
├── state/
│   ├── highlight-state.ts   # current highlight position, wordIndex
│   ├── dyn-defs.ts          # WordDef entries + span tracking
│   ├── consume-all.ts       # consume-all alts state
│   └── dismissed-blanks.ts  # dismissed blank positions
└── adapter.ts            # re-exports HostAdapter interface
```

### 5.2 Module responsibilities

| Module | Owns | Depends on |
|---|---|---|
| `Runtime` | Bootstrap; wires modules; holds adapter | All modules |
| `Navigation` | `_hlState.wordIndex` transitions; emits cursor moves | `HighlightState`, adapter |
| `Cycling` | Alt/step/selector/satellite cycling logic | `HighlightState`, `DynDefs`, cues-core resolver, adapter |
| `BlankFill` | Blank detection, auto-populate via resolver, pending-fill consumer | `DynDefs`, cues-core resolver, `ConsumeAll`, `DismissedBlanks`, adapter |
| `DimRender` | On every `onRender`, compute `RenderDirectives` from current state | `HighlightState`, `DynDefs`, `ConsumeAll`, adapter |
| `TTS` | Spawn speak.sh on tip highlight | Adapter |
| `Statusline` | On state change, serialise and write `_hlExport` JSON | `HighlightState`, `DynDefs`, adapter |
| `ConfigLoader` | Parse cues/controls/opencues configs at startup + hot-reload | cues-core parsers, adapter |

### 5.3 Inter-module communication

**Pattern: direct method calls, no global event bus.**

Modules hold references to each other via the `Runtime` orchestrator. The orchestrator is the only thing that knows the full module graph.

```typescript
class Runtime {
  private navigation: Navigation;
  private cycling: Cycling;
  private blankFill: BlankFill;
  private dimRender: DimRender;
  // etc.

  constructor(private adapter: HostAdapter, private config: RuntimeConfig) {
    // State
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const consumeAll = new ConsumeAllState();
    const dismissedBlanks = new DismissedBlanks();

    // Modules
    this.navigation = new Navigation(adapter, hlState, dynDefs);
    this.cycling = new Cycling(adapter, hlState, dynDefs, consumeAll, /* resolver */);
    this.blankFill = new BlankFill(adapter, dynDefs, consumeAll, dismissedBlanks, /* resolver */);
    this.dimRender = new DimRender(hlState, dynDefs, consumeAll);
    // etc.

    // Subscriptions
    adapter.onKey({ requireModifiers: ['ctrl', 'alt'] }, e => this.onKey(e));
    adapter.onTextChange(e => this.onTextChange(e));
    adapter.onRender(ctx => this.dimRender.compute(ctx));
  }

  private onKey(e: KeyEvent): boolean {
    if (e.key === 'left' || e.key === 'right') return this.navigation.onArrow(e);
    if (e.key === 'up' || e.key === 'down') return this.cycling.onUpDown(e);
    return false;
  }

  private onTextChange(e: TextChangeEvent): void {
    if (e.source === 'user' || e.source === 'unknown') {
      this.blankFill.onTextChange(e);
      // dyndef invalidation, span-validity checks, etc.
    }
  }
}
```

No globals. No `globalThis._dynDefs`. All state is instance-local and testable in isolation.

### 5.4 State boundaries

Each state class owns its invariants. Other modules read/write via methods, not fields:

```typescript
class HighlightState {
  private _wordIndex: number | null = null;
  private _active = false;
  private _text = '';

  get wordIndex(): number | null { return this._wordIndex; }
  get active(): boolean { return this._active; }

  activate(wordIndex: number, text: string): void {
    this._active = true;
    this._wordIndex = wordIndex;
    this._text = text;
  }
  deactivate(): void { this._active = false; }
  // etc.
}
```

Tests mock state classes directly — each is ~50 lines.

---

## 6. Config surface

### 6.1 Where config comes from

Runtime reads configs via adapter:

```typescript
class ConfigLoader {
  constructor(private adapter: HostAdapter) {}

  async loadAll(): Promise<LoadedConfig> {
    const cwd = this.adapter.cwd;
    const [cues, controls, openCues, blanks] = await Promise.all([
      this.adapter.readFile(`${cwd}/cues.md`),
      this.adapter.readFile(`${cwd}/controls.md`),
      this.adapter.readFile(`${cwd}/opencues.md`),
      this.adapter.readFile(`${cwd}/blanks.md`),
    ]);
    // Parse via cues-core parsers (pure functions, no I/O)
    return {
      cues: cues ? parseCuesMd(cues) : null,
      controls: controls ? parseCuesMd(controls) : null,
      openCues: openCues ? parseOpenCuesMd(openCues) : null,
      blanks: blanks ? parseCuesMd(blanks) : null,
      folderControls: await this.discoverFolderConfigs(),
    };
  }

  async discoverFolderConfigs(): Promise<FolderConfig[]> {
    // Walk cwd/controls/*, cwd/cues/* via adapter.readFile
    // No direct fs access
  }
}
```

Key points:
- **All filesystem access goes through the adapter.** Runtime never imports `fs`.
- **Parsing is pure.** `parseCuesMd`, `parseOpenCuesMd` are cues-core functions. Testable without I/O.
- **Folder discovery** (walking `controls/*/cue.md`) needs a `readDir` primitive — **TBD for interface v2** if the use case grows; for v1, the adapter emits a pre-walked list or runtime reads a manifest file.

### 6.2 Hot reload

ConfigLoader exposes a `reload()` method. Runtime calls it on a debounced text-change trigger (currently every 2s in `dynamicHighlight.ts` baseline).

```typescript
class ConfigLoader {
  private lastLoadAt = 0;
  private loadedConfig: LoadedConfig | null = null;

  async maybeReload(): Promise<LoadedConfig> {
    if (Date.now() - this.lastLoadAt > 2000) {
      this.loadedConfig = await this.loadAll();
      this.lastLoadAt = Date.now();
    }
    return this.loadedConfig!;
  }
}
```

Modules that consume config subscribe to `loader.onReload(handler)` and re-register their dependencies.

### 6.3 `opencues.md` write-back

Selector/satellite cycling writes back to `opencues.md` to persist the setting change. Today done via `script set setting value`. In the new arch:

- Option A: Runtime calls `adapter.spawnProcess({command: "bash", args: [scriptPath, "set", setting, value]})`. Script writes to disk. Same as today.
- Option B: Runtime calls `adapter.writeFile("opencues.md", newContent)` directly after computing the updated frontmatter.

Decision: **Option A for v1.** Preserves the current script contract. Runtime doesn't own opencues.md format. Future: if we want to remove the script dependency, migrate to Option B with a cues-core YAML writer.

---

## 7. I/O boundary

### 7.1 What runtime never touches directly

- **Filesystem:** all reads/writes through adapter.
- **HTTP:** runtime holds a `HttpAdapter` (separate from HostAdapter) — same interface as today's `NodeHttpAdapter`. HostAdapter doesn't carry HTTP.
- **Process spawning:** via `adapter.spawnProcess`.
- **Stdin/stdout:** runtime doesn't print. Diagnostics go through `adapter.log`.
- **Timers:** `setTimeout`/`setInterval` are allowed (cross-platform, no adapter needed).

### 7.2 HTTP adapter split

The runtime makes LLM calls. We keep the existing `HttpAdapter` interface from cues-core (it's already platform-neutral). Runtime construction takes both:

```typescript
const runtime = await Runtime.create(adapter, {
  httpAdapter: new NodeHttpAdapter({ maxSockets: 2, timeout: 30000 }),
  // or in tests:
  // httpAdapter: new MockHttpAdapter(),
});
```

### 7.3 TTS ownership

TTS is a process spawn. `TTS` module calls `adapter.spawnProcess(speakCommand)` with `detached: true`. No special handling. Cancellation via `ProcessHandle.kill()`.

### 7.4 Statusline file path

Runtime writes `/tmp/opencues-highlight-state-${pid}.json` — except runtime can't know PID in an adapter-agnostic way. Adapter exposes PID? Too Node-specific.

**Decision:** runtime config carries a `statusFilePathFn: (pid) => string` (or a fixed path). Adapter exposes `process.pid` via a capability extension if needed. For v1, the Claude Code adapter hardcodes the path pattern.

---

## 8. Error model

### 8.1 Failure modes and responses

| Failure | Response |
|---|---|
| Adapter interface version mismatch | `Runtime.create` throws. User sees clear error at startup. |
| Missing required capability (`file-read`) | `Runtime.create` throws. |
| Missing optional capability | Log `info`, degrade runtime (feature disabled). |
| Adapter method throws synchronously | Adapter's fault; runtime catches at call site, logs `error`, continues. |
| Handler throws | Adapter catches per invariant, logs, continues. |
| Async I/O rejects (spawn, readFile, writeFile) | Runtime handles: retry if transient, log and continue if fatal. |
| Resolver throws | Log, skip this resolution cycle, keep last-known state. |
| Config file unparseable | Log `warn` with line number, skip that file, use defaults. |
| Patch anchor missing at install | Installer throws with diagnostic. User can't proceed. |
| Patch succeeds but runtime fails to init (e.g., adapter bug) | Runtime enters "inactive" mode. `adapter.log('error', 'runtime failed to init')`. CC works unpatched. Statusline shows "opencues: inactive (see log)". |

### 8.2 Adapter errors exposed to runtime

```typescript
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
    (this as any).cause = cause;
  }
}
```

Runtime catches `AdapterUnsupportedError` and logs; catches `AdapterIOError` and retries-or-gives-up based on the op.

### 8.3 Installer assertions

Carries forward Step 37d's `assertInjected` pattern. Each seam predicate returns null for "not found" → installer aggregates missing seams → fails with:

```
OpenCues installer: FAILED to find 2 critical seams in cli.js:
  - S5 (SegmentRenderer) — expected shape not matched
  - S6 (StatusLineRefreshDebounce) — expected shape not matched
Likely cause: Claude Code version v2.2.0 unsupported by adapter v2.1.x.
Add an adapter at packages/opencues-runtime/adapters/claude-code/v2.2/ or
pin claude-cues to v2.1.110 until support ships.
```

No partial install. Either all critical seams found or nothing is written.

---

## 9. Test strategy

### 9.1 Three layers

**Layer 1: Unit tests (fastest, 90% coverage target).**
- Each runtime module tested against a `MockHostAdapter`.
- Mock adapter is a full `HostAdapter` implementation over an in-memory text buffer. Exposes `fireKey(event)`, `pushText(text)`, `fireRender()` for driving scenarios.
- Assertions on adapter method calls (`expect(adapter.setText).toHaveBeenCalledWith(...)`).
- No CC, no filesystem (MemFs), no network.

**Layer 2: Integration tests.**
- `TestAdapter` implements `HostAdapter` against a fake Ink text-input component. Renders to a string buffer. Drives keystrokes through Ink's test tools.
- Runs the full runtime — config loaded from fixtures, resolver stubbed with deterministic LLM responses.
- Tests the runtime ↔ adapter contract for timing, re-entrancy, async flows.

**Layer 3: End-to-end (slowest, smallest).**
- `claude-cues` actual install + `opencues-auto` harness (already exists at `~/.claude/opencues-auto`).
- Verifies the CC adapter's seam finding, injection correctness, user-visible behaviour.
- Catches CC-specific regressions that the MockHostAdapter can't.
- Run in CI against a pinned CC version.

### 9.2 Adapter conformance suite

One test suite, runs against ANY adapter implementation:

```typescript
// adapter-conformance.test.ts
import { adapterConformanceSuite } from 'opencues-runtime/testing';

describe('ClaudeCodeAdapter v2.1', () => {
  adapterConformanceSuite(() => createClaudeCodeAdapterV21());
});

describe('MockAdapter', () => {
  adapterConformanceSuite(() => new MockAdapter());
});
```

The suite tests:
- Every invariant from §2.3.
- Every capability's fallback behaviour.
- Lifecycle (dispose idempotency, post-dispose method no-ops).
- Re-entrancy (setText inside onTextChange handler doesn't loop).

Any adapter that passes the suite can host the runtime.

### 9.3 Seam-predicate tests

Each seam predicate tested against:
- A sample snippet of current CC's cli.js (fixture).
- Synthetic variants with renamed identifiers (must still match).
- Synthetic variants with structural changes (must NOT match).

Catches minifier-driven drift before a user sees it.

---

## 10. Migration plan

### 10.1 Constraints

- Current reintegration is in production (user uses claude-cues daily).
- Steps 0–37 must continue to work throughout the migration.
- Bugs found mid-migration need a rollback path.

### 10.2 Phasing

**Phase 0: Scaffold (no runtime behaviour change).**
- Create `packages/opencues-runtime/` with the interface types and empty `Runtime` class.
- Create `packages/opencues-runtime/adapters/claude-code/v2.1/` with seam predicates and an empty adapter.
- Create mock adapter + conformance test harness.
- No patch changes yet. Current reintegration still owns all behaviour.

**Phase 1: First module ported (navigation).**
- Implement `Navigation` module in runtime.
- Implement the minimum adapter: getText, setText, onKey (arrow keys), onRender (for cursor-sync).
- Installer gains a `--use-v2` flag. When set, replaces the current navigation injection with a 3-line hook that calls `globalThis.__oc.onKey(...)`.
- `--use-v2` is opt-in; default is the current patch.

**Phase 2 through N: one module per phase.**
- Cycling, then DimRender, then BlankFill, then TTS, then Statusline.
- Each phase: port the module, grow the adapter, extend `--use-v2` to cover that module's injection site.
- Old and new coexist: `--use-v2` flag controls which code runs per module.

**Phase N+1: Flag flip.**
- Default `--use-v2` to true. Old patches kept as fallback.
- One release cycle of real-world use.

**Phase N+2: Remove old patches.**
- Delete `integrations/claude-code/tweakcc/src/patches/wordHighlight.ts` (the big one).
- Keep `cursorStateExport.ts` etc. if independent.

### 10.3 Feature flag mechanics

`tweakcc` config gains `opencuesRuntime: 'v1' | 'v2'`. At apply time, the patch branches on that flag:

```typescript
if (config.opencuesRuntime === 'v2') {
  // Apply v2 seam-based injections
  applyV2Seams(ast, seamMatchers);
} else {
  // Apply legacy v1 patches (current reintegration)
  applyV1Patches(ast);
}
```

Per-module flag is possible but probably overkill. Single boolean per install.

### 10.4 Rollback

Each phase's patch work is reversible. `tweakcc config set opencuesRuntime v1 && tweakcc --apply` reverts to the legacy path. The runtime package stays installed (harmless; v1 ignores it).

---

## 11. Packaging and distribution

### 11.1 Repo layout

```
opencues/
├── packages/
│   ├── cues-core/              # unchanged
│   └── opencues-runtime/       # new
│       ├── src/
│       ├── adapters/
│       │   └── claude-code/
│       │       ├── v2.1/
│       │       ├── v2.2/
│       │       └── shared/
│       └── testing/            # mock adapter + conformance suite
└── integrations/claude-code/
    └── tweakcc/
        └── src/patches/
            └── opencuesRuntime.ts  # new thin patch (replaces wordHighlight.ts)
```

### 11.2 NPM publishing

- `cues-core` — stays as-is, internal.
- `opencues-runtime` — published to npm (public or private registry). Versioned semver.
- Adapters ship bundled with the runtime package (not separate packages) — they're tightly coupled and version-locked.

### 11.3 Version compatibility matrix

| opencues-runtime | HostAdapter interface | Supported CC versions |
|---|---|---|
| 1.0.x | 1 | 2.1.x |
| 1.1.x | 1 (additive) | 2.1.x + 2.2.x |
| 2.0.x | 2 (breaking) | 2.2.x + future |

Matrix lives in the package README. Installer checks CC version against this matrix before proceeding.

### 11.4 Install flow

User-facing:
```bash
~/opencues/integrations/claude-code/patches/setup.sh
```

Under the hood:
1. Clone/update tweakcc.
2. Build cues-core and opencues-runtime, install to `~/.claude/node_modules/`.
3. Detect CC version in claude-cues install.
4. Route to matching adapter (e.g. `adapters/claude-code/v2.1/`).
5. Run tweakcc with config pointing to that adapter.
6. Tweakcc parses cli.js AST, runs seam predicates, fails loudly if any critical seam is missing.
7. Injects the thin adapter-bootstrap patch (~50 lines).
8. Repacks cli.js.

If any step fails, the install is atomic — cli.js is restored from backup and error reported.

---

## Locked — ready for implementation

All 11 sections are at v1.0. Changes during implementation become amendments to this document, not silent deviations.

**Implementation order:**
1. Scaffold (`packages/opencues-runtime/`, interface types, mock adapter, conformance suite). No behaviour change.
2. `Navigation` module + minimal Claude Code adapter. `--use-v2` flag opt-in.
3. Subsequent modules in order: Cycling → DimRender → BlankFill → Statusline → TTS.
4. Flag flip after real-world use.
5. Remove legacy patches.

---

## Resume here (for a fresh session)

If a session is picking up this refactor mid-flight, read this section first.

### What this is

The plug-and-play rewrite of OpenCues' Claude Code integration. Replaces the 22-seam parasitic patch (reintegration Steps 0-37) with a thin adapter + fat runtime library. Spec above is locked v1.0 — do not deviate without updating the document.

### How to resume

Standard resume prompt:

> *"Read `integrations/claude-code/reintegration/refactor.md` and execute Phase N. Commit between phases. Tell me when each phase is done and wait for me to verify before moving on."*

Replace `Phase N` with the current target (e.g. "Phase 0 and Phase 1").

### Where things live

- **Spec (this file):** `integrations/claude-code/reintegration/refactor.md`
- **Reintegration history (steps.md):** `integrations/claude-code/reintegration/steps.md` — the 37-step log of how the current (v1) patch came to be. Reference when you need to know what a feature does or why.
- **Current patch (v1, to be replaced):** `integrations/claude-code/tweakcc/src/patches/wordHighlight.ts` — ~2100-line template literal. Contains the behaviour that the runtime must match.
- **cues-core (stays as-is):** `packages/cues-core/` — resolver, sources, parsers. Runtime depends on it.
- **Target locations for v2 code** (create these during Phase 0):
  - `packages/opencues-runtime/` — the runtime library.
  - `packages/opencues-runtime/adapters/claude-code/v2.1/` — the v2.1.x Claude Code adapter.
  - `packages/opencues-runtime/testing/` — MockHostAdapter + conformance suite.

### Dev workflow

- **Build runtime:** `cd packages/opencues-runtime && npm run build` (scaffold will add this).
- **Install to Claude user path:** `cp -r packages/opencues-runtime/dist/* ~/.claude/node_modules/opencues-runtime/` (after creating the target dir). Mirrors the existing cues-core pattern.
- **Build + apply tweakcc:** `cd integrations/claude-code/tweakcc && npm run build:dev && CLI_JS=$(find ~/claude-code-cues -name "cli.js" | head -1) && TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply`
- **Test:** User restarts `claude-cues`, exercises features, checks `/tmp/opencues-highlight-state-<pid>.json` for `_debug` fields. For v2 runtime, expect new debug fields reflecting runtime module state.

### Commit conventions

- **Phase commits:** `feat: Phase <N> — <summary>` with a body describing what shipped and what rolled back (if any).
- **Fixes during a phase:** normal `fix:` or `refactor:` commits. Fold into the phase commit via amend if unpushed, otherwise separate.
- **Push after each phase completes** (user verifies before next phase).
- **Design amendments:** if a discovery forces a spec change, commit the refactor.md edit separately (`docs: refactor.md — <section> amendment`) BEFORE the code change, so history shows the design shift first.

### Phase 0 checklist (scaffold, ~1 day)

- [ ] `packages/opencues-runtime/package.json` — name, version 0.1.0, dependencies (cues-core local, acorn for seam parsing).
- [ ] `packages/opencues-runtime/tsconfig.json` — strict TS, emit to `dist/`.
- [ ] `packages/opencues-runtime/src/index.ts` — re-export public API.
- [ ] `packages/opencues-runtime/src/adapter.ts` — the full HostAdapter interface (copy from spec section 2.2 verbatim — types only, no impl).
- [ ] `packages/opencues-runtime/src/runtime.ts` — empty Runtime class with `create()` factory, `dispose()`. Only validates interface version + required capabilities.
- [ ] `packages/opencues-runtime/src/state/` — stub state classes (HighlightState, DynDefs, ConsumeAllState, DismissedBlanks). No logic yet; just fields and getters.
- [ ] `packages/opencues-runtime/src/modules/` — empty module files (navigation.ts, cycling.ts, blank-fill.ts, dim-render.ts, tts.ts, statusline.ts, config-loader.ts). Each exports a class with a constructor taking `adapter: HostAdapter`.
- [ ] `packages/opencues-runtime/testing/mock-adapter.ts` — MockHostAdapter implementing all methods over an in-memory text buffer. Exposes `fireKey`, `pushText`, `fireRender` helpers.
- [ ] `packages/opencues-runtime/testing/conformance.ts` — conformance test suite (exports a function that takes an adapter factory and asserts all invariants from §2.3). Uses vitest.
- [ ] Add a single vitest test at `packages/opencues-runtime/src/runtime.test.ts` that runs conformance against MockAdapter and verifies Runtime.create() succeeds.
- [ ] Verify build + test pass: `npm run build && npm test` in the package dir.

**No tweakcc changes in Phase 0.** No cli.js touched. Current reintegration still owns all runtime behaviour.

Commit message: `feat: Phase 0 — opencues-runtime scaffold (HostAdapter types, MockAdapter, conformance suite)`.

### Phase 1 checklist (navigation module, ~2 days)

- [ ] Extract AST seam predicates for S1 (KeyDispatcher) and S2 (InputStateHandler) into `packages/opencues-runtime/adapters/claude-code/v2.1/seams.ts`. Use acorn. Reference the current regexes in `wordHighlight.ts:160-234` for what shapes to match.
- [ ] Build the v2.1 adapter at `packages/opencues-runtime/adapters/claude-code/v2.1/adapter.ts` — implements HostAdapter methods minimally: enough to support navigation only (getText, setText, setCursorOffset, forceRender via ZWS toggle, onKey with filter for Ctrl+Alt arrows, onRender for dim/highlight, log).
- [ ] Implement `Navigation` module at `packages/opencues-runtime/src/modules/navigation.ts`. Port the current filter + arrow-handling logic from `wordHighlight.ts` (the `filterCode` and key handlers near line 461 + 475). Use `adapter.onKey({requireModifiers: ['ctrl', 'alt'], keys: ['left','right']}, ...)`.
- [ ] Unit tests at `src/modules/navigation.test.ts` against MockHostAdapter: simulate typing, fire key events, assert expected `setText` calls.
- [ ] Add `opencuesRuntime: 'v1' | 'v2'` config option to tweakcc's config schema. Default `'v1'`.
- [ ] Add a thin patch at `integrations/claude-code/tweakcc/src/patches/opencuesRuntime.ts` that, when `opencuesRuntime === 'v2'`:
   1. Parses cli.js AST via acorn.
   2. Runs the v2.1 adapter's seam predicates.
   3. Fails loud if any critical seam is missing (reuse the `assertInjected` pattern from Step 37d).
   4. Injects a bootstrap that loads `opencues-runtime` and the v2.1 adapter, then does `Runtime.create(adapter)`.
- [ ] End-to-end: with `opencuesRuntime: 'v2'`, applying to `claude-cues` + restart → Ctrl+Alt+Left/Right navigates words identically to v1. v1 must still work with the flag set to `'v1'`.

Commit message: `feat: Phase 1 — Navigation module + v2.1 Claude Code adapter (S1, S2 seams)`.

### Known constraints when resuming

- Node 22 in the dev environment. Use `npm` (not `pnpm`).
- Tweakcc is a vendored npm package at `integrations/claude-code/tweakcc/`. It has its own `package.json` and builds via `npm run build:dev`.
- `~/.claude/node_modules/` is the install location that CC's patched cli.js reads from. After any cues-core or opencues-runtime rebuild, copy `dist/*` into this path.
- `claude-cues` is at `~/claude-code-cues` — this is the patched install, don't confuse with the unpatched `claude` at `~/.local/bin/claude`.
- Do not touch the native `claude` install. Only `claude-cues`.
- Anchor-count assertions from Step 37d live in `writeWordHighlight`. New seam predicates in Phase 1+ should emit similar assertions (reuse the pattern).

### If something blocks

- Spec assumption turns out wrong → stop, update the relevant section in refactor.md (and commit the doc change first), then proceed.
- CC version on the dev machine doesn't match v2.1.x → work against whatever's there; adapter band should match real CC version. Update the matrix in §11.3.
- Resolver tests need real LLM → use a mock HTTP adapter in the conformance suite; real-LLM tests only in E2E layer (§9.1 Layer 3).
