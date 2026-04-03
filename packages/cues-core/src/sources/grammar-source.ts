/**
 * cues-core/sources/grammar-source.ts
 *
 * Grammar cue source - provides word alternatives.
 * Handles both regular words (synonyms) and blanks (fill-in).
 */

import {
  CueSource,
  CueContext,
  CueSourceResult,
  CueResult,
  HttpAdapter,
} from '../types';
import { GRAMMAR_PROMPT, BLANK_GRAMMAR_PROMPT } from '../prompts';

export interface GrammarSourceConfig {
  /** Source ID (default: 'grammar') */
  id?: string;

  /** Priority (default: 50, lower than tips/math/factual) */
  priority?: number;

  /** HTTP adapter for LLM requests */
  httpAdapter: HttpAdapter;

  /** API endpoint */
  endpoint: string;

  /** API key */
  apiKey: string;

  /** Model name */
  model: string;

  /** Request timeout in ms */
  timeout?: number;

  /** Additional prompt instructions (from cues.md) */
  promptSuffix?: string;
}

/**
 * Grammar source for word alternatives.
 */
export class GrammarSource implements CueSource {
  readonly id: string;
  readonly priority: number;
  private config: GrammarSourceConfig;

  constructor(config: GrammarSourceConfig) {
    this.id = config.id || 'grammar';
    this.priority = config.priority ?? 50;
    this.config = config;
  }

  supports(context: CueContext): boolean {
    // Supports any context (fallback source)
    return true;
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();

    try {
      const hasBlanks = context.words.some((w) => w === '_');

      // Choose prompt based on whether we have blanks
      const prompt = hasBlanks
        ? this.buildBlankPrompt(context)
        : this.buildWordPrompt(context);

      const response = await this.callLLM(prompt);

      // Parse INDEX:alts format
      const results = this.parseResponse(response, context.words);

      return {
        results,
        timing: Date.now() - startTime,
      };
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : String(error),
        timing: Date.now() - startTime,
      };
    }
  }

  private buildWordPrompt(context: CueContext): string {
    // Format: 0=word1 1=word2 2=word3
    // Numbers are converted to word form (3→"three") to preserve context for
    // surrounding words. parseResponse filters out results for number positions
    // since digit cycling is handled natively by the word highlight system.
    const isNumber = /^-?\d+(\.\d+)?$/;
    const numToWord = (n: string): string => {
      const small = ['zero','one','two','three','four','five','six','seven','eight','nine','ten',
        'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty'];
      const i = parseInt(n, 10);
      return (i >= 0 && i <= 20) ? small[i] : n;
    };
    const indexed = context.words
      .map((w, i) => `${i}=${isNumber.test(w) ? numToWord(w) : w}`)
      .join(' ');
    const suffix = this.config.promptSuffix
      ? '\n\nAdditional instructions:\n' + this.config.promptSuffix
      : '';
    return GRAMMAR_PROMPT + suffix + '\n' + indexed;
  }

  private buildBlankPrompt(context: CueContext): string {
    // Format: 0=word1 1=_ 2=word3
    const indexed = context.words
      .map((w, i) => `${i}=${w}`)
      .join(' ');
    return BLANK_GRAMMAR_PROMPT + indexed;
  }

  private async callLLM(prompt: string): Promise<string> {
    const body = JSON.stringify({
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.3,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    const response = await this.config.httpAdapter.post(
      this.config.endpoint,
      body,
      headers
    );

    const data = JSON.parse(response);
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Parse INDEX:alt1,alt2,alt3 format.
   */
  private parseResponse(response: string, words: string[]): CueResult[] {
    const results: CueResult[] = [];

    // Match patterns like "1:big,small,brown" or "1=big,small,brown"
    const pattern = /(\d+)\s*[:=]\s*([^|\n]+)/g;
    let match;

    while ((match = pattern.exec(response)) !== null) {
      const index = parseInt(match[1], 10);
      const altsStr = match[2].trim();

      // Split alternatives by comma
      const alts = altsStr
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a.length > 0);

      if (alts.length === 0 || index >= words.length) {
        continue;
      }

      // Get original word
      const originalWord = words[index];

      // Skip numbers — digit cycling is handled natively by the word highlight system.
      // buildWordPrompt sends the word form ("three") for context but we discard results here.
      if (/^-?\d+(\.\d+)?$/.test(originalWord)) {
        continue;
      }

      // For blanks, don't include the original
      // For regular words, include original as first alt
      const alternatives =
        originalWord === '_' ? alts : [originalWord, ...alts];

      results.push({
        wordIndex: index,
        word: originalWord,
        alternatives,
        source: this.id,
        priority: this.priority,
      });
    }

    return results;
  }
}
