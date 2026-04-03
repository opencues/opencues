/**
 * cues-core/sources/factual-source.ts
 *
 * Factual cue source - answers knowledge questions.
 * Returns factual answers for fill-in-the-blank questions.
 */

import {
  CueSource,
  CueContext,
  CueSourceResult,
  CueResult,
  HttpAdapter,
} from '../types';
import { FACTUAL_PROMPT } from '../prompts';

export interface FactualSourceConfig {
  /** Source ID (default: 'factual') */
  id?: string;

  /** Priority (default: 90, higher than grammar) */
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

  /** Custom prompt override (from blanks.md ## Prompt ### factual) */
  prompt?: string;
}

/**
 * Factual source for answering knowledge questions.
 */
export class FactualSource implements CueSource {
  readonly id: string;
  readonly priority: number;
  private config: FactualSourceConfig;

  constructor(config: FactualSourceConfig) {
    this.id = config.id || 'factual';
    this.priority = config.priority ?? 90;
    this.config = config;
  }

  supports(context: CueContext): boolean {
    // Only supports contexts with blanks
    return context.words.some((w) => w === '_');
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();

    try {
      // Find blank indices
      const blankIndices = context.words
        .map((w, i) => (w === '_' ? i : -1))
        .filter((i) => i >= 0);

      if (blankIndices.length === 0) {
        return { results: [], timing: Date.now() - startTime };
      }

      // Call LLM to get ANSWER=value
      const basePrompt = (this.config.prompt || FACTUAL_PROMPT).trimEnd() + ' ';
      const prompt = basePrompt + context.text.replace(/_/g, 'BLANK');
      const response = await this.callLLM(prompt);

      // Parse ANSWER=value
      const answer = this.parseAnswerResponse(response);
      if (!answer) {
        return {
          results: [],
          error: 'Failed to parse ANSWER response',
          timing: Date.now() - startTime,
        };
      }

      // Create result for each blank
      // Multi-word answers become span alternatives
      const answerWords = answer.split(/\s+/);
      const results: CueResult[] = blankIndices.map((index) => ({
        wordIndex: index,
        word: '_',
        alternatives: [answer],
        source: this.id,
        priority: this.priority,
        // If multi-word, mark as span
        ...(answerWords.length > 1 && {
          spanStart: index,
          spanEnd: index + answerWords.length,
        }),
      }));

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

  private async callLLM(prompt: string): Promise<string> {
    const body = JSON.stringify({
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
      temperature: 0.1,
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

  private parseAnswerResponse(response: string): string | null {
    // Match ANSWER=...
    const match = response.match(/ANSWER\s*=\s*(.+)/i);
    if (match) {
      return match[1].trim();
    }

    // Try to extract any reasonable answer
    const cleaned = response.trim();
    if (cleaned && cleaned.length < 100) {
      return cleaned;
    }

    return null;
  }
}
