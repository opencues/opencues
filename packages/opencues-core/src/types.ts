/**
 * opencues-core/types.ts
 *
 * Core interfaces for OpenCues.
 * These are pure TypeScript types with no I/O or platform dependencies.
 */

/**
 * Result from a cue source for a single word.
 */
export interface CueResult {
  /** Word position in the text (0-indexed) */
  wordIndex: number;

  /** The actual word at this position */
  word: string;

  /** Alternative words/phrases. Original word should be at index 0 */
  alternatives: string[];

  /** Cue-tip text for this word (displayed in secondary display) */
  cueTip?: string;

  /** Per-alternative cue-tips (keyed by alternative word) */
  altCueTips?: Record<string, string>;

  /** Indices of other words that should cycle together (e.g., "boy" and "he") */
  linked?: number[];

  /** Source identifier (e.g., 'tips', 'grammar', 'math', 'factual') */
  source: string;

  /** Priority for merging (higher wins) */
  priority: number;

  /** For multi-word alternatives: start index of span */
  spanStart?: number;

  /** For multi-word alternatives: end index of span (exclusive) */
  spanEnd?: number;

  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Context provided to cue sources for analysis.
 */
export interface CueContext {
  /** Full input text */
  text: string;

  /** Text split into words */
  words: string[];

  /**
   * Optional "as the user typed it" view of the buffer. Each word
   * that has been altered by an agent (DynDef with currentIndex > 0)
   * is reverted to its `originalWord`. Used by the transform-blank
   * source to detect TASK_* triggers against what the user TYPED,
   * not what the agent rendered. When undefined, sources fall back
   * to `text`. Same-word-count guarantee is NOT promised — multi-
   * word agent edits collapse back to single words here.
   */
  asTypedText?: string;

  /**
   * Optional "rich-text" view of the buffer with markdown markers
   * re-injected at the positions the runtime knows are styled (from
   * MarkdownRender's cache). Used by TransformBlank EXTRACT so the
   * LLM sees prior bold/italic/strike markers on the next pass and
   * can preserve them ("text is already bold, now also make it caps"
   * → output keeps `**` markers around the now-uppercased word). When
   * undefined, sources fall back to `text` (the unmarked visible
   * buffer) — equivalent to "no prior styling to preserve."
   */
  richText?: string;

  /** Domain hint (e.g., 'claude-code', 'medical', 'legal') */
  domain?: string;

  /**
   * Character offset into `text` where the user's caret currently
   * sits. Sources can inject a `[CURSOR]` sentinel here so the LLM
   * can anchor positional instructions ("insert X here _", "add a
   * comma _") at the user's actual position rather than guessing.
   *
   * Omitted / negative when the host doesn't know the cursor
   * (rare — agentic harness's bare-injection mode, headless tests).
   * Sources MUST treat undefined / -1 as "no cursor info" and fall
   * back to cursor-blind behaviour (the prompt has no sentinel,
   * the strip pass is a no-op).
   */
  cursor?: number;

  /** Previous results for incremental updates */
  previousResults?: CueResult[];

  /** Indices of words that have blanks (underscore placeholders) */
  blankIndices?: number[];

  /**
   * Indices of `_` slots that a higher-priority source already CLAIMED
   * but failed to fill (e.g. TransformBlank's EXTRACT verdict was
   * TRANSFORM but APPLY came back empty). Downstream blank sources
   * MUST NOT fall through to substitute these slots — doing so risks
   * "vandalising" the user's instruction (a transform attempt becoming
   * a stray question answer). The resolver populates this as it
   * iterates sources sequentially. Empty / undefined means "every
   * `_` slot is still fair game."
   */
  consumedBlankSlots?: readonly number[];

  /**
   * Sanitized, low-fan-out description of the field the user is
   * currently filling. Only consumed by FluidBlankSource and only
   * when the `ambient-context-mode` host scalar is on (off by
   * default). Every field is UNTRUSTED — sanitized + wrapped in
   * an explicit untrusted-content block before reaching any prompt.
   *
   * See `AmbientContext` in @opencues/runtime/adapter.ts for the
   * full security contract. This is a deliberate mirror of that
   * shape so core has no runtime dependency on the runtime package.
   */
  ambient?: AmbientContext;

  /**
   * Identity-context catalog derived from `~/.cues/IDENTITY.md`. Only
   * consumed by FluidBlankSource and only when
   * `identity-context-mode: safe` or `: raw` is set in OPENCUES.md
   * (off by default). The runtime gate filters before this is
   * populated; sources see `undefined` when the user hasn't opted in.
   *
   * `mode` carries the global scalar so the source can decide
   * whether to inject the catalog with values (`raw`) or
   * tokens-and-descriptions only (`safe`). Mirror of
   * `@opencues/core/identity-context.ts` Identity — declared here so
   * the type closes over CueContext without a circular import.
   */
  identityContext?: { fields: readonly IdentityField[]; catalog: ReadonlyMap<string, string>; mode: 'safe' | 'raw' };

