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

  /** Domain hint (e.g., 'claude-code', 'medical', 'legal') */
  domain?: string;

  /** Previous results for incremental updates */
  previousResults?: CueResult[];

  /** Indices of words that have blanks (underscore placeholders) */
  blankIndices?: number[];

  /** Additional context for the analysis */
  metadata?: Record<string, unknown>;
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
}

/**
 * A source of cue data (tips file, LLM, database, etc.)
 */
export interface CueSource {
  /** Unique identifier for this source */
  id: string;

  /** Priority for resolution order (higher = checked first) */
  priority: number;

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

  /** Arbitrary metadata (e.g., control binding info for control-bound blanks) */
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
 */
export interface HttpAdapter {
  /** Make a POST request */
  post(url: string, body: string, headers: Record<string, string>): Promise<string>;

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
