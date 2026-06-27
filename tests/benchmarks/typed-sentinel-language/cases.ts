/**
 * Test cases — each is a prompt the user might type, paired with the
 * sentinel(s) the model SHOULD emit (with what parameters) to be
 * considered correct.
 *
 * Categories (7) span the hypotheses in the bench README:
 *
 *  scalar          — single-scalar lookup, no params (H1)
 *  param-single    — fn lookup with 1 param the model must extract (H2)
 *  param-multi     — fn lookup with 2+ params (H2 stress)
 *  array           — array lookup, optionally with a cardinality (H3)
 *  field-select    — structured-return + selecting a single field (H4)
 *  composition     — multiple sentinels in one response
 *  unsupported     — no matching entry; the model should bail (`null`)
 *
 * Each `expected` is the GROUND TRUTH set; emitting EXTRA sentinels not
 * in this list counts as hallucination unless `looseExtra: true`.
 */

import type { LanguageId } from './languages';

export interface ExpectedSentinel {
  id: string;
  /** Params the model MUST set (if specified). Missing/wrong params
   *  fail the param-axis but not the selection axis. */
  params?: Record<string, string>;
  /** If true, allow case-insensitive + light-normalized param match
   *  (e.g. "NVDA" / "nvda" / "Nvda" all match for stock ticker). */
  paramCaseInsensitive?: boolean;
}

export interface Case {
  id: string;
  category: 'scalar' | 'param-single' | 'param-multi' | 'array' | 'field-select' | 'composition' | 'unsupported';
  prompt: string;
  expected: ExpectedSentinel[];
  /** For array cases — expected limit/count the model should request. */
  expectedCardinality?: number;
  /** When true, the case allows the model to emit additional unlisted
   *  sentinels without scoring them as hallucinations. Used for prompts
   *  where multiple correct interpretations exist. */
  looseExtra?: boolean;
  /** Languages that can express this case at all. Currently all four
   *  can, but kept for forward-compat as we add cardinality syntax. */
  applicableLanguages?: ReadonlyArray<LanguageId>;
}

