/**
 * opencues-core/cues-md.ts
 *
 * Parser for cues.md config files.
 * Pure TypeScript — no I/O dependencies.
 */

import { LocalCueData } from './types';

// ============================================================================
// Types
// ============================================================================

export interface CuesMdFrontmatter {
  name?: string;
  domain?: string;
  version?: number;
}

/**
 * A prompt source defined as a ### subsection under ## Prompt.
 * Each source has optional classification rules and a prompt.
 */
/** How to parse the LLM response for a blank mode */
export type BlankParser = 'math' | 'compute' | 'answer' | 'alternatives' | 'raw';

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
   * words  — only when no blanks present (word alternatives)
   * blanks — only when blanks (_) present (fill-in)
   * all    — always
   * (default: inferred from context — 'words' for cues.md, 'blanks' for blanks.md)
   */
  scope?: 'words' | 'blanks' | 'all';
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

export interface BlankConfig {
  control: string;
  tip?: string;
  speak?: boolean;
  /** Context words that bind a blank (_) to this control (e.g., ['volume', 'sound']) */
  blankKeywords?: string[];
  /** Increment/decrement step size when cycling a control-bound blank */
  blankStep?: number;
  /** When true, auto-fill the blank with the current control value on analysis */
  blankAutoPopulate?: boolean;
  /** Value format: integer (default), float, or string */
  blankFormat?: 'integer' | 'float' | 'string';
  /** Tip shown when the auto-populated value is highlighted (separate from word-control tip) */
  blankTip?: string;
  /** Script for blank get/set (separate from word-control script). Defaults to `script` if not set. */
  blankScript?: string;
  /** Max words allowed between keyword and _ (0 = adjacent, undefined = no limit) */
  blankProximity?: number;
  /** If true, cycling (Up/Down) is disabled — display-only blank */
  blankReadOnly?: boolean;
  /** If true, `_` is appended as the last cycling option so the user can dismiss the value */
  blankDismissible?: boolean;
  /** Suffix appended to the displayed value (e.g. "%" shows "50%"). Stripped before arithmetic, re-appended for display. */
  blankSuffix?: string;
  /** Ordered list of values to cycle through on a control-bound blank */
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
  /** LLM model identifier for script-based LLM calls (e.g. 'openai/gpt-oss-120b') */
  model?: string;
  /** API endpoint URL for script-based LLM calls (default: Groq) */
  apiUrl?: string;
  /** Environment variable name holding the API key (default: GROQ_API_KEY) */
  apiKeyEnv?: string;
  /** Number of alternatives the script should return (default: 3) */
  altCount?: number;
  /** If true, include the original input as the last cycling alternative (default: true) */
  includeOriginal?: boolean;
  /** Named prompts parsed from ## sections in the cue.md body (e.g. { Extract: "...", Transform: "..." }) */
  prompts?: Record<string, string>;
  /**
   * Explicit host allow-list. When set, takes precedence over auto-detection.
   * Use the canonical host names: claude-code, opencode, codex, chrome.
   * See @opencues/core's `inferHostCompat()` for the resolution rules.
   */
  onHost?: string[];
  /**
   * Explicit host deny-list. Removes hosts from the auto-detected (or
   * on-host) set. Useful for marking a control as "not chrome" when the
   * auto-detection (script: extension) didn't catch it.
   */
  notOnHost?: string[];
}

export interface CuesMdConfig {
  /** Parsed YAML frontmatter */
  frontmatter: CuesMdFrontmatter;

  /** Parsed tips data from ## Tips JSON block */
  tips?: LocalCueData;

  /** Prompt configuration with per-source definitions */
  promptConfig?: PromptConfig;

  /** Cue-control definitions from ## Blanks (or ## Controls / ## Actions) JSON block */
  controls?: Record<string, BlankConfig>;

  /** Words to never suggest alternatives for from ## Ignore */
  ignore?: string[];

