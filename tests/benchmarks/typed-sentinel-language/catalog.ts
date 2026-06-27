/**
 * Universal catalog — one source of truth for entry semantics. Each
 * language renderer (see `languages.ts`) projects this into its own
 * surface syntax.
 *
 * Entries split into three kinds:
 *
 *  scalar     — fixed-value lookup (no params; resolves to a single
 *               string/number). Identity-style.
 *  fn         — parameterized lookup (takes ≥1 args, returns scalar
 *               or struct). Stock-price, weather, etc.
 *  array      — returns N items; the model may pass a cardinality hint
 *               (`limit`) or omit and let the source pick a default.
 *
 * Output shape (`returns:`) is structured:
 *  - 'string' / 'number'  — bare scalar
 *  - { ... }              — struct with named fields
 *  - 'array<T>'           — sequence of T
 *
 * The languages.ts renderer formats each entry per language; the
 * grader (score.ts) reads back the semantic identity ('id') from
 * what the LLM emitted to score selection accuracy.
 */

export type Param = {
  name: string;
  type: 'string' | 'number';
  example: string; // for prompts (e.g. "NVDA", "London", "10")
};

export type ScalarReturn = 'string' | 'number';
export type StructReturn = { [field: string]: ScalarReturn };
export type ArrayReturn = `array<${string}>`; // simplified

export interface CatalogEntry {
  /** Stable identity used by the grader. e.g. 'first-name', 'stock',
   *  'news'. Languages format this differently. */
  id: string;
  /** Human description for prompt rendering. */
  description: string;
  kind: 'scalar' | 'fn' | 'array';
  /** Bare-form display name (used in Bare language + for some others). */
  displayName: string; // e.g. 'FIRST NAME', 'STOCK', 'NEWS'
  /** For fn / array kinds. */
  params?: Param[];
  /** Output shape (semantic, not syntactic). */
  returns: ScalarReturn | StructReturn | ArrayReturn;
  /** Optional default value for the 'safe' present-value table (only
   *  used to compose realistic context — we never actually need to
   *  resolve these in the bench, since we're testing selection +
   *  parameter-fill accuracy, not value-injection). */
  exampleValue?: string;
}

export const CATALOG: ReadonlyArray<CatalogEntry> = [
  // ───── Identity scalars (no params) ─────
  { id: 'first-name', displayName: 'FIRST NAME', description: "the user's first name",
    kind: 'scalar', returns: 'string', exampleValue: 'Wilfred' },
  { id: 'last-name', displayName: 'LAST NAME', description: "the user's last name",
    kind: 'scalar', returns: 'string', exampleValue: 'Kasekende' },
  { id: 'email', displayName: 'EMAIL', description: "the user's primary email address",
    kind: 'scalar', returns: 'string', exampleValue: 'hello@claudelog.com' },
  { id: 'phone', displayName: 'PHONE', description: "the user's mobile number",
    kind: 'scalar', returns: 'string', exampleValue: '+447700900000' },
  { id: 'work-city', displayName: 'WORK CITY', description: "the city the user works in",
    kind: 'scalar', returns: 'string', exampleValue: 'London' },
  { id: 'job-title', displayName: 'JOB TITLE', description: "the user's job title",
    kind: 'scalar', returns: 'string', exampleValue: 'Software engineer' },

  // ───── Parameterized scalars (fn → single value) ─────
  { id: 'stock-price', displayName: 'STOCK PRICE', description: "current price of a stock",
    kind: 'fn', returns: 'number',
    params: [{ name: 'ticker', type: 'string', example: 'NVDA' }],
    exampleValue: '212.45' },
  { id: 'weather-temp', displayName: 'WEATHER TEMP', description: "current temperature for a city (celsius)",
    kind: 'fn', returns: 'number',
    params: [{ name: 'city', type: 'string', example: 'London' }],
    exampleValue: '18' },
  { id: 'time-in', displayName: 'TIME IN', description: "current local time in a named city",
    kind: 'fn', returns: 'string',
    params: [{ name: 'city', type: 'string', example: 'Tokyo' }],
    exampleValue: '14:32' },
  { id: 'currency-convert', displayName: 'CONVERT', description: "convert an amount from one currency to another",
    kind: 'fn', returns: 'number',
    params: [
      { name: 'amount', type: 'number', example: '100' },
      { name: 'from', type: 'string', example: 'USD' },
      { name: 'to', type: 'string', example: 'GBP' },
    ],
    exampleValue: '78.5' },

  // ───── Parameterized struct returns ─────
  { id: 'stock', displayName: 'STOCK', description: "full quote for a stock — price + change + volume",
    kind: 'fn', returns: { price: 'number', change: 'number', volume: 'number' },
    params: [{ name: 'ticker', type: 'string', example: 'NVDA' }],
    exampleValue: '{price:212.45, change:+1.2, volume:32M}' },
  { id: 'weather', displayName: 'WEATHER', description: "weather for a city — temp + conditions + forecast",
    kind: 'fn', returns: { temp: 'number', conditions: 'string', forecast: 'string' },
    params: [{ name: 'city', type: 'string', example: 'London' }],
    exampleValue: '{temp:18, conditions:"cloudy", forecast:"rain tonight"}' },

  // ───── Array returns ─────
  { id: 'news', displayName: 'NEWS', description: "recent top headlines",
    kind: 'array', returns: 'array<string>',
    params: [{ name: 'limit', type: 'number', example: '5' }],
    exampleValue: '["Headline 1", "Headline 2", ...]' },
  { id: 'hackernews', displayName: 'HACKERNEWS', description: "top stories from Hacker News right now",
    kind: 'array', returns: 'array<{title: string, url: string, points: number}>',
    params: [{ name: 'limit', type: 'number', example: '10' }],
    exampleValue: '[{title:..., url:..., points:412}, ...]' },
  { id: 'recent-emails', displayName: 'RECENT EMAILS', description: "the user's most recent emails",
    kind: 'array', returns: 'array<{from: string, subject: string}>',
    params: [{ name: 'limit', type: 'number', example: '5' }],
    exampleValue: '[{from:..., subject:...}, ...]' },
  { id: 'calendar-today', displayName: 'CALENDAR TODAY', description: "calendar events for today",
    kind: 'array', returns: 'array<{time: string, title: string}>',
    exampleValue: '[{time:"10:00", title:"standup"}, ...]' },
];

/** Lookup helper. */
export function entryById(id: string): CatalogEntry | undefined {
  return CATALOG.find(e => e.id === id);
}
