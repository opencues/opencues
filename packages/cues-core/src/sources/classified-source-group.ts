/**
 * cues-core/sources/classified-source-group.ts
 *
 * Wraps multiple ConfigSource children (blank modes) and picks one
 * per input via fast heuristics or LLM classifier fallback.
 * Used for blanks.md where math/factual/grammar are mutually exclusive.
 */

import {
  CueSource,
  CueContext,
  CueSourceResult,
  HttpAdapter,
} from '../types';
import { ConfigSource } from './config-source';

// ============================================================================
// Types
// ============================================================================

export interface ClassifiedSourceGroupConfig {
  /** Group identifier */
  id?: string;
  /** Classifier prompt text (from blanks.md ### classifier). If absent, only fast classification runs. */
  classifierPrompt?: string;
  /** Child sources — one per blank mode (math, factual, grammar, etc.) */
  sources: ConfigSource[];
  /** HTTP adapter for LLM classifier calls */
  httpAdapter: HttpAdapter;
  /** API endpoint */
  endpoint: string;
  /** API key */
  apiKey: string;
  /** Model for classifier */
  model: string;
}

interface FastClassifyEntry {
  name: string;
  matchRe?: RegExp;
  keywords?: string[];
  source: ConfigSource;
}

// ============================================================================
// ClassifiedSourceGroup
// ============================================================================

export class ClassifiedSourceGroup implements CueSource {
  readonly id: string;
  readonly priority: number;

  private config: ClassifiedSourceGroupConfig;
  private entries: FastClassifyEntry[];
  private defaultSource: ConfigSource | null;

  constructor(config: ClassifiedSourceGroupConfig) {
    this.config = config;
    this.id = config.id ?? 'blanks';
    // Priority is the max of all children
    this.priority = config.sources.reduce((max, s) => Math.max(max, s.priority), 0);

    // Build fast classification entries from each child's SourceConfig
    this.entries = config.sources.map(s => {
      const entry: FastClassifyEntry = { name: s.id, source: s };
      const cfg = s.sourceConfig;
      if (cfg.match) {
        try { entry.matchRe = new RegExp(cfg.match, 'i'); } catch { /* skip */ }
      }
      if (cfg.keywords) {
        entry.keywords = cfg.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
      }
      return entry;
    });

    // Default fallback is the source named 'grammar', or the last one
    this.defaultSource = config.sources.find(s => s.id === 'grammar') ?? config.sources[config.sources.length - 1] ?? null;
  }

  supports(context: CueContext): boolean {
    return context.words.some(w => w === '_');
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const selected = await this.classify(context.text);
    if (!selected) {
      return { results: [], timing: 0 };
    }
    const result = await selected.getCues(context);
    // If classified source returned empty results and it wasn't the default,
    // fall back to default source (handles misclassification)
    if (result.results.length === 0 && selected !== this.defaultSource && this.defaultSource) {
      return this.defaultSource.getCues(context);
    }
    return result;
  }

  private async classify(text: string): Promise<ConfigSource | null> {
    // Fast path: regex and keyword matching
    const fast = this.classifyFast(text);
    if (fast) return fast;

    // LLM fallback
    if (this.config.classifierPrompt) {
      const llmResult = await this.classifyLLM(text);
      if (llmResult) return llmResult;
    }

    return this.defaultSource;
  }

  /** Exposed for testing — returns the fast-matched source or null */
  classifyFast(text: string): ConfigSource | null {
    const lower = text.toLowerCase();

    // Collect all matches with their priority so highest-priority wins
    let bestMatch: ConfigSource | null = null;
    let bestPriority = -1;

    for (const entry of this.entries) {
      const priority = entry.source.priority;
      if (priority <= bestPriority) continue; // can't beat current best

      if (entry.matchRe && entry.matchRe.test(text)) {
        bestMatch = entry.source;
        bestPriority = priority;
        continue;
      }

      // Word-boundary keyword matching: keyword must appear as whole words
      // "in french" matches "hello in french is" but not "frozen in frenchtoast"
      if (entry.keywords) {
        for (const kw of entry.keywords) {
          const idx = lower.indexOf(kw);
          if (idx < 0) continue;
          // Check left boundary: start of string or non-alphanumeric
          const leftOk = idx === 0 || /\W/.test(lower[idx - 1]);
          // Check right boundary: end of string or non-alphanumeric
          const endIdx = idx + kw.length;
          const rightOk = endIdx >= lower.length || /\W/.test(lower[endIdx]);
          if (leftOk && rightOk) {
            bestMatch = entry.source;
            bestPriority = priority;
            break;
          }
        }
      }
    }

    return bestMatch;
  }

  /** Exposed for testing — calls the LLM classifier and returns the matched source */
  async classifyLLM(text: string): Promise<ConfigSource | null> {
    try {
      const prompt = this.config.classifierPrompt!.trimEnd() + ' ' + text;
      const body = JSON.stringify({
        model: this.config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.1,
        // Groq reasoning models burn tokens on internal reasoning without this.
        reasoning_effort: 'low',
      });
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      };
      const response = await this.config.httpAdapter.post(this.config.endpoint, body, headers);
      const data = JSON.parse(response);
      const msg = data.choices?.[0]?.message;
      const content = (msg?.content || '').toUpperCase();
      const reasoning = (msg?.reasoning || '').toUpperCase();

      // First try content field (preferred — actual model output)
      for (const entry of this.entries) {
        const mode = 'MODE=' + entry.name.toUpperCase();
        if (content.includes(mode)) return entry.source;
      }

      // Then try reasoning field for MODE= pattern only (not bare name — reasoning
      // contains the full prompt which lists all mode names)
      for (const entry of this.entries) {
        const mode = 'MODE=' + entry.name.toUpperCase();
        if (reasoning.includes(mode)) return entry.source;
      }
    } catch { /* fall through */ }

    return null;
  }
}
