/**
 * opencues-core/cues-md.ts
 *
 * Parser for CUES.md config files.
 * Pure TypeScript — no I/O dependencies.
 */

import { LocalCueData } from './types';
import { isSpecCompatible } from './spec-version';

// ============================================================================
// Types
// ============================================================================

export interface CuesMdFrontmatter {
  name?: string;
  description?: string;
  domain?: string;
  version?: number;
  /** Spec version pin — `opencues/<major>.<minor>[-<pre>]`. The
   *  master-file parsers (CUES.md / BLANKS.md / AUDITORS.md) reject
   *  files declaring a `spec:` newer than the runtime's pinned
   *  `SPEC_VERSION`. See `spec-version.ts:isSpecCompatible`. */
  spec?: string;
  /** Words to never suggest alternatives for (frontmatter form, replaces
   *  the legacy `## Ignore` body section). */
  ignore?: string[];
  /** Master-file only — source ids to subtract from this layer's
   *  composition. Symmetric across CUES.md / BLANKS.md / AUDITORS.md.
   *  Project-level `disable:` skips the named source for this project
   *  without modifying the user-level library. */
  disable?: string[];
  /** Host-compat allow-list. Folder discovery skips the whole pack when
   *  the running host isn't in this list. See `discover.ts:isAllowedOnHost`. */
  onHost?: string[];
  /** Host-compat deny-list. Folder discovery skips the whole pack when
   *  the running host is in this list. */
  notOnHost?: string[];
}

/**
 * A prompt source defined as a ### subsection under ## Prompt.
 * Each source has optional classification rules and a prompt.
 */
/** How to parse the LLM response for a cue source */
export type BlankParser = 'alternatives' | 'raw';

export interface SourceConfig {
  /** Source name (from ### heading, e.g. "grammar", "legal", "medical") */
  name: string;

  /** Pipe-separated regex pattern for fast pre-LLM classification (e.g. "factorial|sqrt|\d+%") */
  match?: string;

  /** Comma-separated keywords for fast pre-LLM classification (e.g. "average, half of, tip") */
  keywords?: string;

  /** Natural language hint for LLM-based classification */
  classify?: string;

  /** Source priority (higher = checked first) */
  priority?: number;

  /** Whether this source is enabled (default: true) */
  enabled?: boolean;

  /** Path to external prompt file (if omitted, inline text is used) */
  promptPath?: string;

  /** Inline prompt instructions (freeform markdown text outside code blocks) */
  promptText?: string;

  /** Model override for this source */
  model?: string;

  /**
   * Provider override for this source (groq | openrouter | gemini | openai).
   * Per-cue overrides take precedence over per-feature defaults; per-feature
   * defaults take precedence over the global `llm-provider:` setting.
   */
  provider?: string;

  /** Endpoint override (rare — most users only need provider + model). */
  endpoint?: string;

  /**
   * How to parse the LLM response for blank fill-in.
   * compute     — extract COMPUTE=expr and evaluate as JS math
   * answer      — extract ANSWER=value as a single alternative
   * alternatives — parse INDEX:alt1,alt2,... (grammar format)
   * raw         — use the full LLM response verbatim as one alternative
   * (default: alternatives)
   */
  parser?: BlankParser;

  /**
   * When this source activates:
   * words    — only when no blanks present (word alternatives — RoutedWordSourceGroup)
   * blanks   — only when blanks (_) present (fill-in)
   * sentence — sentence-scope cue (whole-sentence alternatives via SentenceCueSource)
   * all      — always
   * (default: inferred from context — 'words' for CUES.md, 'blanks' for BLANKS.md)
   */
  scope?: 'words' | 'blanks' | 'sentence' | 'all';

  /**
   * Max output tokens for this source's LLM calls. Per-source override
   * — when absent the source class uses its own bench-tuned default
   * (ConfigSource 800, FluidBlank 512, SentenceCue 768, ConfigIntent 128,
   * TransformBlank varies per pass).
   *
   * Useful when one cue source needs a tighter ceiling (terse single-
   * word alternatives) or a looser one (long-form rewrites). The
   * provider's reasoning-token floor still applies — setting
   * `maxTokens: 100` on a gpt-oss reasoning model will be floored to
   * 2048 to avoid budget-starvation (see llm-provider.ts).
   */
  maxTokens?: number;

  /**
   * Sampling temperature for this source's LLM calls. Range 0..2 for
   * most providers (gpt-5/o-series lock at 1; the provider adapter
   * strips temperature on those). Per-source override — when absent
   * the source class uses its own default (ConfigSource 0.3, SentenceCue
   * 0.3, FluidBlank 0, TransformBlank 0, ConfigIntent 0).
   *
   * Lower = more deterministic (use 0 for classifiers / lookups).
   * Higher = more variety (use 0.5-1.0 for creative rewrites).
   */
  temperature?: number;
}

/**
 * Top-level prompt config (model/provider applied to all sources).
 */
export interface PromptConfig {
  /** Default model for all sources */
  model?: string;

  /** Default provider */
  provider?: string;

  /** Per-source configurations, keyed by source name */
  sources: Record<string, SourceConfig>;
}

/** @deprecated Use BlankConfig instead */
export type ActionConfig = BlankConfig;

/**
 * One deterministic invocation shape for a blank (type-based routing). An
 * anchored regex over the buffer; on match the blank claims the `_` with the
 * given action, extracting the set/step value from capture group `valueGroup`.
 */
export interface BlankShape {
  /** Anchored regex source, e.g. `^volume\\s+(\\d+)\\s*%?\\s*_$`. */
  pattern: string;
  /** Action implied by a match. */
  action: 'get' | 'set' | 'step';
  /** 1-based capture group carrying the value (for set/step). Omit for get. */
  valueGroup?: number;
}