export const CASES: ReadonlyArray<Case> = [
  // ─── Scalar (6) ─────────────────────────────────────────────────────
  { id: 's1', category: 'scalar', prompt: 'my email is _',
    expected: [{ id: 'email' }] },
  { id: 's2', category: 'scalar', prompt: 'my phone number is _',
    expected: [{ id: 'phone' }] },
  { id: 's3', category: 'scalar', prompt: 'hi, _',
    expected: [{ id: 'first-name' }] },
  { id: 's4', category: 'scalar', prompt: 'sincerely, _ _',
    expected: [{ id: 'first-name' }, { id: 'last-name' }] },
  { id: 's5', category: 'scalar', prompt: 'i live in _',
    expected: [{ id: 'work-city' }] },
  { id: 's6', category: 'scalar', prompt: 'my job title is _',
    expected: [{ id: 'job-title' }] },

  // ─── Param-single (6) ───────────────────────────────────────────────
  { id: 'p1', category: 'param-single', prompt: 'nvda is at _',
    expected: [{ id: 'stock-price', params: { ticker: 'NVDA' }, paramCaseInsensitive: true }] },
  { id: 'p2', category: 'param-single', prompt: 'whats the weather in london _',
    expected: [{ id: 'weather-temp', params: { city: 'London' }, paramCaseInsensitive: true }] },
  { id: 'p3', category: 'param-single', prompt: 'time in tokyo _',
    expected: [{ id: 'time-in', params: { city: 'Tokyo' }, paramCaseInsensitive: true }] },
  { id: 'p4', category: 'param-single', prompt: 'aapl price _',
    expected: [{ id: 'stock-price', params: { ticker: 'AAPL' }, paramCaseInsensitive: true }] },
  { id: 'p5', category: 'param-single', prompt: 'how warm is it in paris _',
    expected: [{ id: 'weather-temp', params: { city: 'Paris' }, paramCaseInsensitive: true }] },
  { id: 'p6', category: 'param-single', prompt: 'tsla is currently trading at _',
    expected: [{ id: 'stock-price', params: { ticker: 'TSLA' }, paramCaseInsensitive: true }] },

  // ─── Param-multi (4) ────────────────────────────────────────────────
  { id: 'pm1', category: 'param-multi', prompt: 'how much is 100 usd in gbp _',
    expected: [{ id: 'currency-convert', params: { amount: '100', from: 'USD', to: 'GBP' }, paramCaseInsensitive: true }] },
  { id: 'pm2', category: 'param-multi', prompt: 'convert 50 euros to dollars _',
    expected: [{ id: 'currency-convert', params: { amount: '50', from: 'EUR', to: 'USD' }, paramCaseInsensitive: true }] },
  { id: 'pm3', category: 'param-multi', prompt: '250 cad in jpy _',
    expected: [{ id: 'currency-convert', params: { amount: '250', from: 'CAD', to: 'JPY' }, paramCaseInsensitive: true }] },
  { id: 'pm4', category: 'param-multi', prompt: 'whats 1000 gbp in usd _',
    expected: [{ id: 'currency-convert', params: { amount: '1000', from: 'GBP', to: 'USD' }, paramCaseInsensitive: true }] },

  // ─── Array (5) ──────────────────────────────────────────────────────
  { id: 'a1', category: 'array', prompt: 'top 5 headlines today _',
    expected: [{ id: 'news', params: { limit: '5' } }], expectedCardinality: 5 },
  { id: 'a2', category: 'array', prompt: 'top 10 hn stories _',
    expected: [{ id: 'hackernews', params: { limit: '10' } }], expectedCardinality: 10 },
  { id: 'a3', category: 'array', prompt: 'recent emails _',
    expected: [{ id: 'recent-emails' }], looseExtra: true },
  { id: 'a4', category: 'array', prompt: 'whats on my calendar today _',
    expected: [{ id: 'calendar-today' }] },
  { id: 'a5', category: 'array', prompt: 'show me 3 recent emails _',
    expected: [{ id: 'recent-emails', params: { limit: '3' } }], expectedCardinality: 3 },

  // ─── Field-select (4) ───────────────────────────────────────────────
  // The structured `STOCK` + `WEATHER` entries return multi-field objects.
  // The bench tests whether the model RIGHTLY picks the field-specific
  // scalar entry (e.g. `stock-price` not `stock`) when only one field is
  // wanted. Both answers are acceptable but selection-axis prefers the
  // narrower entry.
  { id: 'f1', category: 'field-select', prompt: 'just the price of nvda _',
    expected: [{ id: 'stock-price', params: { ticker: 'NVDA' }, paramCaseInsensitive: true }],
    looseExtra: true },
  { id: 'f2', category: 'field-select', prompt: 'nvda full quote _',
    expected: [{ id: 'stock', params: { ticker: 'NVDA' }, paramCaseInsensitive: true }] },
  { id: 'f3', category: 'field-select', prompt: 'temperature in berlin _',
    expected: [{ id: 'weather-temp', params: { city: 'Berlin' }, paramCaseInsensitive: true }],
    looseExtra: true },
  { id: 'f4', category: 'field-select', prompt: 'weather report for berlin _',
    expected: [{ id: 'weather', params: { city: 'Berlin' }, paramCaseInsensitive: true }] },

  // ─── Composition (5) ────────────────────────────────────────────────
  { id: 'c1', category: 'composition', prompt: 'hi team, nvda is at _ today, sent from _',
    expected: [
      { id: 'stock-price', params: { ticker: 'NVDA' }, paramCaseInsensitive: true },
      { id: 'first-name' },
    ] },
  { id: 'c2', category: 'composition', prompt: 'email update: aapl _, nvda _, tsla _',
    expected: [
      { id: 'stock-price', params: { ticker: 'AAPL' }, paramCaseInsensitive: true },
      { id: 'stock-price', params: { ticker: 'NVDA' }, paramCaseInsensitive: true },
      { id: 'stock-price', params: { ticker: 'TSLA' }, paramCaseInsensitive: true },
    ] },
  { id: 'c3', category: 'composition', prompt: 'morning! its _ degrees in _ today',
    expected: [
      { id: 'weather-temp', params: { city: 'London' }, paramCaseInsensitive: true },
      { id: 'work-city' },
    ], looseExtra: true },
  { id: 'c4', category: 'composition', prompt: 'reply from _ <_>: ',
    expected: [
      { id: 'first-name' },
      { id: 'email' },
    ] },
  { id: 'c5', category: 'composition', prompt: 'top 3 news items, signed _',
    expected: [
      { id: 'news', params: { limit: '3' } },
      { id: 'first-name' },
    ], expectedCardinality: 3 },

  // ─── Unsupported (4) ────────────────────────────────────────────────
  // Should NOT emit any catalog sentinel. The bench grades these by
  // counting hallucinations only — if the model emits any bracketed
  // catalog entry, that's a fail. Plain prose / no brackets is correct.
  { id: 'u1', category: 'unsupported', prompt: 'whats the capital of france _',
    expected: [] },
  { id: 'u2', category: 'unsupported', prompt: 'pi to 6 decimal places _',
    expected: [] },
  { id: 'u3', category: 'unsupported', prompt: 'moon phase tonight _',
    expected: [] },
  { id: 'u4', category: 'unsupported', prompt: 'translate hello to spanish _',
    expected: [] },
];

export function casesByCategory(): Record<Case['category'], Case[]> {
  const out = {} as Record<Case['category'], Case[]>;
  for (const c of CASES) {
    (out[c.category] ??= []).push(c);
  }
  return out;
}