  /** Raw section content for unknown/extensible sections */
  sections: Record<string, string>;
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
  const v = value.trim();
  if (v.startsWith('[')) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through to comma-split */ }
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
    else if (key === 'domain') fm.domain = value;
    else if (key === 'version') fm.version = parseInt(value, 10) || undefined;
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
      if (kv.match) source.match = kv.match;
      if (kv.keywords) source.keywords = kv.keywords;
      if (kv.classify) source.classify = kv.classify;
      if (kv.priority) source.priority = parseInt(kv.priority, 10) || undefined;
      if (kv.enabled !== undefined) source.enabled = kv.enabled !== 'false';
      if (kv.prompt) source.promptPath = kv.prompt;
      if (kv.model) source.model = kv.model;
      if (kv.parser) source.parser = kv.parser as BlankParser;
      if (kv.scope) source.scope = kv.scope as 'words' | 'blanks' | 'all';
    }

    // Extract freeform text as inline prompt
    const text = extractTextOutsideCodeBlocks(sub.content);
    if (text) source.promptText = text;

    config.sources[sourceName] = source;
  }

  // If no subsections but there is content, treat entire section as grammar prompt
  if (subs.length === 0 && content.trim()) {
    const yamlBlock = extractCodeBlock(content, 'yaml');
    const text = extractTextOutsideCodeBlocks(content);
    const source: SourceConfig = { name: 'grammar' };
    if (yamlBlock) {
      const kv = parseSimpleYamlFlat(yamlBlock);
      if (kv.match) source.match = kv.match;
      if (kv.keywords) source.keywords = kv.keywords;
      if (kv.classify) source.classify = kv.classify;
      if (kv.priority) source.priority = parseInt(kv.priority, 10) || undefined;
      if (kv.model) source.model = kv.model;
      if (kv.parser) source.parser = kv.parser as BlankParser;
      if (kv.scope) source.scope = kv.scope as 'words' | 'blanks' | 'all';
    }
    if (text) source.promptText = text;
    config.sources['grammar'] = source;
  }

  return config;
}