  /**
   * Ambient blank-context catalog (stocks/weather/crypto/… resolved
   * snapshots). Populated by the runtime when
   * `blank-context-mode: safe` or `: raw` is set in OPENCUES.md
   * (off by default). Same threat-model shape as identityContext above:
   * `safe` keeps values off the LLM; `raw` inlines them. Mirror of
   * `@opencues/core/blank-context.ts` BlankContextSnapshot.
   */
  blankContext?: {
    fields: ReadonlyArray<{ token: string; description: string; value: string }>;
    catalog: ReadonlyMap<string, string>;
    mode: 'safe' | 'raw';
  };

  /**
   * Sentinel grammar for rendering + resolving identity-/blank-context
   * tokens. `undefined` / `'bare'` → flat `[TOKEN]` form (the default,
   * byte-identical to pre-feature behaviour). `'typed'` → the
   * parameterized + nested + field-access grammar, parsed + resolved by
   * `@opencues/core`'s typed-sentinel engine. Threaded from
   * OPENCUES.md's `sentinel-language` scalar via the runtime resolver.
   */
  sentinelLanguage?: 'bare' | 'typed';

  /** Additional context for the analysis */
  metadata?: Record<string, unknown>;

  /**
   * Abort signal for the resolve generation this context belongs to.
   * The runtime Resolver creates an AbortController per `resolveAndApply`
   * and aborts it when a new resolve preempts the in-flight one
   * (generation roll). Sources that issue LLM calls SHOULD forward
   * this into `httpAdapter.post(..., { signal })` so the underlying
   * HTTP request is cancelled — the response would be dropped at apply
   * time anyway (stale generation), but the provider call (cost +
   * provider rate-limit pressure) is wasted without abort.
   *
   * Sources that don't issue HTTP requests can ignore this. Synchronous
   * compute / cached lookups are too fast for cancellation to matter.
   *
   * Optional — adapters that don't supply a signal get legacy behaviour
   * (the LLM call runs to completion; its response is dropped on
   * generation mismatch in the runtime apply layer).
   */
  signal?: AbortSignal;
}

/** Single sentinels field. Mirror of `IdentityField` in
 *  sentinels.ts; redeclared here so CueContext stays free of an
 *  intra-package circular import. */
export interface IdentityField {
  readonly key: string;
  readonly token: string;
  readonly value: string;
  readonly description: string;
}

/**
 * Field-and-page metadata about the input the user is filling. Mirror
 * of @opencues/runtime's AmbientContext — see that file for the
 * full security contract (single-field, no sibling values, off by
 * default, sanitized before use, sink restricted to FluidBlankSource).
 */
export interface AmbientContext {
  readonly label?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly ariaDescription?: string;
  readonly inputType?: string;
  readonly pageTitle?: string;
  readonly pageUrl?: string;
  readonly pageDescription?: string;
}

/**
 * Result from querying a cue source.
 */
export interface CueSourceResult {
  /** Results for individual words */
  results: CueResult[];

  /** Error message if source failed */
  error?: string;

  /** Time taken in milliseconds */
  timing?: number;

  /** Model used (for LLM sources) */
  model?: string;

  /** Token usage (for LLM sources) */
  tokens?: { in: number; out: number };

  /**
   * `_` slot indices this source CLAIMED but failed to fill. The
   * resolver forwards these to subsequent sources via `CueContext.
   * consumedBlankSlots` so they can short-circuit and avoid stepping
   * on the user's intent. Most sources should never populate this —
   * it's the "I tried, give up cleanly" signal, NOT "I didn't match."
   * Currently set by TransformBlank when EXTRACT classified the input
   * as TRANSFORM but APPLY returned empty.
   */
  consumedBlankSlots?: readonly number[];
}

/**
 * A source of cue data (tips file, LLM, database, etc.)
 */
export interface CueSource {
  /** Unique identifier for this source */
  id: string;

  /** Priority for resolution order (higher = checked first) */
  priority: number;

  /**
   * True when this source surfaces alternatives the user picks between
   * via keyboard cycling — word-cues, selector/satellite blanks, list
   * blanks, etc. False for single-answer sources (fluid-blank,
   * transform-blank, compute blanks like weather/stocks).
   *
   * Hosts without a cycling surface (chrome's normal-`<input>` /
   * `<textarea>` mode, future read-only integration profiles) drop
   * cycleable sources at registration time — they have no UI to
   * present alternatives, so running the source would be either
   * wasted token spend (cues) or a confusing partial fill (selector
   * blanks land on alt #1 with no way to step).
   *
   * Inferred structurally from each source's definition shape — no
   * frontmatter changes for users. The one exception is
   * script-backed cue-blanks (volume, brightness): the runtime
   * can't introspect a shell script, so it reads the existing
   * `cycleable:` BLANK.md flag (defaults to true → default-deny on
   * universal hosts; explicit opt-in with `cycleable: false`).
   */
  isCycleable: boolean;

