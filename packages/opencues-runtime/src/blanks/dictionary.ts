// DictionaryBlank — fetches a one-line definition from the free
// dictionaryapi.dev (no auth, no rate limit beyond reasonable).
// Read-only. 24h cache per word (definitions don't change often).
//
// Trigger: `keyword` is the matched trigger PHRASE ("define",
// "what is", "meaning of", …) — never the lookup target. The word to
// define comes from `context` (the words between the keyword and the
// `_`): "define ephemeral _" → keyword "define", context ["ephemeral"].

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

export interface DictionaryBlankOptions {
  /** Override fetch — defaults to globalThis.fetch.bind(globalThis). */
  readonly fetchFn?: typeof fetch;
  /** Override TTL for testing (default 24h). */
  readonly cacheTtlMs?: number;
}

export class DictionaryBlank implements Blank {
  readonly name = 'dictionary';
  readonly readOnly = true;
  private readonly _fetch: typeof fetch;
  private readonly _ttl: number;
  private readonly _cache = new Map<string, { value: string; ts: number }>();

  constructor(opts: DictionaryBlankOptions = {}) {
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
      // Embed word so the output is self-contained: a shaped get clears
      // the whole command span, leaving only this.
      const out = value ? `${word}: ${value}` : `${word}: no definition`;
      this._cache.set(word, { value: out, ts: Date.now() });
      return out;
    } catch {
      return `${word}: error`;
    }
  }
}

/** Pick a word to look up from the keyword + surrounding context.
 *  Skips trigger words and pronouns.
 *
 *  The matched trigger PHRASE arrives in `keyword` (e.g. "what is",
 *  "meaning of") — every word of it is excluded, so whatever phrase
 *  routed here can never be picked as the lookup target. This is the
 *  drift-proof half: extending `blankKeywords` (which added "what is" /
 *  "what does") never needs a matching edit here. `TRIGGER_WORDS` is the
 *  static belt-and-braces for trigger words that leak into `context`
 *  from the highlighted-word path (issue #282). */
function pickWord(keyword?: string, context?: string[]): string {
  // Words of the matched trigger phrase — never lookup candidates.
  const triggerParts = new Set(
    (keyword ?? '').toLowerCase().split(/\s+/).filter(Boolean),
  );
  const all = (context ?? [])
    .filter(Boolean)
    .flatMap(s => s.toLowerCase().split(/\s+/))
    .filter(
      w =>
        w &&
        !triggerParts.has(w) &&
        !TRIGGER_WORDS.has(w) &&
        !/^(of|the|a|an|is|what|does|_)$/.test(w),
    );
  // Take the longest remaining word — usually the most distinctive content word.
  return all.sort((a, b) => b.length - a.length)[0] || '';
}
