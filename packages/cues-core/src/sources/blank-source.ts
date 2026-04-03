/**
 * cues-core/sources/blank-source.ts
 *
 * Generic blank fill-in source driven entirely by blanks.md config.
 * Replaces the hardcoded MathSource, FactualSource, and blank path of GrammarSource.
 *
 * Each mode defined in blanks.md ## Prompt becomes a BlankMode with:
 *   - match/keywords for fast pre-LLM classification
 *   - a prompt sent to the LLM
 *   - a parser that extracts the answer from the LLM response
 */

import {
  CueSource,
  CueContext,
  CueSourceResult,
  CueResult,
  HttpAdapter,
} from '../types';
import { SourceConfig, BlankParser } from '../cues-md';

// ============================================================================
// Parsers
// ============================================================================

function parseCompute(response: string): string[] {
  const match = response.match(/COMPUTE\s*=\s*([^\n]+)/i);
  if (!match) return [];
  const expr = match[1].trim();
  try {
    const safe = expr.replace(/[^0-9+\-*/().%\s]/g, '');
    if (!safe.trim()) return [];
    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + safe + ')')();
    if (typeof result !== 'number' || !isFinite(result)) return [];
    const rounded = Math.round(result * 10000) / 10000;
    return [String(rounded % 1 === 0 ? Math.round(rounded) : rounded)];
  } catch {
    return [];
  }
}

function parseAnswer(response: string): string[] {
  const match = response.match(/ANSWER\s*=\s*([^\n]+)/i);
  if (!match) return [];
  const value = match[1].trim();
  if (!value || value.length > 100) return [];
  return [value];
}

function parseAlternatives(response: string, words: string[]): CueResult[] {
  const results: CueResult[] = [];
  const pattern = /(\d+)\s*[:=]\s*([^|\n]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(response)) !== null) {
    const index = parseInt(match[1], 10);
    const alts = match[2].trim().split(',').map(a => a.trim()).filter(a => a.length > 0);
    if (alts.length === 0 || index >= words.length) continue;
    const original = words[index];
    if (/^-?\d+(\.\d+)?$/.test(original)) continue;
    const alternatives = original === '_' ? alts : [original, ...alts];
    results.push({ wordIndex: index, word: original, alternatives, source: '', priority: 0 });
  }
  return results;
}

function parseRaw(response: string): string[] {
  const value = response.trim();
  return value ? [value] : [];
}

// ============================================================================
// BlankClassifier
// ============================================================================

export interface BlankMode {
  name: string;
  priority: number;
  matchRe?: RegExp;
  keywords?: string[];
  promptText: string;
  parser: BlankParser;
  model?: string;
}

/**
 * Build BlankMode list from blanks.md SourceConfig entries.
 * Skips 'classifier' and 'grammar' (handled separately).
 */
export function buildBlankModes(
  sources: Record<string, SourceConfig>,
  defaultModel: string
): BlankMode[] {
  const modes: BlankMode[] = [];

  for (const [name, src] of Object.entries(sources)) {
    if (name === 'classifier') continue;
    if (src.enabled === false) continue;
    if (!src.promptText) continue;

    const mode: BlankMode = {
      name,
      priority: src.priority ?? 90,
      promptText: src.promptText,
      parser: src.parser ?? 'alternatives',
      model: src.model ?? defaultModel,
    };

    if (src.match) {
      try { mode.matchRe = new RegExp(src.match, 'i'); } catch { /* invalid regex, skip */ }
    }

    if (src.keywords) {
      mode.keywords = src.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    }

    modes.push(mode);
  }

  return modes.sort((a, b) => b.priority - a.priority);
}

/**
 * Fast heuristic classification — no LLM needed.
 * Returns the first matching mode name, or null.
 */
export function classifyFast(text: string, modes: BlankMode[]): string | null {
  const lower = text.toLowerCase();
  for (const mode of modes) {
    if (mode.matchRe && mode.matchRe.test(text)) return mode.name;
    if (mode.keywords && mode.keywords.some(kw => lower.includes(kw))) return mode.name;
  }
  return null;
}

// ============================================================================
// BlankClassifierLLM
// ============================================================================

export interface BlankClassifierConfig {
  httpAdapter: HttpAdapter;
  endpoint: string;
  apiKey: string;
  model: string;
  prompt?: string;
  timeout?: number;
}

export class BlankClassifier {
  private config: BlankClassifierConfig;
  private modes: BlankMode[];

  constructor(config: BlankClassifierConfig, modes: BlankMode[]) {
    this.config = config;
    this.modes = modes;
  }

  async classify(text: string): Promise<string> {
    const fast = classifyFast(text, this.modes);
    if (fast) return fast;
    if (!this.config.prompt) return 'grammar';

    try {
      const prompt = this.config.prompt.trimEnd() + ' ' + text;
      const body = JSON.stringify({
        model: this.config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0.1,
      });
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` };
      const response = await this.config.httpAdapter.post(this.config.endpoint, body, headers);
      const data = JSON.parse(response);
      const raw = (data.choices?.[0]?.message?.content || '').toUpperCase();
      // Match any known mode name
      for (const mode of this.modes) {
        if (raw.includes('MODE=' + mode.name.toUpperCase()) || raw.includes(mode.name.toUpperCase())) {
          return mode.name;
        }
      }
    } catch { /* fall through */ }

    return 'grammar';
  }
}

// ============================================================================
// BlankSource
// ============================================================================

export interface BlankSourceConfig {
  httpAdapter: HttpAdapter;
  endpoint: string;
  apiKey: string;
  defaultModel: string;
  modes: BlankMode[];
  classifier: BlankClassifier;
}

export class BlankSource implements CueSource {
  readonly id = 'blank';
  readonly priority = 95;
  private config: BlankSourceConfig;

  constructor(config: BlankSourceConfig) {
    this.config = config;
  }

  supports(context: CueContext): boolean {
    return context.words.some(w => w === '_');
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();

    try {
      const modeName = await this.config.classifier.classify(context.text);
      const mode = this.config.modes.find(m => m.name === modeName);
      if (!mode) return { results: [], timing: Date.now() - startTime };

      const prompt = mode.promptText.trimEnd() + (mode.parser === 'alternatives' ? '\n\n' : ' ');
      const input = mode.parser === 'alternatives'
        ? context.words.map((w, i) => `${i}=${w}`).join(' ')
        : context.text.replace(/_/g, 'BLANK');

      const maxTokens = mode.parser === 'compute' || mode.parser === 'answer' ? 100 : 400;

      const body = JSON.stringify({
        model: mode.model || this.config.defaultModel,
        messages: [{ role: 'user', content: prompt + input }],
        max_tokens: maxTokens,
        temperature: mode.parser === 'compute' || mode.parser === 'answer' ? 0.1 : 0.3,
      });
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` };
      const response = await this.config.httpAdapter.post(this.config.endpoint, body, headers);
      const data = JSON.parse(response);
      const raw = data.choices?.[0]?.message?.content || '';

      const results = this.parseResponse(raw, mode, context.words);

      return { results, timing: Date.now() - startTime };
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : String(error),
        timing: Date.now() - startTime,
      };
    }
  }

  private parseResponse(response: string, mode: BlankMode, words: string[]): CueResult[] {
    switch (mode.parser) {
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
