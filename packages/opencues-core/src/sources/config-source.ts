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
import type { ProviderAdapter } from '../llm-provider';

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
  readonly scope: 'words' | 'blanks' | 'all';

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
      // Defensive: for parser: alternatives, ensure the prompt ends with
      // the INDEX:alt1,alt2,alt3 format spec. Without this, a prompt that
      // instructs the LLM on content but forgets to constrain the output
      // shape gets interpreted as "write a reference essay" — classic
      // failure mode for domain cues authored naively. See
      // docs/features/word-cue-routing.md § OUTPUT FORMAT.
      const ensuredPrompt = this.parser === 'alternatives' && !hasFormatSpec(promptText)
        ? `${promptText.trimEnd()}\n\n${ALT_FORMAT_SPEC}`
        : promptText.trimEnd();
      const fullPrompt = ensuredPrompt + separator + input;

      const built = this.provider.buildRequest(
        {
          model: this.model,
          messages: [{ role: 'user', content: fullPrompt }],
          maxTokens: 800,
          temperature: 0.3,
          // Provider adapter passes this through only to providers that
          // honor it (Groq); ignored by Gemini/OpenRouter/OpenAI.
          reasoningEffort: 'low',
        },
        { apiKey: this.apiKey, endpoint: this.endpoint },
      );
      const response = await this.httpAdapter.post(built.url, built.body, built.headers);
      const raw = this.provider.parseResponse(response);

      const results = this.parseResponse(raw, context.words);
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
}
