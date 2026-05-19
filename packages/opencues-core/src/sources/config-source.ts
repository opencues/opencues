/**
 * opencues-core/sources/config-source.ts
 *
 * Generic config-driven CueSource. Each ### section in a .md file
 * (CUES.md, BLANKS.md) becomes one ConfigSource instance.
 * All behavior is driven by SourceConfig — no hardcoded prompts or logic.
 */

import {
  CueSource,
  CueContext,
  CueSourceResult,
  CueResult,
  HttpAdapter,
} from '../types';
import { SourceConfig, BlankParser } from '../cues-md';
import { parseAlternatives, parseRaw } from './parsers';
import { useStrictJson, buildJsonResponseFormat, type ProviderAdapter } from '../llm-provider';

/**
 * The canonical output-format reminder for `parser: alternatives`
 * sources. Auto-appended by getCues when the prompt doesn't already
 * contain a format spec — cue authors don't need to remember it, and
 * the system stays robust against naive prompts that would otherwise
 * cause the LLM to respond in prose.
 */
const ALT_FORMAT_SPEC = 'Output ONLY index:alternatives format (e.g. 1:alt1,alt2,alt3). No prose, tables, or markdown.';

/** Does the prompt already tell the LLM to output INDEX:alt form?
 *  Matches the canonical shape only — "INDEX:alt" in any case, with
 *  optional whitespace around the colon. A bare "INDEX:foo" is NOT
 *  the contract and gets auto-replaced with the canonical reminder. */
function hasFormatSpec(prompt: string): boolean {
  return /index\s*:\s*alt/i.test(prompt);
}

// ============================================================================
// Types
// ============================================================================

export interface ConfigSourceOptions {
  /** Parsed source config from a .md file ### section */
  sourceConfig: SourceConfig;
  /** HTTP adapter for LLM requests */
  httpAdapter: HttpAdapter;
  /** Resolved provider adapter for this source. */
  provider: ProviderAdapter;
  /** Resolved endpoint URL. */
  endpoint: string;
  /** Resolved API key (matches provider.envKeyName). */
  apiKey: string;
  /** Resolved model identifier. */
  model: string;
}

// ============================================================================
// Helpers
// ============================================================================

const NUM_PATTERN = /^-?\d+(\.\d+)?$/;
const SMALL_NUMBERS = [
  'zero','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty',
];

function numToWord(n: string): string {
  const i = parseInt(n, 10);
  return (i >= 0 && i <= 20) ? SMALL_NUMBERS[i] : n;
}

// ============================================================================
// ConfigSource
// ============================================================================

export class ConfigSource implements CueSource {
  readonly id: string;
  readonly priority: number;
  readonly scope: 'words' | 'blanks' | 'sentence' | 'all';
  /** Word-cues + alternatives sources are always cycleable — they
   *  present alternatives the user picks between. Hosts without a
   *  cycling surface drop these at registration. */
  readonly isCycleable = true;

  /** Source configuration from .md file (exposed for ClassifiedSourceGroup) */
  readonly sourceConfig: SourceConfig;
  private parser: BlankParser;
  private httpAdapter: HttpAdapter;
  private provider: ProviderAdapter;
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private matchRe?: RegExp;

  constructor(opts: ConfigSourceOptions) {
    const cfg = opts.sourceConfig;
    this.id = cfg.name;
    this.priority = cfg.priority ?? 50;
    this.sourceConfig = cfg;
    this.parser = cfg.parser ?? 'alternatives';
    this.scope = cfg.scope ?? 'words';
    this.httpAdapter = opts.httpAdapter;
    this.provider = opts.provider;
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.model = opts.model;

    if (cfg.match) {
      try { this.matchRe = new RegExp(cfg.match, 'i'); } catch { /* invalid regex */ }
    }
  }