  /** Check if this source can handle the given context */
  supports(context: CueContext): boolean;

  /** Get cues for the given context */
  getCues(context: CueContext): Promise<CueSourceResult>;
}

/**
 * Configuration for the cue resolver.
 */
export interface CueResolverConfig {
  /** Whether to query sources in parallel (default: false - priority order) */
  parallel?: boolean;

  /** Timeout for each source in milliseconds */
  timeout?: number;

  /** Whether to continue on source errors (default: true) */
  continueOnError?: boolean;
}

/**
 * Metrics collected during cue resolution.
 */
export interface CueMetrics {
  /** Source that produced the result */
  sourceId: string;

  /** Time taken in milliseconds */
  latencyMs: number;

  /** Number of results returned */
  resultCount: number;

  /** Whether result came from cache */
  cacheHit: boolean;

  /** Error if source failed */
  error?: string;
}

// ============================================================================
// Word Definition Types (for integration with highlighting systems)
// ============================================================================

/**
 * A word definition with alternatives, used by highlighting systems.
 * This is the format expected by tweakcc's _dynDefs and similar systems.
 */
export interface WordDef {
  /** Word position in the text (0-indexed) */
  index: number;

  /** The actual word at this position */
  word: string;

  /** Alternative words to cycle through, or null if none */
  alts: string[] | null;

  /** Cue-tip text for this word */
  cueTip?: string;

  /** Per-alternative cue-tips */
  altCueTips?: Record<string, string>;

  /** Source identifier */
  source?: 'tips' | 'llm' | 'grammar' | 'math' | 'factual';

  /** Linked word indices (cycle together) */
  linked?: number[] | null;

  /** Current position in alts array when cycling */
  currentAltIndex?: number;

  /** When true, tip is read aloud via TTS on navigation */
  speak?: boolean;

  /** Arbitrary metadata (e.g., blank binding info) */
  metadata?: Record<string, unknown>;
}

/**
 * Result from lookupMultiple() - words found in tips and those missing.
 */
export interface LookupMultipleResult {
  /** Words that were found in the tips map */
  found: WordDef[];

  /** Indices of words that were NOT found (need LLM) */
  missingIndices: number[];
}

// ============================================================================
// Local Cue Types (for LocalCueSource)
// ============================================================================

/**
 * Entry for a single word in the tips file (words structure).
 */
export interface CueWordEntry {
  /** Cue-tip text displayed when this word is highlighted (JSON field: "tip") */
  tip: string;

  /** Alternative words to cycle through */
  alts: string[];

  /** When true, tip is read aloud via TTS on navigation */
  speak?: boolean;
}

/**
 * A synonym group in the tips file (groups structure).
 */
export interface CueSynonymGroup {
  /** Words that are synonyms (share the same tip) */
  synonyms: string[];

  /** Cue-tip text for all synonyms in this group (JSON field: "tip") */
  tip: string;

  /** Alternatives - point to other groups/concepts, not more synonyms */
  alts: string[];

  /** When true, tip is read aloud via TTS on navigation */
  speak?: boolean;
}

/**
 * A section in the tips file.
 */
export interface LocalCueSection {
  /** Unique identifier for this section */
  id: string;

  /** Per-word entries (old format) */
  words?: Record<string, CueWordEntry>;

  /** Synonym groups (new format) */
  groups?: CueSynonymGroup[];
}

/**
 * Full tips file data.
 */
export type LocalCueData = LocalCueSection[];

// ============================================================================
// Platform Adapters
// ============================================================================

/**
 * Adapter for storage operations (file system, chrome.storage, etc.)
 */
export interface StorageAdapter {
  /** Read data from storage */
  read(key: string): Promise<string | null>;

  /** Write data to storage */
  write(key: string, value: string): Promise<void>;

  /** Watch for changes (optional) */
  watch?(key: string, callback: (value: string) => void): () => void;
}

/**
 * Adapter for HTTP operations.
 *
 * `post` accepts an optional 4th `options` arg carrying an `AbortSignal`.
 * Implementations SHOULD honour `options.signal` — when the signal aborts,
 * the in-flight request is cancelled (Node: `req.destroy`; browser:
 * native `fetch({ signal })`). Backwards-compatible: callers that don't
 * pass options keep legacy behaviour. Used by the resolver's per-resolve
 * AbortController to drop LLM calls when a newer keystroke supersedes
 * the in-flight one (saves provider $$$ + rate-limit pressure).
 */
export interface HttpAdapter {
  /** Make a POST request. `options.signal` cancels the in-flight request. */
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
    options?: { signal?: AbortSignal },
  ): Promise<string>;

  /** Make a GET request */
  get?(url: string, headers?: Record<string, string>): Promise<string>;
}

/**
 * Adapter for configuration/environment.
 */
export interface ConfigAdapter {
  /** Get a configuration value */
  get(key: string): string | undefined;

  /** Get all configuration */
  getAll?(): Record<string, string>;
}
