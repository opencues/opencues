/**
 * cues-core/sources/llm-base.ts
 *
 * Base class for LLM-based cue sources.
 * Concrete implementations (Groq, Gemini) extend this.
 */

import {
  CueSource,
  CueContext,
  CueSourceResult,
  CueResult,
  HttpAdapter,
} from '../types';

/**
 * Response format expected from LLM.
 */
export interface LLMWordResponse {
  index: number;
  word: string;
  alts: string[] | null;
  linked?: number[] | null;
  tip?: string;
}

export interface LLMResponse {
  words: LLMWordResponse[];
  _model?: string;
  _tokens?: { in: number; out: number };
}

/**
 * Configuration for LLM source.
 */
export interface LLMSourceConfig {
  /** Source ID */
  id: string;

  /** Priority (default: 50, lower than tips) */
  priority?: number;

  /** API endpoint URL */
  endpoint: string;

  /** API key */
  apiKey: string;

  /** Model name */
  model: string;

  /** System prompt for the LLM */
  systemPrompt: string;

  /** Request timeout in ms */
  timeout?: number;

  /** HTTP adapter for making requests */
  httpAdapter: HttpAdapter;
}

/**
 * Modes that affect the system prompt used.
 */
export type LLMMode = 'grammar' | 'blank_grammar' | 'math' | 'factual';

/**
 * Abstract base class for LLM cue sources.
 */
export abstract class LLMSourceBase implements CueSource {
  readonly id: string;
  readonly priority: number;
  protected config: LLMSourceConfig;

  constructor(config: LLMSourceConfig) {
    this.id = config.id;
    this.priority = config.priority ?? 50;
    this.config = config;
  }

  /**
   * Check if this source supports the given context.
   * LLM sources support contexts that tips didn't fully cover.
   */
  supports(context: CueContext): boolean {
    // Always supports - LLM is the fallback for non-tips words
    return true;
  }

  /**
   * Determine which mode to use based on context.
   */
  protected determineMode(context: CueContext): LLMMode {
    // Check for blanks (underscores)
    const hasBlanks = context.words.some((w) => w === '_');
    if (hasBlanks) {
      // Would need to run classifier for blank mode
      return 'blank_grammar';
    }
    return 'grammar';
  }

  /**
   * Build the prompt to send to the LLM.
   */
  protected abstract buildPrompt(context: CueContext, mode: LLMMode): string;

  /**
   * Parse the LLM response into structured data.
   */
  protected parseResponse(responseText: string): LLMResponse | null {
    try {
      // Try to parse as JSON
      const data = JSON.parse(responseText);
      if (data.words && Array.isArray(data.words)) {
        return data as LLMResponse;
      }
      return null;
    } catch {
      // Try to extract JSON from response (LLM might add extra text)
      const jsonMatch = responseText.match(/\{[\s\S]*"words"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]) as LLMResponse;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /**
   * Convert LLM response to CueResults.
   */
  protected toResults(
    response: LLMResponse,
    context: CueContext
  ): CueResult[] {
    const results: CueResult[] = [];

    for (const wordResult of response.words) {
      if (!wordResult.alts || wordResult.alts.length <= 1) {
        continue; // No alternatives
      }

      results.push({
        wordIndex: wordResult.index,
        word: wordResult.word,
        alternatives: wordResult.alts,
        linked: wordResult.linked || undefined,
        tip: wordResult.tip,
        source: this.id,
        priority: this.priority,
      });
    }

    return results;
  }

  /**
   * Build HTTP request headers.
   */
  protected abstract buildHeaders(): Record<string, string>;

  /**
   * Build HTTP request body.
   */
  protected abstract buildBody(prompt: string): string;

  /**
   * Get cues from the LLM.
   */
  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();

    try {
      const mode = this.determineMode(context);
      const prompt = this.buildPrompt(context, mode);
      const headers = this.buildHeaders();
      const body = this.buildBody(prompt);

      const responseText = await this.config.httpAdapter.post(
        this.config.endpoint,
        body,
        headers
      );

      const parsed = this.parseResponse(responseText);
      if (!parsed) {
        return {
          results: [],
          error: 'Failed to parse LLM response',
          timing: Date.now() - startTime,
        };
      }

      const results = this.toResults(parsed, context);

      return {
        results,
        timing: Date.now() - startTime,
        model: parsed._model || this.config.model,
        tokens: parsed._tokens,
      };
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : String(error),
        timing: Date.now() - startTime,
      };
    }
  }
}

/**
 * Groq LLM source implementation.
 */
export class GroqSource extends LLMSourceBase {
  constructor(config: Omit<LLMSourceConfig, 'endpoint' | 'id'> & { id?: string }) {
    super({
      ...config,
      id: config.id || 'groq',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    });
  }

  protected buildPrompt(context: CueContext, mode: LLMMode): string {
    // Use the system prompt from config
    const systemPrompt = this.config.systemPrompt;
    return `${systemPrompt}\n\nInput: ${context.text}`;
  }

  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  protected buildBody(prompt: string): string {
    return JSON.stringify({
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1024,
    });
  }
}

/**
 * Gemini LLM source implementation.
 */
export class GeminiSource extends LLMSourceBase {
  constructor(
    config: Omit<LLMSourceConfig, 'endpoint' | 'id'> & { id?: string }
  ) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
    super({
      ...config,
      id: config.id || 'gemini',
      endpoint,
    });
  }

  protected buildPrompt(context: CueContext, mode: LLMMode): string {
    const systemPrompt = this.config.systemPrompt;
    return `${systemPrompt}\n\nInput: ${context.text}`;
  }

  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
    };
  }

  protected buildBody(prompt: string): string {
    return JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
      },
    });
  }

  protected parseResponse(responseText: string): LLMResponse | null {
    try {
      const data = JSON.parse(responseText);
      // Gemini wraps response differently
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        return super.parseResponse(text);
      }
      return null;
    } catch {
      return null;
    }
  }
}
