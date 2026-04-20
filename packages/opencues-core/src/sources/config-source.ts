/**
 * opencues-core/sources/config-source.ts
 *
 * Generic config-driven CueSource. Each ### section in a .md file
 * (cues.md, blanks.md) becomes one ConfigSource instance.
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
import { parseMath, parseCompute, parseAnswer, parseAlternatives, parseRaw } from './parsers';

// ============================================================================
// Types
// ============================================================================

export interface ConfigSourceOptions {
  /** Parsed source config from a .md file ### section */
  sourceConfig: SourceConfig;
  /** HTTP adapter for LLM requests */
  httpAdapter: HttpAdapter;
  /** API endpoint */
  endpoint: string;
  /** API key */
  apiKey: string;
  /** Default model (used when sourceConfig.model is not set) */
  defaultModel: string;
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
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.model = cfg.model ?? opts.defaultModel;

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
      const fullPrompt = promptText.trimEnd() + separator + input;

      const shortResponse = this.parser === 'math' || this.parser === 'compute' || this.parser === 'answer';
      const maxTokens = shortResponse ? 200 : 800;
      const temperature = shortResponse ? 0.1 : 0.3;

      const body = JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: fullPrompt }],
        max_tokens: maxTokens,
        temperature,
        // Groq reasoning models (e.g. openai/gpt-oss-120b) burn tokens on internal
        // reasoning. Without this, max_tokens goes to reasoning and content is empty.
        // Non-Groq providers ignore this field.
        reasoning_effort: 'low',
      });
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      };
      const response = await this.httpAdapter.post(this.endpoint, body, headers);
      const data = JSON.parse(response);
      const raw = data.choices?.[0]?.message?.content || '';

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
    // math/compute/answer/raw: send text with _ replaced by BLANK
    return context.text.replace(/_/g, 'BLANK');
  }

  private parseResponse(response: string, words: string[]): CueResult[] {
    switch (this.parser) {
      case 'math': {
        const alts = parseMath(response);
        if (!alts.length) return [];
        const blankIdx = words.indexOf('_');
        if (blankIdx < 0) return [];
        return [{ wordIndex: blankIdx, word: '_', alternatives: ['_', ...alts], source: this.id, priority: this.priority }];
      }
      case 'compute': {
        const alts = parseCompute(response);
        if (!alts.length) return [];
        const blankIdx = words.indexOf('_');
        if (blankIdx < 0) return [];
        return [{ wordIndex: blankIdx, word: '_', alternatives: ['_', ...alts], source: this.id, priority: this.priority }];
      }
      case 'answer': {
        const alts = parseAnswer(response);
        if (!alts.length) return [];
        const blankIdx = words.indexOf('_');
        if (blankIdx < 0) return [];
        return [{ wordIndex: blankIdx, word: '_', alternatives: ['_', ...alts], source: this.id, priority: this.priority }];
      }
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
