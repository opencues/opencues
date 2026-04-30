// DictionaryControl — fetches a one-line definition from the free
// dictionaryapi.dev (no auth, no rate limit beyond reasonable).
// Read-only. 24h cache per word (definitions don't change often).
//
// Trigger: keyword "define" or "definition" or just the word in
// context — the cue.md decides which keywords route here. The
// keyword itself is the lookup target after stripping the trigger
// word ("define ephemeral" → look up "ephemeral").

import type { Blank } from './types';

const CACHE_TTL_MS = 86_400_000; // 24h
const ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en';
const TRIGGER_WORDS = new Set(['define', 'definition', 'meaning', 'means', 'word']);

interface DictApiEntry {
  word: string;
  meanings?: Array<{
    partOfSpeech?: string;
    definitions?: Array<{ definition?: string }>;
  }>;
}

export interface DictionaryControlOptions {
  /** Override fetch — defaults to globalThis.fetch.bind(globalThis). */
  readonly fetchFn?: typeof fetch;
  /** Override TTL for testing (default 24h). */
  readonly cacheTtlMs?: number;
}

export class DictionaryControl implements Blank {
  readonly name = 'dictionary';
  readonly readOnly = true;
  private readonly _fetch: typeof fetch;
  private readonly _ttl: number;
  private readonly _cache = new Map<string, { value: string; ts: number }>();

  constructor(opts: DictionaryControlOptions = {}) {
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this._ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  }

  async get(keyword?: string, context?: string[]): Promise<string> {
    // Pull the actual word to look up: keyword is the trigger phrase,
    // context is the surrounding words. Try to find a content word that
    // isn't a trigger / pronoun.
    const word = pickWord(keyword, context);
    if (!word) return '';

    const cached = this._cache.get(word);
    if (cached && Date.now() - cached.ts < this._ttl) return cached.value;

    try {
      const resp = await this._fetch(`${ENDPOINT}/${encodeURIComponent(word)}`);
      if (!resp.ok) {
        // 404 = no definition found — give a friendly response, don't
        // expose the HTTP status.
        const value = resp.status === 404 ? `${word}: not found` : `${word}: HTTP ${resp.status}`;
        return value;
      }
      const data = (await resp.json()) as DictApiEntry[];
      const def = data?.[0]?.meanings?.[0]?.definitions?.[0]?.definition || '';
      // Truncate hard for status-line use (one line, no ellipsis sprawl).
      const value = def.length > 100 ? `${def.slice(0, 97).trim()}...` : def;
      this._cache.set(word, { value, ts: Date.now() });
      return value || `${word}: no definition`;
    } catch {
      return `${word}: error`;
    }
  }
}

/** Pick a word to look up from the keyword + surrounding context.
 *  Skips trigger words ("define", "meaning of", etc.) and pronouns. */
function pickWord(keyword?: string, context?: string[]): string {
  // Combine keyword + context, split on whitespace, filter triggers.
  const all = [keyword, ...(context ?? [])]
    .filter(Boolean)
    .flatMap(s => s!.toLowerCase().split(/\s+/))
    .filter(w => w && !TRIGGER_WORDS.has(w) && !/^(of|the|a|an|is|_)$/.test(w));
  // Take the longest remaining word — usually the most distinctive content word.
  return all.sort((a, b) => b.length - a.length)[0] || '';
}