export interface BlankConfig {
  name: string;
  /** When false, the blank is parsed but skipped at registration time so it
   *  never claims a keyword. Mirrors the same field on SourceConfig + AuditorConfig.
   *  Default (omitted) = enabled. */
  enabled?: boolean;
  tip?: string;
  speak?: boolean;
  /** Context words that bind a blank (_) to this entry (e.g., ['volume', 'sound']) */
  blankKeywords?: string[];
  /** Increment/decrement step size when cycling a blank */
  blankStep?: number;
  /** When true, auto-fill the blank with the current value on analysis */
  blankAutoPopulate?: boolean;
  /**
   * BlankFill result-cache TTL in milliseconds. When > 0, the script's
   * stdout from `<blankName> get <keyword> ...contextWords` is memoised
   * for this window — a subsequent invocation with identical args
   * within the window reuses the stored value instead of re-spawning.
   * 0 disables the cache. Omitted → runtime default (currently 2000ms).
   * Tune higher for slow-moving ambient sources (stocks 5000-15000ms,
   * weather 60000ms); leave at default for action blanks (volume,
   * brightness) so cycling stays responsive without masking real-world
   * value drift.
   */
  blankCacheTtlMs?: number;
  /** Value format: integer (default), float, or string */
  blankFormat?: 'integer' | 'float' | 'string';
  /** Tip shown when the auto-populated value is highlighted */
  blankTip?: string;
  /** Script for blank get/set. */
  blankScript?: string;
  /**
   * In-process binding profile.
   *
   * - When OMITTED: the runtime tries `<PascalCase(name)>Blank` as
   *   the class name in its built-in blanks registry.
   * - When a NAME (no `./` or `/`): same — look up that class in the
   *   registry. E.g. `impl: WeatherBlank` finds the WeatherBlank class.
   * - When a relative PATH starting with `./` or `../`: load as a
   *   user-shipped JS module. The runtime runs the JS in a
   *   capability-constrained context (vm.runInContext on Node, Web
   *   Worker in Chrome). The script receives ONLY the capabilities
   *   declared in `userBlankNetwork` / `userBlankLlm` /
   *   `userBlankStorage` frontmatter — anything else is undefined.
   *   See `packages/opencues-runtime/src/user-blanks/` for the loader.
   *
   * Authoring contract for user-shipped JS:
   *   export default {
   *     async get(ctx, args) { return value; },
   *     async set(ctx, value, args) {},     // optional, for cycling
   *   };
   */
  impl?: string;
  /** When `impl: ./xxx`, the hostnames the blank may fetch from.
   *  Hostnames only (no paths, no wildcards in v1). */
  userBlankNetwork?: string[];
  /** When `impl: ./xxx`, provider name for `ctx.llm()` access. The
   *  user can't pick endpoints — only providers (groq, openai, etc.). */
  userBlankLlm?: string;
  /** When `impl: ./xxx`, the storage namespace. `ctx.storage.{get,set}`
   *  reads/writes under this namespace; cannot access other namespaces. */
  userBlankStorage?: string;
  /** When `impl: ./xxx`, env-var names the blank may read via
   *  `ctx.secrets[<NAME>]`. The host injects values; anything not
   *  declared is absent. Used for third-party API keys (FINNHUB_API_KEY)
   *  that aren't routed through the LLM stack. */
  userBlankSecrets?: string[];
  /** Per-secret hostname allow-list, parsed from dot-notation
   *  frontmatter (`secret-hosts.GROQ_API_KEY: [api.groq.com]`).
   *  ctx.fetch refuses to send a request whose URL/headers/body
   *  contain a bound secret value to a host outside its allow-list. */
  userBlankSecretBindings?: Record<string, string[]>;
  /** Output sanitization mode for the blank's return values.
   *  'safe' (default): strip HTML tags / zero-width / bidi overrides,
   *  NFKC-normalize, cap at 8KB. 'rich': bypass — for blanks that
   *  legitimately need HTML or control chars (emoji ZWJ sequences). */
  userBlankOutput?: 'safe' | 'rich';
  /** Per-blank quota caps. Defaults: 120 fetches/min, 30 LLM/min,
   *  1MB storage. Hard ceilings clamp larger values; validate warns.
   *  See packages/opencues-runtime/src/user-blanks/quota.ts. */
  maxFetchesPerMinute?: number;
  maxLlmPerMinute?: number;
  maxStorageBytes?: number;
  /**
   * Blank-as-context opt-in. When `safe` or `raw`, the blank
   * contributes one or more tokens to fluid-blank's ambient prompt
   * catalog without the user typing the keyword. See
   * `docs/features/blank-as-context.md` and
   * `docs/architecture/blank-as-context.md`.
   * - `off` (default) → keyword-trigger path only; not ambient.
   * - `safe` → only resolved tokens flow; values substitute post-LLM.
   * - `raw`  → values inlined into the prompt. Requires
   *   `identity-context-mode: raw` for consistency.
   */
  asContext?: 'off' | 'safe' | 'raw';
  /** Seconds a snapshot stays cached. Refresh is lazy on prompt-build. */
  contextTtl?: number;
  /** Explicit list of slot names. Each slot produces one token
   *  `[<BLANK> <SLOT>]`. Use this when the slots are static. */
  contextSlots?: string[];
  /** Alternative to contextSlots — bind to a sentinel field. Reads
   *  the sentinel's value; that value (or its split fragments)
   *  becomes the slot list. */
  contextBind?: string;
  /** When set with contextBind, the sentinel's value is split on this
   *  separator and each fragment becomes a slot. Mandatory ack via
   *  `splitValuesInTokenNamesAck: true` (the value fragment ends up
   *  in the token name — only safe for opaque codes like ticker
   *  symbols, not personal-name-shaped data). */
  contextBindSplit?: string;
  /** Required acknowledgement when contextBindSplit is set. The blank
   *  is dropped from the context catalog if missing. */
  splitValuesInTokenNamesAck?: boolean;
  /**
   * Opt-in OS-level sandbox for this blank's script. When 'strict',
   * the runtime wraps the spawn with bubblewrap (Linux/WSL) — readonly
   * filesystem, no network, isolated PID/IPC namespaces. The script
   * sees: read-only `/usr` / `/etc` / `/bin` / `/lib*`, a fresh tmpfs
   * `/tmp`, and read-only access to its own blank folder. Volume /
   * brightness scripts that need to reach `/mnt/c/` (WSL) or call
   * system binaries should LEAVE this off until they declare the
   * permissions they need.
   *
   * Defaults to 'off' so existing blanks aren't broken.
   */
  sandbox?: 'strict' | 'off';
  /** When `sandbox: strict`, allow network from inside the sandbox.
   *  Default 'deny'. Set to 'allow' for blanks that legitimately need
   *  HTTP access (rare for scripts — most LLM/HTTP blanks live in the
   *  in-process `impl:` path, not in subprocess scripts). */
  sandboxNet?: 'allow' | 'deny';
  /** When `sandbox: strict`, the blank's folder is bound read-only by
   *  default. Set to 'rw' if the script needs to write state files
   *  alongside itself. /tmp is always rw (fresh tmpfs). */
  sandboxFs?: 'ro' | 'rw';
  /** Max words allowed between keyword and _ (0 = adjacent, undefined = no limit) */
  blankProximity?: number;
  /** If true, cycling (Up/Down) is disabled — display-only blank */
  blankReadOnly?: boolean;
  /** If true, `_` is appended as the last cycling option so the user can dismiss the value */
  blankDismissible?: boolean;
  /** Suffix appended to the displayed value (e.g. "%" shows "50%"). Stripped before arithmetic, re-appended for display. */
  blankSuffix?: string;
  /** Ordered list of values to cycle through on a blank */
  stepValues?: string[];
  /** Map from keyword (lowercase) to display expansion applied at auto-populate time (e.g. { rddt: "Reddit" }) */
  blankKeywordExpansions?: Record<string, string>;
  /** If true, blank auto-populates as two independent words: selector (word N) + satellite (word N+1) */
  blankSatellite?: boolean;
  /** Display separator between selector and satellite in the text (default: ' '). Script always outputs tab-delimited. */
  blankSatelliteSeparator?: string;
  /** If true, keyword context words are removed from text when blank auto-populates */
  blankClearKeywords?: boolean;
  /** If true, pair cleanup (selector/satellite edit) removes the spawned words from text */
  blankClearOnEdit?: boolean;
  /** If true, words between keyword and blank are added to blankKeywordIndices (clears keyword + context, preserves surrounding text) */
  blankConsumeContext?: boolean;
  /** If true, ALL non-blank word indices are added to blankKeywordIndices (clears entire input on auto-populate) */
  blankConsumeAll?: boolean;
  /**
   * Unified replacement mode — when the blank fires, where does the
   * answer text land?
   *
   *   'keep'     — only `_` becomes the answer. Keyword + context stays.
   *   'wipe'     — keyword + context + `_` becomes the answer.
   *   'wipe-all' — the entire input becomes the answer (consume-all).
   *   'auto'     — apply the fluid heuristic: copula/equation/question
   *                marker before `_` → keep ("X is _"); else → wipe.
   *
   * Default is 'auto'. Legacy fields (blankClearKeywords,
   * blankConsumeContext, blankConsumeAll) still parse and map onto
   * this field: clearKeywords|consumeContext → 'wipe', consumeAll →
   * 'wipe-all'. If both new and legacy fields are set, the new field
   * wins. See docs/architecture/blank-replace-modes.md.
   */
  blankReplace?: 'keep' | 'wipe' | 'wipe-all' | 'auto';
  /**
   * Deterministic invocation grammar (EXPERIMENT — type-based routing). Each
   * shape is an anchored regex over the buffer + the action it implies; a
   * match claims the `_` for this blank with ZERO LLM and NO proximity check
   * (the query unambiguously fits this blank's declared type). `valueGroup`
   * is the capture-group index carrying the set/step value. Example (volume):
   *   [{"pattern":"^volume\\s+(\\d+)\\s*%?\\s*_$","action":"set","valueGroup":1}]
   * See docs/architecture/blank-shapes.md.
   */
  blankShapes?: BlankShape[];
  /** LLM model identifier for script-based LLM calls (e.g. 'openai/gpt-oss-120b') */
  model?: string;
  /** Max output tokens for this blank's LLM calls (when the blank's
   *  impl makes one). Per-blank override; falls back to source-class
   *  default when absent. See SourceConfig.maxTokens for full semantics. */
  maxTokens?: number;
  /** Sampling temperature for this blank's LLM calls. Per-blank
   *  override; falls back to source-class default. */
  temperature?: number;
  /** API endpoint URL for script-based LLM calls (default: Groq) */
  apiUrl?: string;
  /** Environment variable name holding the API key (default: GROQ_API_KEY) */
  apiKeyEnv?: string;
  /** Number of alternatives the script should return (default: 3) */
  altCount?: number;
  /** If true, include the original input as the last cycling alternative (default: true) */
  includeOriginal?: boolean;
  /** Named prompts parsed from ## sections in the CUE.md / BLANK.md body (e.g. { Extract: "...", Transform: "..." }) */
  prompts?: Record<string, string>;
  /**
   * Explicit host allow-list. When set, narrows the default (all hosts) to
   * this set. Use the canonical host names: claude-code, opencode, chrome,
   * gemini-cli. See @opencues/core's `inferHostCompat()` for the resolution rules.
   */
  onHost?: string[];
  /**
   * Explicit host deny-list. Removes hosts from the default (or `on-host`)
   * set. Useful for marking a blank as "not chrome" when chrome genuinely
   * can't run it (rare — chrome-host runs scripts on chrome's behalf, so
   * `.sh`/`.py` entries work everywhere by default).
   */
  notOnHost?: string[];
  /**
   * Scope allow-list — entries can be platform names, hostnames,
   * wildcard hostnames, or hostname-with-path-prefix patterns. When
   * non-empty, the section only fires for matching scopes. See
   * `inferSiteCompat()` for the resolution rules.
   */
  onSite?: string[];
  /** Scope deny-list. Same matching as on-site; entries that match are filtered out. */
  notOnSite?: string[];
}

