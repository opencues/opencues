/**
 * Stripped catalog for the capability-fabrication probe.
 *
 * Same entries as the canonical catalog BUT with capabilities
 * deliberately removed:
 *
 *  - All array entries (news, hackernews, recent-emails, calendar-today)
 *    have NO `limit` param. They return whatever the runtime decides.
 *
 *  - All parameterized scalars (stock-price, weather-temp, time-in,
 *    convert) have NO params. They're effectively fixed — `[STOCK PRICE]`
 *    returns some hardcoded ticker's price; `[WEATHER TEMP]` returns
 *    some hardcoded city's weather. Realistically nonsense, but it's a
 *    probe: when the user types `nvda is at _`, does the model emit
 *    `[STOCK PRICE]` (correct — it's not allowed to specify a ticker),
 *    emit `[STOCK PRICE(ticker="NVDA")]` (INVENTED capability), bail
 *    entirely, or pick a different sentinel?
 *
 *  - `stock` / `weather` struct entries: same — no params.
 *
 * Identity scalars (first-name, etc.) are unchanged — they have no
 * params to strip.
 *
 * Cases run against this catalog are the SAME 34 cases as the canonical
 * suite. Grader is the same. Three new failure modes to look for:
 *
 *   FABRICATED_PARAM   — model emitted (key=value) on an entry whose
 *                        catalog signature has no params.
 *   WRONG_PARAM_KEY    — model emitted (foo=...) where catalog allows
 *                        params but `foo` isn't one of them (we don't
 *                        have any such entries in this stripped catalog
 *                        but the grader counts the key-vs-catalog match).
 *   IGNORED_USER_INTENT — model emitted the no-param sentinel but the
 *                        user's intent (NVDA, AAPL, "5 items") was
 *                        clearly different from what the resolved
 *                        value would be. This is the EXPECTED behaviour
 *                        when the catalog is stripped; we're measuring
 *                        whether the model RESPECTS the catalog limit.
 */

import type { CatalogEntry } from './catalog';

export const STRIPPED_CATALOG: ReadonlyArray<CatalogEntry> = [
  // ─── Identity scalars (unchanged — never had params) ─────────────
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

  // ─── Stripped fns (params removed) ───────────────────────────────
  // Note kind retained ('fn' / 'array') so renderers don't trip. The
  // params property is OMITTED entirely — the parameterized renderer
  // will emit `[STOCK PRICE: number]` (no parens). The intent: the
  // model sees no syntax for passing a ticker; it has to either emit
  // bare `[STOCK PRICE]`, invent params, or bail.
  { id: 'stock-price', displayName: 'STOCK PRICE', description: "today's headline stock price (no ticker selectable)",
    kind: 'fn', returns: 'number', exampleValue: '212.45' },
  { id: 'weather-temp', displayName: 'WEATHER TEMP', description: "today's headline temperature (no city selectable)",
    kind: 'fn', returns: 'number', exampleValue: '18' },
  { id: 'time-in', displayName: 'TIME IN', description: "local time at the runtime's default city",
    kind: 'fn', returns: 'string', exampleValue: '14:32' },
  { id: 'currency-convert', displayName: 'CONVERT', description: "a single hardcoded currency rate (no params)",
    kind: 'fn', returns: 'number', exampleValue: '78.5' },

  // ─── Stripped structs ────────────────────────────────────────────
  { id: 'stock', displayName: 'STOCK', description: "today's headline stock quote (price + change + volume)",
    kind: 'fn', returns: { price: 'number', change: 'number', volume: 'number' },
    exampleValue: '{price:212.45, change:+1.2, volume:32M}' },
  { id: 'weather', displayName: 'WEATHER', description: "today's headline weather report (temp + conditions + forecast)",
    kind: 'fn', returns: { temp: 'number', conditions: 'string', forecast: 'string' },
    exampleValue: '{temp:18, conditions:"cloudy", forecast:"rain tonight"}' },

  // ─── Stripped arrays (no limit param) ─────────────────────────────
  { id: 'news', displayName: 'NEWS', description: "recent top headlines (default 5 items, no count param)",
    kind: 'array', returns: 'array<string>',
    exampleValue: '["Headline 1", "Headline 2", ...]' },
  { id: 'hackernews', displayName: 'HACKERNEWS', description: "top HN stories right now (default 10, no count param)",
    kind: 'array', returns: 'array<{title: string, url: string, points: number}>',
    exampleValue: '[{title:..., url:..., points:412}, ...]' },
  { id: 'recent-emails', displayName: 'RECENT EMAILS', description: "the user's most recent emails (default 5, no count param)",
    kind: 'array', returns: 'array<{from: string, subject: string}>',
    exampleValue: '[{from:..., subject:...}, ...]' },
  { id: 'calendar-today', displayName: 'CALENDAR TODAY', description: "calendar events for today (always today, no params)",
    kind: 'array', returns: 'array<{time: string, title: string}>',
    exampleValue: '[{time:"10:00", title:"standup"}, ...]' },
];
