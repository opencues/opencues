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
 * Safe math evaluator — recursive descent, no Function()/eval().
 * Supports: + - * / % ( ) and unary minus. Returns NaN on invalid input.
 */
function evalMath(expr: string): number {
  let pos = 0;
  const chars = expr.replace(/\s/g, '');

  function parseExpr(): number {
    let left = parseTerm();
    while (pos < chars.length && (chars[pos] === '+' || chars[pos] === '-')) {
      const op = chars[pos++];
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseUnary();
    while (pos < chars.length && (chars[pos] === '*' || chars[pos] === '/' || chars[pos] === '%')) {
      const op = chars[pos++];
      const right = parseUnary();
      if (op === '*') left = left * right;
      else if (op === '/') left = left / right;
      else left = left % right;
    }
    return left;
  }

  function parseUnary(): number {
    if (pos < chars.length && chars[pos] === '-') {
      pos++;
      return -parseUnary();
    }
    return parseAtom();
  }

  function parseAtom(): number {
    if (pos < chars.length && chars[pos] === '(') {
      pos++; // skip (
      const val = parseExpr();
      pos++; // skip )
      return val;
    }
    const start = pos;
    while (pos < chars.length && (chars[pos] >= '0' && chars[pos] <= '9' || chars[pos] === '.')) {
      pos++;
    }
    if (start === pos) return NaN;
    return parseFloat(chars.slice(start, pos));
  }

  const result = parseExpr();
  return pos === chars.length ? result : NaN;
}

/**
 * Parse COMPUTE=expression and evaluate using safe recursive-descent math.
 * No Function()/eval() — only arithmetic operators. Use `parser: math`.
 * Returns the computed value as a string array, e.g. ["48"].
 */
export function parseMath(response: string): string[] {
  const match = response.match(/COMPUTE\s*=\s*([^\n]+)/i);
  if (!match) return [];
  const expr = match[1].trim();
  const safe = expr.replace(/[^0-9+\-*/().%]/g, '');
  if (!safe) return [];
  const result = evalMath(safe);
  if (!isFinite(result)) return [];
  const rounded = Math.round(result * 10000) / 10000;
  return [String(rounded % 1 === 0 ? Math.round(rounded) : rounded)];
}

/**
 * ⚠️ UNSAFE: Parse COMPUTE=expression and evaluate using Function().
 * Can execute arbitrary JavaScript. Only use in trusted environments
 * where the LLM response is controlled. Prefer `parser: math` for
 * arithmetic. Use `parser: compute` only when you need JS expressions
 * beyond basic arithmetic (e.g., Math.pow, Math.sqrt, ternary operators).
 */
export function parseCompute(response: string): string[] {
  const match = response.match(/COMPUTE\s*=\s*([^\n]+)/i);
  if (!match) return [];
  const expr = match[1].trim();
  try {
    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + expr + ')')();
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
