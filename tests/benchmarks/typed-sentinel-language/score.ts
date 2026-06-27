/**
 * Auto-grader. Five axes per case:
 *
 *   selection      — did the model emit (at least once) the expected
 *                    catalog id for each entry in `expected`?
 *   parameters     — for each expected entry with `params`, did the
 *                    model's filled params match (case-insensitive +
 *                    light normalization)?
 *   format         — did the bracket syntax actually PARSE in this
 *                    language? Sentinels with `id !== null` count;
 *                    `id === null` (unparseable bracket) tanks this.
 *   hallucination  — sentinels emitted that aren't in `expected`. Lower
 *                    is better. Capped at 1.0 — even 1 hallucination
 *                    flags the case.
 *   cardinality    — for array cases with `expectedCardinality`, did
 *                    the model pass the right limit param? Implicit
 *                    pass when the case has no cardinality.
 *
 * Each axis returns 0 or 1 (binary per case for clarity in tables).
 * Overall score is the simple average.
 */

import type { Case, ExpectedSentinel } from './cases';
import type { ParsedSentinel } from './languages';

export interface CaseScore {
  caseId: string;
  category: Case['category'];
  selection: 0 | 1;
  parameters: 0 | 1;
  format: 0 | 1;
  hallucination: 0 | 1;
  cardinality: 0 | 1;
  /** Average of the 5 axes. */
  overall: number;
  /** Captured for the per-case audit log. */
  parsed: ParsedSentinel[];
  /** Friendly notes — what went wrong, what matched. */
  notes: string[];
}