export interface CuesMdConfig {
  /** Parsed YAML frontmatter */
  frontmatter: CuesMdFrontmatter;

  /** Parsed tips data from ## Tips JSON block */
  tips?: LocalCueData;

  /** Prompt configuration with per-source definitions */
  promptConfig?: PromptConfig;

  /** Blank definitions from ## Blanks JSON block */
  blanks?: Record<string, BlankConfig>;

  /** Auditor definitions, keyed by name. Populated when discover walks
   *  `auditors/<name>/AUDITOR.md`. See parseSingleAuditorMd. */
  auditors?: Record<string, AuditorConfig>;

  /** Words to never suggest alternatives for from ## Ignore */
  ignore?: string[];

  /** Cue source ids to subtract from this layer's composition.
   *  Read from CUES.md frontmatter `disable: [...]`. */
  disableCues?: string[];

  /** Blank source ids to subtract from this layer's composition.
   *  Read from BLANKS.md frontmatter `disable: [...]`. */
  disableBlanks?: string[];

  /** Auditor source ids to subtract from this layer's composition.
   *  Read from AUDITORS.md frontmatter `disable: [...]`. */
  disableAuditors?: string[];

  /** Raw section content for unknown/extensible sections */
  sections: Record<string, string>;

  /** Populated when the parser refused this file because its `spec:`
   *  declares a version newer than the runtime supports (or
   *  cross-major-with-stable-reader, post-1.0). When set, the rest
   *  of the config is intentionally empty — callers MUST skip the
   *  source AND surface this string in their logs so the user can
   *  see why the file isn't loading. Per `SPEC.md`'s "MUST refuse
   *  files declaring a newer spec:" rule. See
   *  `spec-version.ts:isSpecCompatible`. */
  specError?: string;
}

/**
 * One entry per `auditors/<name>/AUDITOR.md`. Auditors are inline-rewrite
 * concerns whose prompts compose into a single LLM call.
 *
 * No `match:` / `keywords:` / `parser:` — auditors operate on the whole
 * buffer; gating is expressed in the prompt body. No per-auditor
 * `provider:` / `model:` — composition is one LLM call, so the LLM
 * choice lives at the feature level (`audits-provider:` / `audits-model:`
 * in OPENCUES.md).
 */
export interface AuditorConfig {
  /** Source id; matches the folder name. */
  readonly name: string;
  /** Documentation only — not read by the LLM. */
  readonly description?: string;
  /** Concat ordering (higher = earlier). Default 50. */
  readonly priority?: number;
  /** When false, the auditor is parsed but skipped during composition. */
  readonly enabled?: boolean;
  /** Prompt fragment — concatenated into the rewrite prompt. */
  readonly promptText: string;
  /** Host-compat allow-list (replaces auto-detect when present). */
  readonly onHost?: string[];
  /** Host-compat deny-list. */
  readonly notOnHost?: string[];
  /** Site-compat allow-list — platforms / hostnames / hostname+path. */
  readonly onSite?: string[];
  /** Site-compat deny-list. */
  readonly notOnSite?: string[];
}

// ============================================================================
// Forward-compat: known scope values
// ============================================================================

/**
 * Allowlist of `scope:` values this runtime understands. When a CUE.md
 * declares a scope outside this set (typically because a newer scope
 * shipped in a future version that this runtime hasn't been rebuilt
 * for yet), the parser DROPS the source rather than building a generic
 * one and misrendering its LLM output.
 *
 * Mirrors `SourceConfig['scope']`. Update both when adding a scope.
 *
 * Why drop instead of coerce: integrations frequently fall behind core
 * (chrome rebuild + sync is a separate step from `pnpm install`). When
 * a new scope ships, the cue config gets distributed via `~/.cues/` but
 * the integration runtime may not have the source class to render it.
 * Silently dropping means "no cue surfaces"; coercing means "wrong
 * surface, garbled output". The first is recoverable by rebuilding;
 * the second looks like a real bug. See May 2026 sentence-cue chrome
 * misrender for the motivating incident.
 */
export const KNOWN_SCOPES: ReadonlySet<string> = new Set(['words', 'blanks', 'sentence', 'all']);

function isKnownScope(value: unknown): value is SourceConfig['scope'] {
  return typeof value === 'string' && KNOWN_SCOPES.has(value);
}

// ============================================================================
// Frontmatter parsing
// ============================================================================

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a YAML host list value. Accepts:
 *   on-host: [chrome, opencode]      (JSON array)
 *   on-host: chrome, opencode         (comma-separated)
 *   on-host: chrome                   (single host)
 * Returns the raw strings — `inferHostCompat()` does the validation +
 * lowercasing + filtering. Keeping unknown names here lets the validator
 * point them out by their original spelling.
 */
function parseHostList(value: string): string[] {
  let v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through to bare-bracket strip + comma-split */ }
    v = v.slice(1, -1).trim();
  }
  return v.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function parseFrontmatter(content: string): { frontmatter: CuesMdFrontmatter; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const raw = match[1];
  const body = content.slice(match[0].length);
  const fm: CuesMdFrontmatter = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key === 'name') fm.name = value;
    else if (key === 'description') fm.description = value;
    else if (key === 'spec') fm.spec = value;
    else if (key === 'domain') fm.domain = value;
    else if (key === 'version') fm.version = parseInt(value, 10) || undefined;
    else if (key === 'ignore') fm.ignore = parseHostList(value); // JSON array OR comma-sep
  }

  return { frontmatter: fm, body };
}

// ============================================================================
// Section splitting
// ============================================================================

interface Section {
  heading: string;
  level: number;
  content: string;
}

/**
 * Split markdown body into sections by heading level.
 * Returns level-2 (##) sections. Level-3 (###) subsections are kept
 * within their parent's content for further parsing.
 */
function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  const re = /^## (.+)$/gm;
  let lastMatch: { heading: string; start: number } | null = null;
  let match: RegExpExecArray | null;

  while ((match = re.exec(body)) !== null) {
    if (lastMatch) {
      sections.push({
        heading: lastMatch.heading,
        level: 2,
        content: body.slice(lastMatch.start, match.index).trim(),
      });
    }
    lastMatch = { heading: match[1].trim(), start: match.index + match[0].length };
  }

  if (lastMatch) {
    sections.push({
      heading: lastMatch.heading,
      level: 2,
      content: body.slice(lastMatch.start).trim(),
    });
  }

  return sections;
}

