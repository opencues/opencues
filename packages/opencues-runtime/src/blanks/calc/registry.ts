/**
 * Every calculator the `tables` blank can run, by family. The blank
 * dispatches by keyword (longest match first); core's `data-policy.ts`
 * names the same ids for the decision leg, and `calc-registry.test.ts`
 * pins that the two agree and that every keyword has a shape in
 * defaults/blanks/tables/BLANK.md.
 */
import type { Calculator } from './types';
import { DATES } from './dates';
import { TIMEZONES } from './timezones';
import { NUMBERS } from './numbers';

export const CALCULATORS: readonly Calculator[] = [...DATES, ...TIMEZONES, ...NUMBERS];

const byKeyword: Array<[string, Calculator]> = CALCULATORS.flatMap((c) => c.keywords.map((k) => [k.toLowerCase(), c] as [string, Calculator])).sort((a, b) => b[0].length - a[0].length);
const byId = new Map(CALCULATORS.map((c) => [c.id, c]));

/** The calculator a keyword phrase leads with (`days between`, `in hex`), or null. */
export function calculatorForKeyword(keyword: string): Calculator | null {
  const k = keyword.toLowerCase().trim();
  for (const [kw, c] of byKeyword) if (k === kw) return c;
  return null;
}
export const calculatorById = (id: string): Calculator | null => byId.get(id) ?? null;

/** The sentinel keyword a keyword-less shape dispatches under (first in the blank's `blankKeywords`). */
export const PHRASE_KEYWORD = 'table';
/** The calculator whose `phrase` grammar accepts the whole command, or null. */
export function calculatorForPhrase(phrase: string): Calculator | null {
  const p = phrase.trim();
  for (const c of CALCULATORS) if (c.phrase && c.phrase.test(p)) return c;
  return null;
}
