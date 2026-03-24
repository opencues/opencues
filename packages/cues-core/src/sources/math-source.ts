/**
 * cues-core/sources/math-source.ts
 *
 * Math cue source - computes mathematical expressions.
 * Returns computed values for fill-in-the-blank math problems.
 */

import {
  CueSource,
  CueContext,
  CueSourceResult,
  CueResult,
  HttpAdapter,
} from '../types';
import { MATH_PROMPT } from '../prompts';

export interface MathSourceConfig {
  /** Source ID (default: 'math') */
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
}

/**
 * Math source for computing expressions.
 */
export class MathSource implements CueSource {
  readonly id: string;
  readonly priority: number;
  private config: MathSourceConfig;

  constructor(config: MathSourceConfig) {
    this.id = config.id || 'math';
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

      // Call LLM to get COMPUTE=expression
      const prompt = MATH_PROMPT + context.text.replace(/_/g, 'BLANK');
      const response = await this.callLLM(prompt);

      // Parse COMPUTE=expression
      const expression = this.parseComputeResponse(response);
      if (!expression) {
        return {
          results: [],
          error: 'Failed to parse COMPUTE response',
          timing: Date.now() - startTime,
        };
      }

      // Evaluate the expression
      const value = this.evaluate(expression);
      if (value === null) {
        return {
          results: [],
          error: `Failed to evaluate: ${expression}`,
          timing: Date.now() - startTime,
        };
      }

      // Format result
      const formatted = this.formatNumber(value);

      // Create result for each blank
      const results: CueResult[] = blankIndices.map((index) => ({
        wordIndex: index,
        word: '_',
        alternatives: [formatted],
        source: this.id,
        priority: this.priority,
        metadata: { expression, computed: value },
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

  private parseComputeResponse(response: string): string | null {
    // Match COMPUTE=...
    const match = response.match(/COMPUTE\s*=\s*(.+)/i);
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  /**
   * Safely evaluate a math expression.
   * Only allows numbers, operators, and parentheses.
   */
  evaluate(expression: string): number | null {
    try {
      // If it's already a number, return it
      const directNum = parseFloat(expression);
      if (!isNaN(directNum) && expression.match(/^-?\d+\.?\d*$/)) {
        return directNum;
      }

      // Validate expression - only allow safe characters
      const sanitized = expression.replace(/\s/g, '');
      if (!/^[\d+\-*/().%*]+$/.test(sanitized)) {
        // Contains unsafe characters - might be a direct answer
        const numMatch = expression.match(/-?\d+\.?\d*/);
        if (numMatch) {
          return parseFloat(numMatch[0]);
        }
        return null;
      }

      // Use Function constructor for safe eval (no access to global scope)
      // eslint-disable-next-line no-new-func
      const result = new Function(`return (${sanitized})`)();

      if (typeof result === 'number' && !isNaN(result) && isFinite(result)) {
        return result;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Format number for display.
   */
  private formatNumber(value: number): string {
    // Round to reasonable precision
    if (Number.isInteger(value)) {
      return value.toString();
    }

    // For decimals, use up to 4 decimal places
    const rounded = Math.round(value * 10000) / 10000;
    return rounded.toString();
  }
}

/**
 * Standalone math evaluator (no LLM needed).
 * Use this when you already have the expression.
 */
export function evaluateMath(expression: string): number | null {
  const source = new MathSource({
    httpAdapter: { post: async () => '' },
    endpoint: '',
    apiKey: '',
    model: '',
  });
  return source.evaluate(expression);
}