function parseBlanksSection(content: string): Record<string, BlankConfig> | undefined {
  const jsonBlock = extractCodeBlock(content, 'json');
  if (!jsonBlock) return undefined;
  try {
    return JSON.parse(jsonBlock) as Record<string, BlankConfig>;
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
 * Parse a cues.md file content string.
 * Pure function — no I/O.
 */
export function parseCuesMd(content: string): CuesMdConfig {
  const { frontmatter, body } = parseFrontmatter(content);
  const sections = splitSections(body);

  const result: CuesMdConfig = {
    frontmatter,
    sections: {},
  };

  for (const section of sections) {
    const heading = section.heading.toLowerCase();

    switch (heading) {
      case 'tips': {
        result.tips = parseTipsSection(section.content);
        break;
      }
      case 'prompt': {
        result.promptConfig = parsePromptSection(section.content);
        break;
      }
      case 'blanks':
      case 'controls':
      case 'actions': {
        // Accept ## Blanks (preferred), ## Controls (legacy), and ## Actions
        // (older legacy) — one-version transition while user-edited .md files
        // may still carry the old headings.
        result.controls = parseBlanksSection(section.content);
        break;
      }
      case 'ignore': {
        result.ignore = parseIgnoreSection(section.content);
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
// Single cue.md parser (folder-based config)
// ============================================================================

/**
 * Extended frontmatter for individual cue.md files in folder layout.
 * Config lives in frontmatter instead of YAML code blocks.
 */
export interface SingleCueFrontmatter extends CuesMdFrontmatter {
  /** Cue type: 'prompt' (default), 'tips', or 'blank' (alias: 'control' for back-compat).
   *  'blank' identifies a `_`-triggered config in defaults/blanks/<name>/cue.md. */
  type?: 'prompt' | 'tips' | 'blank' | 'control';
  scope?: 'words' | 'blanks' | 'all';
  parser?: BlankParser;
  priority?: number;
  match?: string;
  keywords?: string;
  classify?: string;
  model?: string;
  enabled?: boolean;
  promptPath?: string;
  // Control-specific fields
  control?: string;
  tip?: string;
  speak?: boolean;
  blankKeywords?: string;
  blankStep?: number;
  blankAutoPopulate?: boolean;
  blankFormat?: 'integer' | 'float' | 'string';
  blankTip?: string;
  blankScript?: string;
  blankProximity?: number;
  blankReadOnly?: boolean;
  blankDismissible?: boolean;
  blankSuffix?: string;
  stepValues?: string[];
  blankKeywordExpansions?: Record<string, string>;
  blankSatellite?: boolean;
  blankSatelliteSeparator?: string;
  blankClearKeywords?: boolean;
  blankClearOnEdit?: boolean;
  blankConsumeContext?: boolean;
  blankConsumeAll?: boolean;
  apiUrl?: string;
  apiKeyEnv?: string;
  altCount?: number;
  includeOriginal?: boolean;
  /** Explicit host allow-list (takes precedence over auto-detection from script: extension). */
  onHost?: string[];
  /** Explicit host deny-list (filters out from the auto-detected / on-host set). */
  notOnHost?: string[];
}

/**
 * Parse extended frontmatter from a single cue.md file.
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
      case 'enabled': fm.enabled = value !== 'false'; break;
      case 'promptPath': fm.promptPath = value; break;
      case 'control': fm.control = value; break;
      case 'tip': fm.tip = value; break;
      case 'speak': fm.speak = value === 'true'; break;
      case 'blankKeywords': fm.blankKeywords = value; break;
      case 'blankStep': fm.blankStep = parseInt(value, 10) || undefined; break;
      case 'blankAutoPopulate': fm.blankAutoPopulate = value === 'true'; break;
      case 'blankFormat': fm.blankFormat = value as 'integer' | 'float' | 'string'; break;
      case 'blankTip': fm.blankTip = value; break;
      case 'blankScript': fm.blankScript = value; break;
      case 'blankProximity': fm.blankProximity = parseInt(value, 10); break;
      case 'blankReadOnly': fm.blankReadOnly = value === 'true'; break;
      case 'blankDismissible': fm.blankDismissible = value === 'true'; break;
      case 'blankSuffix': fm.blankSuffix = value; break;
      case 'stepValues': try { fm.stepValues = JSON.parse(value); } catch { /* ignore */ } break;
      case 'blankKeywordExpansions': try { fm.blankKeywordExpansions = JSON.parse(value); } catch { /* ignore */ } break;
      case 'blankSatellite': fm.blankSatellite = value === 'true'; break;
      case 'blankSatelliteSeparator': fm.blankSatelliteSeparator = value.replace(/^['"]|['"]$/g, ''); break;
      case 'blankClearKeywords': fm.blankClearKeywords = value === 'true'; break;
      case 'blankClearOnEdit': fm.blankClearOnEdit = value === 'true'; break;
      case 'blankConsumeContext': fm.blankConsumeContext = value === 'true'; break;
      case 'blankConsumeAll': fm.blankConsumeAll = value === 'true'; break;
      case 'apiUrl': case 'apiurl': fm.apiUrl = value; break;
      case 'apiKeyEnv': case 'apikeyenv': fm.apiKeyEnv = value; break;
      case 'altCount': case 'altcount': fm.altCount = parseInt(value, 10) || 3; break;
      case 'includeOriginal': case 'includeoriginal': fm.includeOriginal = value === 'true'; break;
      // Host-compat overrides. Accept both hyphenated (canonical YAML) and
      // camelCase forms. Try JSON-array first; fall back to comma-separated.
      case 'on-host': case 'onHost': fm.onHost = parseHostList(value); break;
      case 'not-on-host': case 'notOnHost': fm.notOnHost = parseHostList(value); break;
      default:
        // Dot-notation: blankKeywordExpansions.rddt: Reddit
        if (key.startsWith('blankKeywordExpansions.')) {
          const subkey = key.slice('blankKeywordExpansions.'.length).toLowerCase();
          if (!fm.blankKeywordExpansions) fm.blankKeywordExpansions = {};
          fm.blankKeywordExpansions[subkey] = value;
        }
        break;
    }
  }

  return { frontmatter: fm, body };
}

/**
 * Parse a single cue.md file (folder-based layout).
 *
 * Unlike parseCuesMd() which expects ## sections, this reads config from
 * extended frontmatter and treats the body as content (prompt text or tips JSON).
 *
 * @param content - File content string
 * @param folderPath - Absolute path to the containing folder (for resolving relative paths)
 */
export function parseSingleCueMd(content: string, folderPath: string): CuesMdConfig {
  const { frontmatter, body } = parseExtendedFrontmatter(content);
  const type = frontmatter.type || 'prompt';
  const name = frontmatter.name || 'unknown';

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

  switch (type) {
    case 'tips': {
      result.tips = parseTipsSection(body);
      break;
    }
    case 'blank':
    case 'control': {
      const control: BlankConfig = {
        control: frontmatter.control || name,
        tip: frontmatter.tip,
        speak: frontmatter.speak,
      };
      if (frontmatter.blankKeywords) {
        control.blankKeywords = frontmatter.blankKeywords.split(',').map(k => k.trim().toLowerCase());
      }
      if (frontmatter.blankStep !== undefined) control.blankStep = frontmatter.blankStep;
      if (frontmatter.blankAutoPopulate !== undefined) control.blankAutoPopulate = frontmatter.blankAutoPopulate;
      if (frontmatter.blankFormat !== undefined) control.blankFormat = frontmatter.blankFormat;
      if (frontmatter.blankTip !== undefined) control.blankTip = frontmatter.blankTip;
      if (frontmatter.blankProximity !== undefined) control.blankProximity = frontmatter.blankProximity;
      if (frontmatter.blankReadOnly !== undefined) control.blankReadOnly = frontmatter.blankReadOnly;
      if (frontmatter.blankDismissible !== undefined) control.blankDismissible = frontmatter.blankDismissible;
      if (frontmatter.blankSuffix !== undefined) control.blankSuffix = frontmatter.blankSuffix;
      if (frontmatter.stepValues !== undefined) control.stepValues = frontmatter.stepValues;
      if (frontmatter.blankKeywordExpansions !== undefined) control.blankKeywordExpansions = frontmatter.blankKeywordExpansions;
      if (frontmatter.blankSatellite !== undefined) control.blankSatellite = frontmatter.blankSatellite;
      if (frontmatter.blankSatelliteSeparator !== undefined) control.blankSatelliteSeparator = frontmatter.blankSatelliteSeparator;
      if (frontmatter.blankClearKeywords !== undefined) control.blankClearKeywords = frontmatter.blankClearKeywords;
      if (frontmatter.blankClearOnEdit !== undefined) control.blankClearOnEdit = frontmatter.blankClearOnEdit;
      if (frontmatter.blankConsumeContext !== undefined) control.blankConsumeContext = frontmatter.blankConsumeContext;
      if (frontmatter.blankConsumeAll !== undefined) control.blankConsumeAll = frontmatter.blankConsumeAll;
      if (frontmatter.model !== undefined) control.model = frontmatter.model;
      if (frontmatter.apiUrl !== undefined) control.apiUrl = frontmatter.apiUrl;
      if (frontmatter.apiKeyEnv !== undefined) control.apiKeyEnv = frontmatter.apiKeyEnv;
      if (frontmatter.altCount !== undefined) control.altCount = frontmatter.altCount;
      if (frontmatter.includeOriginal !== undefined) control.includeOriginal = frontmatter.includeOriginal;
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
      if (Object.keys(promptSections).length > 0) control.prompts = promptSections;
      // Resolve relative script paths
      if (frontmatter.blankScript) {
        control.blankScript = frontmatter.blankScript.startsWith('./')
          ? folderPath + '/' + frontmatter.blankScript.slice(2)
          : frontmatter.blankScript;
      }
      result.controls = { [control.control]: control };
      break;
    }
    default: {
      // Prompt type — frontmatter fields become SourceConfig, body is promptText
      const source: SourceConfig = { name };
      if (frontmatter.match) source.match = frontmatter.match;
      if (frontmatter.keywords) source.keywords = frontmatter.keywords;
      if (frontmatter.classify) source.classify = frontmatter.classify;
      if (frontmatter.priority) source.priority = frontmatter.priority;
      if (frontmatter.enabled !== undefined) source.enabled = frontmatter.enabled;
      if (frontmatter.model) source.model = frontmatter.model;
      if (frontmatter.parser) source.parser = frontmatter.parser;
      if (frontmatter.scope) source.scope = frontmatter.scope;

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

  if (config.controls) {
    for (const [key, control] of Object.entries(config.controls)) {
      if (!control.control) {
        errors.push(`Control "${key}" missing required "control" field`);
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

    // Warn if multiple blank modes exist but no classifier prompt
    const blankModes = sourceNames.filter(n => n !== 'classifier' && config.promptConfig!.sources[n].scope === 'blanks');
    const hasBlankParsers = sourceNames.some(n =>
      n !== 'classifier' && ['math', 'compute', 'answer'].includes(config.promptConfig!.sources[n].parser ?? '')
    );
    if ((blankModes.length > 1 || hasBlankParsers) && !sourceNames.includes('classifier')) {
      errors.push('Multiple blank modes found but no ### classifier section. Ambiguous inputs will fall to grammar instead of being routed to the correct mode. Add a ### classifier with mode examples.');
    }

    // Warn if classifier exists but has no promptText
    if (sourceNames.includes('classifier') && !config.promptConfig.sources.classifier.promptText) {
      errors.push('### classifier section exists but has no prompt text. The LLM classifier needs instructions to route ambiguous inputs.');
    }
  }

  return errors;
}
