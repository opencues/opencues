/**
 * The calculator library behind the `tables` blank: pure functions over a
 * captured argument, no model, no network. Every calculator is one entry
 * in the registry (`registry.ts`); the blank dispatches by keyword, core's
 * `data-policy.ts` names the same ids for the decision leg.
 *
 * A calculator returns `null` when it cannot parse its argument. On the
 * keyword path that renders as the blank's miss string; on the decision
 * path the probe declines the fill and the `_` falls through to chat. So a
 * parse failure is never a wrong answer.
 */

/** Ambient inputs a calculator may read. Injected, never read from globals, so a test runs on a fixed clock. */
export interface CalcContext {
  /** the clock */
  readonly now: () => Date;
  /** the host's IANA time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) */
  readonly timeZone: string;
  /** an OPENCUES.md scalar (`vat-rate`, `reading-wpm`); undefined when unset */
  readonly setting: (name: string) => string | undefined;
  /** `crypto.getRandomValues`-backed uniform in [0, 1) */
  readonly random: () => number;
}

export type CalcFamily = 'dates' | 'timezones' | 'numbers' | 'money' | 'text' | 'encodings' | 'physics' | 'tables';

/** Where the argument comes from. */
export type CalcArgFrom =
  /** the words captured after the keyword in the command segment (`days between 3 march and 19 sept _`) */
  | 'segment'
  /** the buffer BEFORE the command segment (`word count _`, `title case _`) — raw text, newlines kept */
  | 'buffer'
  /** none: a bare keyword (`uuid _`, `unix time now _`) */
  | 'none';

export interface Calculator {
  /** the id the decision leg names (a `DATA_POLICY` key in core) */
  readonly id: string;
  readonly family: CalcFamily;
  /** the keyword phrases the blank's shapes lead with; the FIRST is the canonical one the policy uses */
  readonly keywords: readonly string[];
  readonly arg: CalcArgFrom;
  /**
   * A TRANSFORM replaces the prior buffer with its result (`title case _`,
   * `sort lines _`) — the same gesture TransformBlank uses, deterministic.
   * A metric or lookup keeps the prior text and fills after it.
   */
  readonly transform?: boolean;
  /** The argument may be empty (`easter _` = this year, `quarter _` = today). */
  readonly optionalArg?: boolean;
  /**
   * A keyword-less phrasing (`3pm london in tokyo`, `in 45 minutes`,
   * `5 choose 2`): the blank's shape for it carries no keyword, so the
   * slot dispatches under the sentinel keyword `table` and the PHRASE
   * router picks the first calculator whose `phrase` matches the whole
   * command. Anchored, and specific enough that two calculators never
   * both match.
   */
  readonly phrase?: RegExp;
  /** The keyword is part of the phrase the calculator parses (`last friday of october`, `45 minutes ago`): the dispatcher hands it the keyword + argument when the shape captured only the rest. */
  readonly keywordIsArg?: boolean;
  /** Non-idempotent (`uuid`, `random`): never cached, the value is not replayed by undo. */
  readonly generator?: boolean;
  /** one worked example per calculator, `<keyword> <arg> _` → answer; pinned by the registry test and quoted in BLANK.md */
  readonly example: readonly [input: string, answer: string];
  /** the word the blank paints on a miss (`cannot parse the dates`) */
  readonly miss: string;
  run(arg: string, ctx: CalcContext): string | null;
}

/** Numbers as a person would write them: 6 significant digits, no trailing zeros, exponent only when huge or tiny. */
export const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return String(n);
  if (n !== 0 && (Math.abs(n) >= 1e15 || Math.abs(n) < 1e-6)) return n.toExponential(3);
  return String(Number(n.toPrecision(10)));
};

/** Thousands separators for an integer part, `1234567.5` → `1,234,567.5`. */
export const withCommas = (n: number | string): string => {
  const s = typeof n === 'number' ? fmt(n) : n;
  const [int, dec] = s.replace(/^-/, '').split('.');
  return (String(n).startsWith('-') ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? `.${dec}` : '');
};

/** A number token as written: `1,234.5`, `-3`, `2.5e3`, `⅓` is not one. */
export const NUM = String.raw`-?\d[\d,]*(?:\.\d+)?(?:e-?\d+)?`;
export const num = (s: string): number => Number(s.replace(/,/g, ''));