/**
 * Split a section's content into ### subsections.
 */
function splitSubsections(content: string): { preamble: string; subs: Section[] } {
  const subs: Section[] = [];
  const re = /^### (.+)$/gm;
  let lastMatch: { heading: string; start: number } | null = null;
  let match: RegExpExecArray | null;
  let firstSubStart = -1;

  while ((match = re.exec(content)) !== null) {
    if (firstSubStart === -1) firstSubStart = match.index;
    if (lastMatch) {
      subs.push({
        heading: lastMatch.heading,
        level: 3,
        content: content.slice(lastMatch.start, match.index).trim(),
      });
    }
    lastMatch = { heading: match[1].trim(), start: match.index + match[0].length };
  }

  if (lastMatch) {
    subs.push({
      heading: lastMatch.heading,
      level: 3,
      content: content.slice(lastMatch.start).trim(),
    });
  }

  const preamble = firstSubStart > 0 ? content.slice(0, firstSubStart).trim() : '';

  return { preamble, subs };
}

// ============================================================================
// Code block extraction
// ============================================================================

function extractCodeBlock(content: string, language: string): string | null {
  const re = new RegExp('```' + language + '\\s*\\r?\\n([\\s\\S]*?)\\r?\\n```', 'i');
  const match = content.match(re);
  return match ? match[1] : null;
}

function extractTextOutsideCodeBlocks(content: string): string {
  const withoutBlocks = content.replace(/```[\s\S]*?```/g, '');
  return withoutBlocks.trim();
}

// ============================================================================
// Simple YAML key-value parser
// ============================================================================

function parseSimpleYamlFlat(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (value) result[key] = value;
  }
  return result;
}

// ============================================================================
// Section parsers
// ============================================================================