  supports(context: CueContext): boolean {
    const hasBlanks = context.words.some(w => w === '_');
    if (this.scope === 'words') return !hasBlanks;
    if (this.scope === 'blanks') return hasBlanks;
    return true; // 'all'
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();
    const promptText = this.sourceConfig.promptText;
    if (!promptText) {
      return { results: [], timing: Date.now() - startTime };
    }

    try {
      const input = this.formatInput(context);
      const separator = this.parser === 'alternatives' ? '\n' : ' ';
      // Strict JSON mode on groq gpt-oss skips the INDEX:alt1,alt2,alt3
      // format-spec append; the schema enforces shape instead.
      const useJson = useStrictJson(this.provider.id, this.model);

      // Defensive: for parser: alternatives, ensure the prompt ends with
      // the INDEX:alt1,alt2,alt3 format spec. Without this, a prompt that
      // instructs the LLM on content but forgets to constrain the output
      // shape gets interpreted as "write a reference essay" — classic
      // failure mode for domain cues authored naively. See
      // docs/features/word-cue-routing.md § OUTPUT FORMAT.
      const ensuredPrompt = !useJson && this.parser === 'alternatives' && !hasFormatSpec(promptText)
        ? `${promptText.trimEnd()}\n\n${ALT_FORMAT_SPEC}`
        : promptText.trimEnd();
      const fullPrompt = ensuredPrompt + separator + input;

      const built = this.provider.buildRequest(
        {
          model: this.model,
          messages: [{ role: 'user', content: fullPrompt }],
          // Per-source overrides via SourceConfig frontmatter — when
          // absent the bench-tuned defaults (800 / 0.3) hold.
          maxTokens: this.sourceConfig.maxTokens ?? 800,
          temperature: this.sourceConfig.temperature ?? 0.3,
          // reasoningEffort omitted — provider adapter applies its
          // bench-derived default (see ProviderAdapter.defaultReasoningEffort
          // in @opencues/core/llm-provider.ts). Honored by groq /
          // cerebras / openai / openrouter on reasoning models;
          // ignored by gemini / anthropic.
          responseFormat: useJson
            ? buildJsonResponseFormat(
                this.parser === 'alternatives' ? 'word_cues_alts' : 'word_cues_raw',
                this.parser === 'alternatives' ? WORD_CUES_ALTS_SCHEMA : WORD_CUES_RAW_SCHEMA,
              )
            : undefined,
        },
        { apiKey: this.apiKey, endpoint: this.endpoint },
      );
      const response = await this.httpAdapter.post(built.url, built.body, built.headers);
      const raw = this.provider.parseResponse(response);

      const results = useJson
        ? this.parseJsonResponse(raw, context.words)
        : this.parseResponse(raw, context.words);
      return { results, timing: Date.now() - startTime, model: this.model };
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : String(error),
        timing: Date.now() - startTime,
      };
    }
  }

  private formatInput(context: CueContext): string {
    if (this.parser === 'alternatives') {
      // Indexed format: 0=word1 1=word2
      // For words scope, convert numbers to word form for better LLM context
      if (this.scope === 'words') {
        return context.words
          .map((w, i) => `${i}=${NUM_PATTERN.test(w) ? numToWord(w) : w}`)
          .join(' ');
      }
      return context.words.map((w, i) => `${i}=${w}`).join(' ');
    }
    // raw parser: send text with _ replaced by BLANK
    return context.text.replace(/_/g, 'BLANK');
  }

  private parseResponse(response: string, words: string[]): CueResult[] {
    switch (this.parser) {
      case 'alternatives': {
        const results = parseAlternatives(response, words);
        results.forEach(r => { r.source = this.id; r.priority = this.priority; });
        return results;
      }
      case 'raw': {
        const alts = parseRaw(response);
        if (!alts.length) return [];
        const blankIdx = words.indexOf('_');
        if (blankIdx < 0) return [];
        return [{ wordIndex: blankIdx, word: '_', alternatives: ['_', ...alts], source: this.id, priority: this.priority }];
      }
      default:
        return [];
    }
  }

  /** JSON parser — strict mode on groq gpt-oss. Mirrors parseResponse
   *  but consumes the structured `{ alternatives: ... }` shape instead
   *  of the legacy INDEX:alts text format. */
  private parseJsonResponse(response: string, words: string[]): CueResult[] {
    let obj: { alternatives?: unknown };
    try {
      obj = JSON.parse(response.trim()) as { alternatives?: unknown };
    } catch {
      return [];
    }
    if (this.parser === 'alternatives') {
      if (!Array.isArray(obj.alternatives)) return [];
      const results: CueResult[] = [];
      for (const item of obj.alternatives as Array<{ index?: unknown; alts?: unknown }>) {
        if (typeof item?.index !== 'number') continue;
        if (!Array.isArray(item.alts)) continue;
        const idx = item.index;
        if (idx < 0 || idx >= words.length) continue;
        const word = words[idx];
        if (!word || word === '_') continue;
        const cleanAlts = (item.alts as unknown[])
          .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
          .map(a => a.trim())
          .filter(a => a !== word);
        if (cleanAlts.length === 0) continue;
        results.push({
          wordIndex: idx,
          word,
          alternatives: [word, ...cleanAlts],
          source: this.id,
          priority: this.priority,
        });
      }
      return results;
    }
    // raw parser
    if (!Array.isArray(obj.alternatives)) return [];
    const alts = (obj.alternatives as unknown[])
      .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      .map(a => a.trim());
    if (!alts.length) return [];
    const blankIdx = words.indexOf('_');
    if (blankIdx < 0) return [];
    return [{ wordIndex: blankIdx, word: '_', alternatives: ['_', ...alts], source: this.id, priority: this.priority }];
  }
}

// Schemas for strict JSON mode (groq gpt-oss).

const WORD_CUES_ALTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          alts: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'alts'],
        additionalProperties: false,
      },
    },
  },
  required: ['alternatives'],
  additionalProperties: false,
};

const WORD_CUES_RAW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { alternatives: { type: 'array', items: { type: 'string' } } },
  required: ['alternatives'],
  additionalProperties: false,
};
