/**
 * opencues-core/sources/parsers.ts
 *
 * Response parsers for LLM output. Each parser extracts structured
 * results from a specific LLM response format. Used by ConfigSource.
 */

import { CueResult } from '../types';

/**
 * Parse INDEX:alt1,alt2,alt3 responses into CueResult[].
 * For blank positions (_), returns alts directly.
 * For regular words, prepends the original word.
 * Skips number positions (handled by number cycling).
 */
export function parseAlternatives(response: string, words: string[]): CueResult[] {
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

/**
 * Use the full LLM response verbatim as one alternative.
 */
export function parseRaw(response: string): string[] {
  const value = response.trim();
  return value ? [value] : [];
}