function parseTipsSection(content: string): LocalCueData | undefined {
  const jsonBlock = extractCodeBlock(content, 'json');
  if (!jsonBlock) return undefined;
  try {
    const data = JSON.parse(jsonBlock);
    if (Array.isArray(data)) return data as LocalCueData;
    if (data && typeof data === 'object' && Array.isArray(data.concepts)) {
      return data.concepts as LocalCueData;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse ## Prompt section with ### subsections for each source.
 *
 * Format:
 *   ## Prompt
 *   <optional preamble with top-level model/provider YAML>
 *
 *   ### grammar
 *   ```yaml
 *   priority: 50
 *   ```
 *   Freeform prompt instructions...
 *
 *   ### legal
 *   ```yaml
 *   match: contract|agreement|clause
 *   classify: Legal terminology
 *   priority: 70
 *   prompt: ./prompts/legal.txt
 *   ```
 *   Inline prompt text if no prompt path...
 */
function parsePromptSection(content: string): PromptConfig {
  const { preamble, subs } = splitSubsections(content);
  const config: PromptConfig = { sources: {} };

  // Parse preamble for top-level model/provider
  if (preamble) {
    const yamlBlock = extractCodeBlock(preamble, 'yaml');
    if (yamlBlock) {
      const kv = parseSimpleYamlFlat(yamlBlock);
      if (kv.model) config.model = kv.model;
      if (kv.provider) config.provider = kv.provider;
    } else {
      // Try parsing preamble text directly as key-value
      const kv = parseSimpleYamlFlat(preamble);
      if (kv.model) config.model = kv.model;
      if (kv.provider) config.provider = kv.provider;
    }
  }

  // Parse each ### subsection as a source
  for (const sub of subs) {
    const sourceName = sub.heading.toLowerCase();
    const source: SourceConfig = { name: sourceName };

    // Extract YAML config block
    const yamlBlock = extractCodeBlock(sub.content, 'yaml');
    if (yamlBlock) {
      const kv = parseSimpleYamlFlat(yamlBlock);
      // Forward-compat: drop the source if scope is set but unknown
      // to this runtime. See KNOWN_SCOPES above.
      if (kv.scope && !isKnownScope(kv.scope)) {
        console.warn(`[opencues] cues-md: dropping source "${sourceName}" — unknown scope "${kv.scope}" (known: ${[...KNOWN_SCOPES].join('|')}). This runtime is likely older than the cue config; rebuild the integration to enable.`);
        continue;
      }
      if (kv.match) source.match = kv.match;
      if (kv.keywords) source.keywords = kv.keywords;
      if (kv.classify) source.classify = kv.classify;
      if (kv.priority) source.priority = parseInt(kv.priority, 10) || undefined;
      if (kv.enabled !== undefined) source.enabled = kv.enabled !== 'false';
      if (kv.prompt) source.promptPath = kv.prompt;
      if (kv.model) source.model = kv.model;
      if (kv.provider) source.provider = kv.provider;
      if (kv.endpoint) source.endpoint = kv.endpoint;
      if (kv.parser) source.parser = kv.parser as BlankParser;
      if (kv.scope) source.scope = kv.scope as SourceConfig['scope'];
      if (kv['max-tokens'] || kv.maxTokens) {
        const n = parseInt(kv['max-tokens'] ?? kv.maxTokens, 10);
        if (Number.isFinite(n) && n > 0) source.maxTokens = n;
      }
      if (kv.temperature !== undefined) {
        const t = parseFloat(kv.temperature);
        if (Number.isFinite(t) && t >= 0 && t <= 2) source.temperature = t;
      }
    }

    // Extract freeform text as inline prompt
    const text = extractTextOutsideCodeBlocks(sub.content);
    if (text) source.promptText = text;

    config.sources[sourceName] = source;
  }

  // Legacy fallback: a `## Prompt` block with no `### subsections` used to
  // become a single source named "grammar". Modern OpenCues uses folder-
  // based cue sources (`cues/<name>/CUE.md`), so the inline form is rare.
  //
  // We still emit a source for back-compat, but ONLY when the body
  // declares `match:` or `keywords:` (a source without either can't route
  // any word — the runtime drops it, and including it would surface a
  // phantom entry in `opencues list`). All-comments / docs-only bodies
  // are correctly ignored.
  if (subs.length === 0 && content.trim()) {
    const yamlBlock = extractCodeBlock(content, 'yaml');
    if (yamlBlock) {
      const kv = parseSimpleYamlFlat(yamlBlock);
      if (kv.match || kv.keywords) {
        // Forward-compat: drop the legacy grammar source if scope is
        // set but unknown to this runtime.
        if (kv.scope && !isKnownScope(kv.scope)) {
          console.warn(`[opencues] cues-md: dropping legacy "grammar" source — unknown scope "${kv.scope}" (known: ${[...KNOWN_SCOPES].join('|')}).`);
        } else {
          const text = extractTextOutsideCodeBlocks(content);
          const source: SourceConfig = { name: 'grammar' };
          if (kv.match) source.match = kv.match;
          if (kv.keywords) source.keywords = kv.keywords;
          if (kv.classify) source.classify = kv.classify;
          if (kv.priority) source.priority = parseInt(kv.priority, 10) || undefined;
          if (kv.model) source.model = kv.model;
          if (kv.provider) source.provider = kv.provider;
          if (kv.endpoint) source.endpoint = kv.endpoint;
          if (kv.parser) source.parser = kv.parser as BlankParser;
          if (kv.scope) source.scope = kv.scope as SourceConfig['scope'];
          if (text) source.promptText = text;
          config.sources['grammar'] = source;
        }
      }
    }
  }

  return config;
}

function parseBlanksSection(content: string): Record<string, BlankConfig> | undefined {
  const jsonBlock = extractCodeBlock(content, 'json');
  if (!jsonBlock) return undefined;
  try {
    const raw = JSON.parse(jsonBlock) as Record<string, BlankConfig>;
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && !entry.name) entry.name = key;
    }
    return raw;
  } catch {
    return undefined;
  }
}

function parseIgnoreSection(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

// ============================================================================
// Main parser
// ============================================================================

/**
 * Parse a CUES.md file content string.
 * Pure function — no I/O.
 */
export function parseCuesMd(content: string): CuesMdConfig {
  const { frontmatter, body } = parseFrontmatter(content);

  // Spec-version refusal — `SPEC.md` § Version policy.
  // Returns an intentionally empty config + a populated `specError`
  // so callers (ConfigLoader / discover) can log + skip.
  const compat = isSpecCompatible(frontmatter.spec);
  if (!compat.ok) {
    return { frontmatter, sections: {}, specError: compat.reason };
  }

  const sections = splitSections(body);

  const result: CuesMdConfig = {
    frontmatter,
    sections: {},
  };

  // Frontmatter `ignore: [...]` is the canonical source. Body `## Ignore`
  // is still parsed below as a backward-compat fallback.
  if (frontmatter.ignore && frontmatter.ignore.length > 0) {
    result.ignore = frontmatter.ignore;
  }

  for (const section of sections) {
    const heading = section.heading.toLowerCase();

    switch (heading) {
      case 'tips': {
        // Legacy `## Tips` JSON section. New format is folder-based —
        // each tip group lives in `cues/<id>/CUE.md` with type:tips.
        // Kept here only so old user installs parse cleanly until
        // seed-configs migration runs.
        result.tips = parseTipsSection(section.content);
        break;
      }
      case 'prompt': {
        result.promptConfig = parsePromptSection(section.content);
        break;
      }
      case 'blanks': {
        // Legacy `## Blanks` JSON section. New format is folder-based.
        // Kept for backward compat during migration.
        result.blanks = parseBlanksSection(section.content);
        break;
      }
      case 'ignore': {
        // Legacy `## Ignore` body section. New format is the
        // `ignore: [...]` array in frontmatter — already populated
        // above. Body section overrides only if frontmatter empty.
        if (!result.ignore || result.ignore.length === 0) {
          result.ignore = parseIgnoreSection(section.content);
        }
        break;
      }
      default: {
        result.sections[section.heading] = section.content;
        break;
      }
    }
  }

  return result;
}

// ============================================================================
// Single CUE.md / BLANK.md parser (folder-based config)
// ============================================================================

/**
 * Extended frontmatter for individual CUE.md / BLANK.md files in folder layout.
 * Config lives in frontmatter instead of YAML code blocks.
 */
export interface SingleCueFrontmatter extends CuesMdFrontmatter {
  /** Spec version pin — `opencues/<major>.<minor>[-<pre>]`. Files
   *  omitting this are treated as `SPEC_OMIT_DEFAULT`. The parser
   *  refuses files declaring a `spec:` newer than `SPEC_VERSION`
   *  (or cross-major-with-stable-reader, post-1.0). See
   *  `spec-version.ts:isSpecCompatible`. */
  spec?: string;
  /** Discriminator for `_`-triggered blanks. Cue sources (both static
   *  and LLM-driven) are inferred from data shape — body JSON ⇒ static,
   *  otherwise prompt-driven. Only `'blank'` is meaningful here. */
  type?: 'blank';
  scope?: 'words' | 'blanks' | 'sentence' | 'all';
  parser?: BlankParser;
  priority?: number;
  match?: string;
  keywords?: string;
  classify?: string;
  model?: string;
  /** Per-cue provider override (groq | openrouter | gemini | openai). */
  provider?: string;
  /** Per-cue endpoint override. Rare. */
  endpoint?: string;
  /** Per-cue max-tokens override. See SourceConfig.maxTokens. */
  maxTokens?: number;
  /** Per-cue temperature override. See SourceConfig.temperature. */
  temperature?: number;
  enabled?: boolean;
  promptPath?: string;
  // Blank-specific fields
  tip?: string;
  speak?: boolean;
  blankKeywords?: string;
  blankStep?: number;
  blankCacheTtlMs?: number;
  blankAutoPopulate?: boolean;
  blankFormat?: 'integer' | 'float' | 'string';
  blankTip?: string;
  blankScript?: string;
  blankProximity?: number;
  blankReadOnly?: boolean;
  blankDismissible?: boolean;
  blankSuffix?: string;
  blankShapes?: BlankShape[];
  stepValues?: string[];
  blankKeywordExpansions?: Record<string, string>;
  blankSatellite?: boolean;
  blankSatelliteSeparator?: string;
  blankClearKeywords?: boolean;
  blankClearOnEdit?: boolean;
  blankConsumeContext?: boolean;
  blankConsumeAll?: boolean;
  blankReplace?: 'keep' | 'wipe' | 'wipe-all' | 'auto';
  apiUrl?: string;
  apiKeyEnv?: string;
  altCount?: number;
  includeOriginal?: boolean;
  /** OS-level sandbox opt-in for scripted blanks. See BlankConfig.sandbox. */
  sandbox?: 'strict' | 'off';
  sandboxNet?: 'allow' | 'deny';
  sandboxFs?: 'ro' | 'rw';
  /** Blank-as-context opt-in. See BlankConfig.asContext. */
  asContext?: 'off' | 'safe' | 'raw';
  contextTtl?: number;
  contextSlots?: string[];
  contextBind?: string;
  contextBindSplit?: string;
  splitValuesInTokenNamesAck?: boolean;
  /** User-shipped JS impl (relative path) or registry name. See BlankConfig.impl. */
  impl?: string;
  /** Capability declarations for user-shipped JS blanks (impl: ./xxx). */
  userBlankNetwork?: string[];
  userBlankLlm?: string;
  userBlankStorage?: string;
  userBlankSecrets?: string[];
  userBlankSecretBindings?: Record<string, string[]>;
  userBlankOutput?: 'safe' | 'rich';
  maxFetchesPerMinute?: number;
  maxLlmPerMinute?: number;
  maxStorageBytes?: number;
  /** Explicit host allow-list — narrows the default (every host) to this set. */
  onHost?: string[];
  /** Explicit host deny-list — removes hosts from the default (or `on-host`) set. */
  notOnHost?: string[];
  /**
   * Scope allow-list. Each entry can be a platform name (claude-code,
   * cc, opencode, oc, chrome, gemini-cli, gemini), a hostname
   * (reddit.com, www.reddit.com), a wildcard hostname (*.reddit.com),
   * or a hostname-with-path-prefix (reddit.com/r/claudeai). When
   * non-empty, the entry only fires for matching scopes.
   *
   * Strictly broader than on-host: anything you can put in on-host
   * can also go in on-site. on-host stays as a platform-only alias
   * for compatibility with existing configs.
   */
  onSite?: string[];
  /** Scope deny-list. Same matching as on-site; entries that match are filtered out. */
  notOnSite?: string[];
}

/**
 * Parse extended frontmatter from a single CUE.md / BLANK.md file.
 * Handles arrays (JSON bracket syntax) for stepValues.
 */
function parseExtendedFrontmatter(content: string): { frontmatter: SingleCueFrontmatter; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const raw = match[1];
  const body = content.slice(match[0].length);
  const fm: SingleCueFrontmatter = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (!value) continue;

    switch (key) {
      case 'name': fm.name = value; break;
      case 'description': fm.description = value; break;
      case 'spec': fm.spec = value; break;
      case 'disable': fm.disable = parseHostList(value); break;
      case 'domain': fm.domain = value; break;
      case 'version': fm.version = parseInt(value, 10) || undefined; break;
      case 'type': fm.type = value as SingleCueFrontmatter['type']; break;
      case 'scope': fm.scope = value as SourceConfig['scope']; break;
      case 'parser': fm.parser = value as BlankParser; break;
      case 'priority': fm.priority = parseInt(value, 10) || undefined; break;
      case 'match': fm.match = value; break;
      case 'keywords': fm.keywords = value; break;
      case 'classify': fm.classify = value; break;
      case 'model': fm.model = value; break;
      case 'provider': fm.provider = value; break;
      case 'endpoint': fm.endpoint = value; break;
      case 'max-tokens': case 'maxTokens': case 'maxtokens': {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) fm.maxTokens = n;
        break;
      }
      case 'temperature': {
        const t = parseFloat(value);
        // Range: 0..2 covers every shipped provider. Higher rejected
        // to avoid 400s; sub-zero rejected outright.
        if (Number.isFinite(t) && t >= 0 && t <= 2) fm.temperature = t;
        break;
      }
      case 'enabled': fm.enabled = value !== 'false'; break;
      case 'promptPath': fm.promptPath = value; break;
      case 'tip': fm.tip = value; break;
      case 'speak': fm.speak = value === 'true'; break;
      case 'blankKeywords': fm.blankKeywords = value; break;
      case 'blankStep': fm.blankStep = parseInt(value, 10) || undefined; break;
      case 'blankCacheTtlMs': {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n >= 0) fm.blankCacheTtlMs = n;
        break;
      }
      case 'blankAutoPopulate': fm.blankAutoPopulate = value === 'true'; break;
      case 'blankFormat': fm.blankFormat = value as 'integer' | 'float' | 'string'; break;
      case 'blankTip': fm.blankTip = value; break;
      case 'blankScript': fm.blankScript = value; break;
      case 'blankProximity': fm.blankProximity = parseInt(value, 10); break;
      case 'blankReadOnly': fm.blankReadOnly = value === 'true'; break;
      case 'blankDismissible': fm.blankDismissible = value === 'true'; break;
      case 'blankSuffix': fm.blankSuffix = value; break;
      case 'blankShapes': try { fm.blankShapes = JSON.parse(value); } catch { /* ignore malformed shapes */ } break;
      case 'stepValues': try { fm.stepValues = JSON.parse(value); } catch { /* ignore */ } break;
      case 'blankKeywordExpansions': try { fm.blankKeywordExpansions = JSON.parse(value); } catch { /* ignore */ } break;
      case 'blankSatellite': fm.blankSatellite = value === 'true'; break;
      case 'blankSatelliteSeparator': fm.blankSatelliteSeparator = value.replace(/^['"]|['"]$/g, ''); break;
      case 'blankClearKeywords': fm.blankClearKeywords = value === 'true'; break;
      case 'blankClearOnEdit': fm.blankClearOnEdit = value === 'true'; break;
      case 'blankConsumeContext': fm.blankConsumeContext = value === 'true'; break;
      case 'blankConsumeAll': fm.blankConsumeAll = value === 'true'; break;
      case 'blankReplace': case 'blank-replace': {
        // Accept only the four canonical modes. Anything else falls
        // through to undefined → resolveReplaceMode picks the legacy
        // alias OR 'auto' default.
        const v = value.toLowerCase().trim();
        if (v === 'keep' || v === 'wipe' || v === 'wipe-all' || v === 'auto') {
          fm.blankReplace = v;
        }
        break;
      }
      case 'apiUrl': case 'apiurl': fm.apiUrl = value; break;
      case 'apiKeyEnv': case 'apikeyenv': fm.apiKeyEnv = value; break;
      case 'altCount': case 'altcount': fm.altCount = parseInt(value, 10) || 3; break;
      case 'includeOriginal': case 'includeoriginal': fm.includeOriginal = value === 'true'; break;
      // Host-compat overrides. Accept both hyphenated (canonical YAML) and
      // camelCase forms. Try JSON-array first; fall back to comma-separated.
      case 'on-host': case 'onHost': fm.onHost = parseHostList(value); break;
      case 'not-on-host': case 'notOnHost': fm.notOnHost = parseHostList(value); break;
      case 'on-site': case 'onSite': fm.onSite = parseHostList(value); break;
      case 'not-on-site': case 'notOnSite': fm.notOnSite = parseHostList(value); break;
      case 'sandbox': fm.sandbox = value === 'strict' ? 'strict' : 'off'; break;
      case 'sandbox-net': case 'sandboxNet': fm.sandboxNet = value === 'allow' ? 'allow' : 'deny'; break;
      case 'sandbox-fs': case 'sandboxFs': fm.sandboxFs = value === 'rw' ? 'rw' : 'ro'; break;
      // Blank-as-context opt-in. See docs/architecture/blank-as-context.md.
      case 'as-context': case 'asContext': case 'ascontext': {
        const v = value.toLowerCase().trim();
        if (v === 'off' || v === 'safe' || v === 'raw') fm.asContext = v;
        break;
      }
      case 'context-ttl': case 'contextTtl': case 'contextttl': {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) fm.contextTtl = n;
        break;
      }
      case 'context-slots': case 'contextSlots': case 'contextslots': {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) fm.contextSlots = parsed.map(String);
        } catch {
          fm.contextSlots = value.split(',').map(s => s.trim()).filter(Boolean);
        }
        break;
      }
      case 'context-bind': case 'contextBind': case 'contextbind':
        fm.contextBind = value.trim(); break;
      case 'context-bind-split': case 'contextBindSplit': case 'contextbindsplit':
        fm.contextBindSplit = value.replace(/^['"]|['"]$/g, ''); break;
      case 'split-values-in-token-names': case 'splitValuesInTokenNames':
      case 'splitvaluesintokennames':
        fm.splitValuesInTokenNamesAck = value.trim().toLowerCase() === 'ok'
          || value.trim().toLowerCase() === 'true';
        break;
      // impl: defaults to undefined → runtime falls back to <name>Blank
      // class lookup. Relative path → user-shipped JS module (loaded
      // through the capability-constrained user-blank loader).
      case 'impl': fm.impl = value; break;
      // Capability declarations for user-shipped JS blanks. Network
      // is a list of hostnames (no wildcards); llm is a provider id;
      // storage is a namespace string.
      case 'network': fm.userBlankNetwork = parseHostList(value); break;
      case 'llm': fm.userBlankLlm = value; break;
      case 'storage': fm.userBlankStorage = value; break;
      case 'secrets': fm.userBlankSecrets = parseHostList(value); break;
      case 'output': fm.userBlankOutput = value === 'rich' ? 'rich' : 'safe'; break;
      case 'max-fetches-per-minute': case 'maxFetchesPerMinute': {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) fm.maxFetchesPerMinute = n;
        break;
      }
      case 'max-llm-per-minute': case 'maxLlmPerMinute': {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) fm.maxLlmPerMinute = n;
        break;
      }
      case 'max-storage-bytes': case 'maxStorageBytes': {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) fm.maxStorageBytes = n;
        break;
      }
      default:
        // Dot-notation: blankKeywordExpansions.rddt: Reddit
        if (key.startsWith('blankKeywordExpansions.')) {
          const subkey = key.slice('blankKeywordExpansions.'.length).toLowerCase();
          if (!fm.blankKeywordExpansions) fm.blankKeywordExpansions = {};
          fm.blankKeywordExpansions[subkey] = value;
        }
        // Dot-notation: secret-hosts.GROQ_API_KEY: [api.groq.com]
        else if (key.startsWith('secret-hosts.') || key.startsWith('secretHosts.')) {
          const prefix = key.startsWith('secret-hosts.') ? 'secret-hosts.' : 'secretHosts.';
          const secretName = key.slice(prefix.length);
          if (!fm.userBlankSecretBindings) fm.userBlankSecretBindings = {};
          fm.userBlankSecretBindings[secretName] = parseHostList(value);
        }
        break;
    }
  }

  return { frontmatter: fm, body };
}