function normalizeParamValue(v: string): string {
  return v.trim().toLowerCase().replace(/[",.]/g, '');
}

function paramMatches(expected: string, got: string | undefined, ci: boolean): boolean {
  if (got === undefined || got === null) return false;
  if (ci) return normalizeParamValue(expected) === normalizeParamValue(got);
  return expected === got;
}

function matchEntry(parsed: ParsedSentinel[], exp: ExpectedSentinel, used: Set<number>): { idx: number; paramsOk: boolean } | null {
  for (let i = 0; i < parsed.length; i++) {
    if (used.has(i)) continue;
    if (parsed[i]!.id !== exp.id) continue;
    let paramsOk = true;
    if (exp.params) {
      for (const [k, v] of Object.entries(exp.params)) {
        if (!paramMatches(v, parsed[i]!.params[k], !!exp.paramCaseInsensitive)) {
          paramsOk = false;
          break;
        }
      }
    }
    return { idx: i, paramsOk };
  }
  return null;
}

export function scoreCase(c: Case, parsed: ParsedSentinel[]): CaseScore {
  const notes: string[] = [];

  // ─── Selection ────────────────────────────────────────────────────
  const used = new Set<number>();
  let selectionHits = 0;
  let allParamsOk = true;
  let allParamsRequired = 0;
  for (const exp of c.expected) {
    const m = matchEntry(parsed, exp, used);
    if (m === null) {
      notes.push(`miss: expected ${exp.id}${exp.params ? ` with params ${JSON.stringify(exp.params)}` : ''}`);
      if (exp.params) allParamsOk = false;
      continue;
    }
    used.add(m.idx);
    selectionHits++;
    if (exp.params) {
      allParamsRequired++;
      if (!m.paramsOk) {
        allParamsOk = false;
        notes.push(`bad params on ${exp.id}: got ${JSON.stringify(parsed[m.idx]!.params)}, want ${JSON.stringify(exp.params)}`);
      }
    }
  }
  const selection: 0 | 1 = selectionHits === c.expected.length ? 1 : 0;

  // ─── Parameters ──────────────────────────────────────────────────
  // If no expected entry HAS params, parameters axis is implicit pass.
  const parameters: 0 | 1 = allParamsRequired === 0 ? 1 : (allParamsOk ? 1 : 0);

  // ─── Format ──────────────────────────────────────────────────────
  // If the case expects no sentinels (unsupported), format = 1 trivially
  // (parse never fails to parse nothing). Otherwise: the matched
  // sentinels must have non-null id (i.e. the renderer's output was
  // parseable by this language's parser).
  let format: 0 | 1;
  if (c.expected.length === 0) {
    format = 1;
  } else {
    const expectedHits = parsed.filter((p, i) => used.has(i));
    format = expectedHits.length > 0 && expectedHits.every(p => p.id !== null) ? 1 : 0;
  }

  // ─── Hallucination ───────────────────────────────────────────────
  // Count any parsed sentinel that's NOT in `used` AND has an id (the
  // model invoked a known catalog entry but not one we expected) OR has
  // id=null (a bracketed token that doesn't match the catalog).
  // For looseExtra: only count id=null hallucinations.
  let hallucinations = 0;
  for (let i = 0; i < parsed.length; i++) {
    if (used.has(i)) continue;
    if (parsed[i]!.id === null) {
      hallucinations++;
      notes.push(`hallucinated bracket: ${parsed[i]!.raw}`);
    } else if (!c.looseExtra) {
      hallucinations++;
      notes.push(`extra sentinel: ${parsed[i]!.raw} (id=${parsed[i]!.id})`);
    }
  }
  // For unsupported cases, ANY emitted sentinel (id !== null) is a
  // hallucination — they should output plain prose.
  if (c.category === 'unsupported') {
    for (let i = 0; i < parsed.length; i++) {
      if (parsed[i]!.id !== null) {
        hallucinations++;
        notes.push(`unsupported case emitted sentinel: ${parsed[i]!.raw}`);
      }
    }
  }
  const hallucination: 0 | 1 = hallucinations === 0 ? 1 : 0;

  // ─── Cardinality ─────────────────────────────────────────────────
  let cardinality: 0 | 1;
  if (c.expectedCardinality === undefined) {
    cardinality = 1;
  } else {
    // Look for any matched entry that has a 'limit' param matching.
    cardinality = 0;
    for (const exp of c.expected) {
      // Find the parsed sentinel that matched this expected entry.
      const idx = [...used].find(i => parsed[i]!.id === exp.id);
      if (idx === undefined) continue;
      const limitStr = parsed[idx]!.params['limit'];
      if (limitStr && parseInt(limitStr, 10) === c.expectedCardinality) {
        cardinality = 1;
        break;
      }
    }
    if (cardinality === 0) {
      notes.push(`expected limit=${c.expectedCardinality}, got ${JSON.stringify(parsed.map(p => p.params))}`);
    }
  }

  const overall = (selection + parameters + format + hallucination + cardinality) / 5;
  return { caseId: c.id, category: c.category, selection, parameters, format, hallucination, cardinality, overall, parsed, notes };
}

export interface SuiteSummary {
  totalCases: number;
  selection: number;       // 0-1 mean
  parameters: number;
  format: number;
  hallucination: number;
  cardinality: number;
  overall: number;
  /** Per-category breakdown (0-1 overall per category). */
  byCategory: Record<string, number>;
  /** Per-case list for the audit log. */
  cases: CaseScore[];
}

export function summarize(scores: CaseScore[]): SuiteSummary {
  const n = scores.length;
  const mean = (key: keyof CaseScore) =>
    n === 0 ? 0 : scores.reduce((sum, s) => sum + (s[key] as number), 0) / n;
  const byCategory: Record<string, { sum: number; n: number }> = {};
  for (const s of scores) {
    (byCategory[s.category] ??= { sum: 0, n: 0 });
    byCategory[s.category]!.sum += s.overall;
    byCategory[s.category]!.n++;
  }
  const byCategoryAvg: Record<string, number> = {};
  for (const [cat, { sum, n: nc }] of Object.entries(byCategory)) {
    byCategoryAvg[cat] = nc === 0 ? 0 : sum / nc;
  }
  return {
    totalCases: n,
    selection: mean('selection'),
    parameters: mean('parameters'),
    format: mean('format'),
    hallucination: mean('hallucination'),
    cardinality: mean('cardinality'),
    overall: mean('overall'),
    byCategory: byCategoryAvg,
    cases: scores,
  };
}
