/**
 * cues-core/sources/parsers.ts
 *
 * Response parsers for LLM output. Each parser extracts structured
 * results from a specific LLM response format.
 *
 * Used by ConfigSource and ClassifiedSourceGroup.
 */

import { CueResult } from '../types';

/**
 * Parse COMPUTE=expression responses and evaluate the math expression.
 * Returns the computed value as a string array, e.g. ["48"].
 */
export function parseCompute(response: string): string[] {
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

/**
 * Parse ANSWER=value responses. Returns the answer as a string array, e.g. ["Paris"].
 */
export function parseAnswer(response: string): string[] {
  const match = response.match(/ANSWER\s*=\s*([^\n]+)/i);
  if (!match) return [];
  const value = match[1].trim();
  if (!value || value.length > 100) return [];
  return [value];
}

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
