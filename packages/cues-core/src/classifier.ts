/**
 * cues-core/classifier.ts
 *
 * Mode classifier for determining MATH, FACTUAL, or GRAMMAR mode.
 * Only runs for inputs containing blanks (_).
 */

import { HttpAdapter } from './types';
import { CLASSIFIER_PROMPT } from './prompts';

export type CueMode = 'math' | 'factual' | 'grammar';

export interface ClassifierConfig {
  /** HTTP adapter for making requests */
  httpAdapter: HttpAdapter;

  /** API endpoint */
  endpoint: string;

  /** API key */
  apiKey: string;

  /** Model name */
  model: string;

  /** Request timeout in ms (default: 10000) */
  timeout?: number;
}

export interface ClassifierResult {
  mode: CueMode;
  timing: number;
  raw?: string;
}

/**
 * Classify input text to determine which mode to use.
 * Only call this for inputs containing blanks (_).
 */
export class ModeClassifier {
  private config: ClassifierConfig;

  constructor(config: ClassifierConfig) {
    this.config = config;
  }

  /**
   * Classify the input text.
   * Returns 'math', 'factual', or 'grammar'.
   */
  async classify(text: string): Promise<ClassifierResult> {
    const startTime = Date.now();

    const prompt = CLASSIFIER_PROMPT + text;

    try {
      const response = await this.callLLM(prompt);
      const mode = this.parseResponse(response);

      return {
        mode,
        timing: Date.now() - startTime,
        raw: response,
      };
    } catch (error) {
      // Default to grammar on error
      return {
        mode: 'grammar',
        timing: Date.now() - startTime,
      };
    }
  }

  private async callLLM(prompt: string): Promise<string> {
    const body = JSON.stringify({
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 50,
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

    // Parse OpenAI-style response
    const data = JSON.parse(response);
    return data.choices?.[0]?.message?.content || '';
  }

  private parseResponse(response: string): CueMode {
    const upper = response.toUpperCase();

    if (upper.includes('MODE=MATH') || upper.includes('MATH')) {
      return 'math';
    }
    if (upper.includes('MODE=FACTUAL') || upper.includes('FACTUAL')) {
      return 'factual';
    }

    return 'grammar';
  }
}

/**
 * Quick heuristic check for math-like input (no LLM needed).
 * Returns true if input looks like math.
 */
export function looksLikeMath(text: string): boolean {
  // Contains operators and numbers
  if (/\d+\s*[+\-*/^%]\s*\d+/.test(text)) return true;

  // Contains percentage pattern (50% of, 20% tax, etc.)
  if (/\d+%/.test(text)) return true;

  // Contains math keywords
  const mathKeywords = [
    'factorial',
    'percent',
    'average',
    'sum of',
    'half of',
    'double',
    'triple',
    'square root',
    'sqrt',
    'power of',
    'celsius',
    'fahrenheit',
    'mph',
    'km/h',
    'tip',
    'tax',
    'discount',
    'split',
    'divide',
    'multiply',
    'mod',
    'remainder',
    'gcd',
    'lcm',
    'log',
    'sine',
    'cosine',
    'floor',
    'ceiling',
    'round',
  ];

  const lower = text.toLowerCase();
  return mathKeywords.some((kw) => lower.includes(kw));
}

/**
 * Quick heuristic check for factual input (no LLM needed).
 * Returns true if input looks like a factual question.
 */
export function looksLikeFactual(text: string): boolean {
  const lower = text.toLowerCase();

  // Common factual patterns
  const factualPatterns = [
    /the .+ of .+ is/,
    /who (is|was|invented|wrote|painted|composed)/,
    /what is the .+ of/,
    /when (did|was)/,
    /where is/,
    /capital of/,
    /ceo of/,
    /founder of/,
    /author of/,
    /president of/,
    /chemical symbol/,
    /atomic number/,
    /boils at/,
    /freezes at/,
    /speed of light/,
    /largest (ocean|planet|desert|continent)/,
    /tallest (mountain|building)/,
    /longest (river|bridge)/,
  ];

  return factualPatterns.some((pattern) => pattern.test(lower));
}
