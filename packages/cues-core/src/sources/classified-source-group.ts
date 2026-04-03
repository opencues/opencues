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
    return selected.getCues(context);
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

  private classifyFast(text: string): ConfigSource | null {
    const lower = text.toLowerCase();
    for (const entry of this.entries) {
      if (entry.matchRe && entry.matchRe.test(text)) return entry.source;
      if (entry.keywords && entry.keywords.some(kw => lower.includes(kw))) return entry.source;
    }
    return null;
  }

  private async classifyLLM(text: string): Promise<ConfigSource | null> {
    try {
      const prompt = this.config.classifierPrompt!.trimEnd() + ' ' + text;
      const body = JSON.stringify({
        model: this.config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0.1,
      });
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      };
      const response = await this.config.httpAdapter.post(this.config.endpoint, body, headers);
      const data = JSON.parse(response);
      const raw = (data.choices?.[0]?.message?.content || '').toUpperCase();

      // Match any known child source name
      for (const entry of this.entries) {
        if (raw.includes('MODE=' + entry.name.toUpperCase()) || raw.includes(entry.name.toUpperCase())) {
          return entry.source;
        }
      }
    } catch { /* fall through */ }

    return null;
  }
}
