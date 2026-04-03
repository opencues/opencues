/**
 * cues-core/cues-md.ts
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
export type BlankParser = 'compute' | 'answer' | 'alternatives' | 'raw';

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

export interface ActionConfig {
  action: string;
  tip?: string;
  script?: string;
  upArgs?: string[];
  downArgs?: string[];
}

export interface CuesMdConfig {
  /** Parsed YAML frontmatter */
  frontmatter: CuesMdFrontmatter;

  /** Parsed tips data from ## Tips JSON block */
  tips?: LocalCueData;

  /** Prompt configuration with per-source definitions */
  promptConfig?: PromptConfig;

  /** Cue-action definitions from ## Actions JSON block */
  actions?: Record<string, ActionConfig>;

  /** Words to never suggest alternatives for from ## Ignore */
  ignore?: string[];

  /** Raw section content for unknown/extensible sections */
  sections: Record<string, string>;
}

// ============================================================================
// Frontmatter parsing
// ============================================================================

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

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
    }
    if (text) source.promptText = text;
    config.sources['grammar'] = source;
  }

  return config;
}

function parseActionsSection(content: string): Record<string, ActionConfig> | undefined {
  const jsonBlock = extractCodeBlock(content, 'json');
  if (!jsonBlock) return undefined;
  try {
    return JSON.parse(jsonBlock) as Record<string, ActionConfig>;
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
      case 'actions': {
        result.actions = parseActionsSection(section.content);
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

  if (config.actions) {
    for (const [key, action] of Object.entries(config.actions)) {
      if (!action.action) {
        errors.push(`Action "${key}" missing required "action" field`);
      }
    }
  }

  if (config.promptConfig) {
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