/**
 * Parse a single CUE.md / BLANK.md file (folder-only layout).
 *
 *   `<dir>/<name>/{CUE,BLANK}.md` — `folderPath` is `<dir>/<name>`.
 *   Source name comes from frontmatter `name:` or the folder basename.
 *
 * @param content - File content string
 * @param folderPath - Absolute path used for resolving relative paths
 *   (e.g. `blankScript: ./helper.sh`).
 * @param nameOverride - Source id when frontmatter omits `name:`
 *   (folder basename).
 */
export function parseSingleCueMd(content: string, folderPath: string, nameOverride?: string): CuesMdConfig {
  const { frontmatter, body } = parseExtendedFrontmatter(content);

  // Spec-version refusal — see parseCuesMd's comment.
  const compat = isSpecCompatible(frontmatter.spec);
  if (!compat.ok) {
    return { frontmatter, sections: {}, specError: compat.reason };
  }

  const name = frontmatter.name || nameOverride || 'unknown';

  const result: CuesMdConfig = {
    frontmatter,
    sections: {},
  };

  // Check for ## Ignore section in body
  // Extract ## Ignore section: everything after "## Ignore\n" until next "## " or end
  const ignoreIdx = body.indexOf('## Ignore');
  const ignoreMatch = ignoreIdx >= 0 ? body.slice(ignoreIdx + '## Ignore'.length) : null;
  if (ignoreMatch) {
    const nextSection = ignoreMatch.search(/^## /m);
    const ignoreContent = nextSection >= 0 ? ignoreMatch.slice(0, nextSection) : ignoreMatch;
    result.ignore = parseIgnoreSection(ignoreContent);
  }

  // `type: blank` is the only explicit discriminator — `_`-triggered
  // blanks have a different runtime contract. Static vs LLM cue sources
  // are inferred from data shape: a body JSON code block ⇒ static
  // (hand-curated word → tip/alts/speak entries), otherwise LLM prompt.
  const type = frontmatter.type;

  switch (type) {
    case 'blank': {
      const blank: BlankConfig = {
        name,
        tip: frontmatter.tip,
        speak: frontmatter.speak,
      };
      if (frontmatter.enabled !== undefined) blank.enabled = frontmatter.enabled;
      if (frontmatter.blankKeywords) {
        blank.blankKeywords = frontmatter.blankKeywords.split(',').map(k => k.trim().toLowerCase());
      }
      if (frontmatter.blankStep !== undefined) blank.blankStep = frontmatter.blankStep;
      if (frontmatter.blankCacheTtlMs !== undefined) blank.blankCacheTtlMs = frontmatter.blankCacheTtlMs;
      if (frontmatter.blankAutoPopulate !== undefined) blank.blankAutoPopulate = frontmatter.blankAutoPopulate;
      if (frontmatter.blankFormat !== undefined) blank.blankFormat = frontmatter.blankFormat;
      if (frontmatter.blankTip !== undefined) blank.blankTip = frontmatter.blankTip;
      if (frontmatter.blankProximity !== undefined) blank.blankProximity = frontmatter.blankProximity;
      if (frontmatter.blankReadOnly !== undefined) blank.blankReadOnly = frontmatter.blankReadOnly;
      if (frontmatter.blankDismissible !== undefined) blank.blankDismissible = frontmatter.blankDismissible;
      if (frontmatter.blankSuffix !== undefined) blank.blankSuffix = frontmatter.blankSuffix;
      if (frontmatter.blankShapes !== undefined) blank.blankShapes = frontmatter.blankShapes;
      if (frontmatter.stepValues !== undefined) blank.stepValues = frontmatter.stepValues;
      if (frontmatter.blankKeywordExpansions !== undefined) blank.blankKeywordExpansions = frontmatter.blankKeywordExpansions;
      if (frontmatter.blankSatellite !== undefined) blank.blankSatellite = frontmatter.blankSatellite;
      if (frontmatter.blankSatelliteSeparator !== undefined) blank.blankSatelliteSeparator = frontmatter.blankSatelliteSeparator;
      if (frontmatter.blankClearKeywords !== undefined) blank.blankClearKeywords = frontmatter.blankClearKeywords;
      if (frontmatter.blankClearOnEdit !== undefined) blank.blankClearOnEdit = frontmatter.blankClearOnEdit;
      if (frontmatter.blankConsumeContext !== undefined) blank.blankConsumeContext = frontmatter.blankConsumeContext;
      if (frontmatter.blankConsumeAll !== undefined) blank.blankConsumeAll = frontmatter.blankConsumeAll;
      if (frontmatter.blankReplace !== undefined) blank.blankReplace = frontmatter.blankReplace;
      if (frontmatter.model !== undefined) blank.model = frontmatter.model;
      if (frontmatter.maxTokens !== undefined) blank.maxTokens = frontmatter.maxTokens;
      if (frontmatter.temperature !== undefined) blank.temperature = frontmatter.temperature;
      if (frontmatter.apiUrl !== undefined) blank.apiUrl = frontmatter.apiUrl;
      if (frontmatter.apiKeyEnv !== undefined) blank.apiKeyEnv = frontmatter.apiKeyEnv;
      if (frontmatter.altCount !== undefined) blank.altCount = frontmatter.altCount;
      if (frontmatter.includeOriginal !== undefined) blank.includeOriginal = frontmatter.includeOriginal;
      if (frontmatter.sandbox !== undefined) blank.sandbox = frontmatter.sandbox;
      if (frontmatter.sandboxNet !== undefined) blank.sandboxNet = frontmatter.sandboxNet;
      if (frontmatter.sandboxFs !== undefined) blank.sandboxFs = frontmatter.sandboxFs;
      if (frontmatter.asContext !== undefined) blank.asContext = frontmatter.asContext;
      if (frontmatter.contextTtl !== undefined) blank.contextTtl = frontmatter.contextTtl;
      if (frontmatter.contextSlots !== undefined) blank.contextSlots = frontmatter.contextSlots;
      if (frontmatter.contextBind !== undefined) blank.contextBind = frontmatter.contextBind;
      if (frontmatter.contextBindSplit !== undefined) blank.contextBindSplit = frontmatter.contextBindSplit;
      if (frontmatter.splitValuesInTokenNamesAck !== undefined) blank.splitValuesInTokenNamesAck = frontmatter.splitValuesInTokenNamesAck;
      if (frontmatter.impl !== undefined) {
        // Relative path → resolve to absolute against the BLANK.md's
        // folder. Bare name → stays as-is for runtime registry lookup.
        // `./xxx` → strip the './' before joining (otherwise the
        // resolved path keeps an embedded `./` and string-based
        // lookups in chrome's bundle key map miss).
        if (frontmatter.impl.startsWith('./')) {
          blank.impl = folderPath + '/' + frontmatter.impl.slice(2);
        } else if (frontmatter.impl.startsWith('../')) {
          // Walk up; preserve the .. for callers that resolve via
          // path.resolve (Node loaders). Chrome's string-based
          // lookup currently refuses ../ — that's fine, we're
          // intentionally not letting blanks reach outside their
          // own folder.
          blank.impl = folderPath + '/' + frontmatter.impl;
        } else {
          blank.impl = frontmatter.impl;
        }
      }
      if (frontmatter.userBlankNetwork !== undefined) blank.userBlankNetwork = frontmatter.userBlankNetwork;
      if (frontmatter.userBlankLlm !== undefined) blank.userBlankLlm = frontmatter.userBlankLlm;
      if (frontmatter.userBlankStorage !== undefined) blank.userBlankStorage = frontmatter.userBlankStorage;
      if (frontmatter.userBlankSecrets !== undefined) blank.userBlankSecrets = frontmatter.userBlankSecrets;
      if (frontmatter.userBlankSecretBindings !== undefined) blank.userBlankSecretBindings = frontmatter.userBlankSecretBindings;
      if (frontmatter.userBlankOutput !== undefined) blank.userBlankOutput = frontmatter.userBlankOutput;
      if (frontmatter.maxFetchesPerMinute !== undefined) blank.maxFetchesPerMinute = frontmatter.maxFetchesPerMinute;
      if (frontmatter.maxLlmPerMinute !== undefined) blank.maxLlmPerMinute = frontmatter.maxLlmPerMinute;
      if (frontmatter.maxStorageBytes !== undefined) blank.maxStorageBytes = frontmatter.maxStorageBytes;
      // Parse ## sections from body as named prompts
      const promptSections: Record<string, string> = {};
      const sectionPattern = /^## (.+)$/gm;
      let sMatch: RegExpExecArray | null;
      const positions: { name: string; start: number }[] = [];
      while ((sMatch = sectionPattern.exec(body)) !== null) {
        positions.push({ name: sMatch[1].trim(), start: sMatch.index + sMatch[0].length });
      }
      for (let pi = 0; pi < positions.length; pi++) {
        const end = pi + 1 < positions.length ? positions[pi + 1].start - positions[pi + 1].name.length - 4 : body.length;
        const text = body.slice(positions[pi].start, end).trim();
        if (text) promptSections[positions[pi].name] = text;
      }
      if (Object.keys(promptSections).length > 0) blank.prompts = promptSections;
      // Resolve relative script paths
      if (frontmatter.blankScript) {
        blank.blankScript = frontmatter.blankScript.startsWith('./')
          ? folderPath + '/' + frontmatter.blankScript.slice(2)
          : frontmatter.blankScript;
      }
      result.blanks = { [blank.name]: blank };
      break;
    }
    default: {
      // Cue source — inferred from data shape:
      //   - body JSON code block present ⇒ static cue (hand-curated
      //     words map, populates result.tips)
      //   - otherwise ⇒ LLM cue source (prompt in body, match/keywords
      //     in frontmatter, populates result.promptConfig)
      const jsonBlock = extractCodeBlock(body, 'json');
      if (jsonBlock) {
        try {
          const data = JSON.parse(jsonBlock);
          if (Array.isArray(data)) {
            result.tips = data as LocalCueData;
          } else if (data && typeof data === 'object') {
            const hasSectionFields = 'words' in data || 'groups' in data;
            result.tips = hasSectionFields
              ? [{ id: name, ...data }]
              : [{ id: name, words: data as Record<string, unknown> }];
          }
          break; // static cue — done
        } catch { /* malformed JSON — fall through to prompt parsing */ }
      }

      // Forward-compat: drop the source entirely if scope is set but
      // unknown to this runtime. Treating an unknown-scope cue as a
      // generic word-cue causes the LLM's scope-specific output (e.g.
      // whole-sentence rewrites) to render in word-cue slots — the
      // sentence-cues-on-stale-chrome misrender of May 2026 was
      // exactly this. Silent drop is the safe degrade.
      if (frontmatter.scope !== undefined && !isKnownScope(frontmatter.scope)) {
        console.warn(`[opencues] cues-md: dropping cue "${name}" — unknown scope "${frontmatter.scope}" (known: ${[...KNOWN_SCOPES].join('|')}). This runtime is likely older than the cue config; rebuild the integration to enable.`);
        break;
      }

      // LLM prompt source — frontmatter fields become SourceConfig,
      // body text outside code blocks is the prompt.
      const source: SourceConfig = { name };
      if (frontmatter.match) source.match = frontmatter.match;
      if (frontmatter.keywords) source.keywords = frontmatter.keywords;
      if (frontmatter.classify) source.classify = frontmatter.classify;
      if (frontmatter.priority) source.priority = frontmatter.priority;
      if (frontmatter.enabled !== undefined) source.enabled = frontmatter.enabled;
      if (frontmatter.model) source.model = frontmatter.model;
      if (frontmatter.provider) source.provider = frontmatter.provider;
      if (frontmatter.endpoint) source.endpoint = frontmatter.endpoint;
      if (frontmatter.parser) source.parser = frontmatter.parser;
      if (frontmatter.scope) source.scope = frontmatter.scope;
      if (frontmatter.maxTokens !== undefined) source.maxTokens = frontmatter.maxTokens;
      if (frontmatter.temperature !== undefined) source.temperature = frontmatter.temperature;

      // Resolve promptPath relative to folder
      if (frontmatter.promptPath) {
        source.promptPath = frontmatter.promptPath.startsWith('./')
          ? folderPath + '/' + frontmatter.promptPath.slice(2)
          : frontmatter.promptPath;
      }

      // Body text (outside code blocks) is the prompt
      const text = extractTextOutsideCodeBlocks(body);
      if (text) source.promptText = text;

      result.promptConfig = { sources: { [name]: source } };
      break;
    }
  }

  return result;
}

/**
 * Parse a single AUDITOR.md file (folder-only layout).
 *
 *   `<dir>/auditors/<name>/AUDITOR.md` — `folderPath` is `<dir>/auditors/<name>`.
 *   Source name comes from frontmatter `name:` or the folder basename.
 *
 * Returns a CuesMdConfig with the parsed auditor under `auditors[<name>]`.
 * Body becomes the prompt fragment that the runtime concatenates into the
 * rewrite call.
 */
export function parseSingleAuditorMd(content: string, folderPath: string, nameOverride?: string): CuesMdConfig {
  void folderPath;
  const { frontmatter, body } = parseExtendedFrontmatter(content);

  // Spec-version refusal — see parseCuesMd's comment.
  const compat = isSpecCompatible(frontmatter.spec);
  if (!compat.ok) {
    return { frontmatter, sections: {}, specError: compat.reason };
  }

  const name = frontmatter.name || nameOverride || 'unknown';

  const result: CuesMdConfig = {
    frontmatter,
    sections: {},
  };

  const auditor: AuditorConfig = {
    name,
    description: frontmatter.description,
    promptText: body.trim(),
    enabled: frontmatter.enabled !== false,
    onHost: frontmatter.onHost as string[] | undefined,
    notOnHost: frontmatter.notOnHost as string[] | undefined,
    onSite: frontmatter.onSite as string[] | undefined,
    notOnSite: frontmatter.notOnSite as string[] | undefined,
  };
  if (frontmatter.priority !== undefined) {
    (auditor as { priority?: number }).priority = frontmatter.priority;
  }

  result.auditors = { [name]: auditor };
  return result;
}

/**
 * Parse one of the surface master files (CUES.md / BLANKS.md / AUDITORS.md).
 * Frontmatter only — body is documentation. The `disable: [...]` array
 * surfaces as the surface-specific field (`disableCues` / `disableBlanks`
 * / `disableAuditors`) so the merge layer can subtract from composition
 * at this layer without affecting other layers.
 */
function parseMasterFile(content: string, surface: 'cues' | 'blanks' | 'auditors'): CuesMdConfig {
  const { frontmatter } = parseExtendedFrontmatter(content);

  // Spec-version refusal — see parseCuesMd's comment.
  const compat = isSpecCompatible(frontmatter.spec);
  if (!compat.ok) {
    return { frontmatter, sections: {}, specError: compat.reason };
  }

  const result: CuesMdConfig = { frontmatter, sections: {} };
  const disableRaw = (frontmatter as { disable?: unknown }).disable;
  const disable = Array.isArray(disableRaw)
    ? disableRaw.filter((x): x is string => typeof x === 'string')
    : null;
  if (disable !== null) {
    if (surface === 'cues') result.disableCues = disable;
    else if (surface === 'blanks') result.disableBlanks = disable;
    else result.disableAuditors = disable;
  }
  return result;
}

export function parseCuesMaster(content: string): CuesMdConfig { return parseMasterFile(content, 'cues'); }
export function parseBlanksMaster(content: string): CuesMdConfig { return parseMasterFile(content, 'blanks'); }
export function parseAuditorsMaster(content: string): CuesMdConfig { return parseMasterFile(content, 'auditors'); }

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a parsed CuesMdConfig.
 * Returns array of error strings (empty if valid).
 */
export function validateCuesMd(config: CuesMdConfig): string[] {
  const errors: string[] = [];

  if (config.frontmatter.version !== undefined && config.frontmatter.version < 1) {
    errors.push('Frontmatter version must be >= 1');
  }

  if (config.tips) {
    for (const section of config.tips) {
      if (!section.id) {
        errors.push('Tips section entry missing "id" field');
      }
      if (!section.words && !section.groups) {
        errors.push(`Tips section "${section.id}" has neither "words" nor "groups"`);
      }
    }
  }

  if (config.blanks) {
    for (const [key, blank] of Object.entries(config.blanks)) {
      if (!blank.name) {
        errors.push(`Blank "${key}" missing required "name" field`);
      }
    }
  }

  if (config.promptConfig) {
    const sourceNames = Object.keys(config.promptConfig.sources);

    for (const [key, source] of Object.entries(config.promptConfig.sources)) {
      if (source.priority !== undefined && (source.priority < 0 || source.priority > 100)) {
        errors.push(`Source "${key}" priority must be between 0 and 100`);
      }
      if (source.match) {
        // Validate match pattern compiles as regex
        try {
          new RegExp('\\b(' + source.match + ')\\b', 'i');
        } catch {
          errors.push(`Source "${key}" has invalid match pattern: ${source.match}`);
        }
      }
    }

  }

  return errors;
}
