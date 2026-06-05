// 30 indirect-query cases for the blank-context recall bench.
//
// Each case names: the input the user types, the catalog of ambient tokens
// the runtime is exposing, and whether a token SHOULD or SHOULD NOT be
// emitted in the LLM's ANSWER. Mix is 15 positive / 10 negative / 5
// ambiguous to surface false negatives + false positives both.

export interface RecallCase {
  id: string;
  input: string;
  catalog: ReadonlyArray<{ token: string; description: string; value: string }>;
  /**
   * Per-case emission policy:
   * - A specific token string → the LLM must emit that exact token.
   * - A `topic:` predicate → the LLM must emit AT LEAST ONE token
   *   matching the topic prefix (e.g. `topic:STOCKS` matches any of
   *   `[STOCKS NVDA]`, `[STOCKS AAPL]`, …). Used for "all my stocks"
   *   queries where any-of-many counts as a hit.
   * - null → no token should be emitted (plain prose answer).
   */
  expected: string | { topic: string } | null;
  klass: 'positive' | 'negative' | 'ambiguous';
}

// Catalog used for most cases — mirrors the PRODUCTION runtime shape
// from `planBlankContextSlots` + `autoDescribeSlot`. Each catalog
// entry is per-slot (per stock, per crypto, per weather location),
// NOT an aggregate per-blank token. This is what the LLM actually
// sees in deployment.
//
// Earlier versions of this bench used an aggregate shape
// (`[STOCKS] — your watchlist (NVDA, AAPL, …)`) which didn't reflect
// the live runtime — the slot-decomposition was discovered while
// debugging a live opencode test that returned "I don't have
// information about your personal stocks" despite the bench
// claiming 100% recall.
// Matches a realistic live config: 3 stock slots from portfolio +
// 1 weather + 1 crypto (BTC). The June 2026 live-catalog probe found
// many production users have stocks-bound-to-portfolio + weather +
// crypto/BTC. Catalogs much larger than this are rare in practice.
const STD_CATALOG = [
  { token: '[STOCKS AAPL]',    description: 'current share price of AAPL',  value: 'AAPL: $311.84' },
  { token: '[STOCKS NVDA]',    description: 'current share price of NVDA',  value: 'NVDA: $220.86' },
  { token: '[STOCKS GOOG]',    description: 'current share price of GOOG',  value: 'GOOG: $371.81' },
  { token: '[WEATHER LONDON]', description: 'current weather in London',    value: 'London: 18°C Overcast' },
  { token: '[CRYPTO BTC]',     description: 'current USD price of BTC',     value: 'BITCOIN: $63,568.00' },
  { token: '[CRYPTO ETH]',     description: 'current USD price of ETH',     value: 'ETHEREUM: $3,521.40' },
] as const;

export const CASES: ReadonlyArray<RecallCase> = [
  // ── POSITIVE — indirect queries that should emit a catalog token ──────
  //
  // Most are "topic" matches — any STOCKS/WEATHER/CRYPTO slot token
  // counts. Specific-ticker queries (`nvda price _`) expect the
  // matching specific slot.

  { id: 'p01', input: "today's update on my watchlist _",         catalog: STD_CATALOG, expected: { topic: 'STOCKS' },   klass: 'positive' },
  { id: 'p02', input: 'how are my stocks doing _',                catalog: STD_CATALOG, expected: { topic: 'STOCKS' },   klass: 'positive' },
  { id: 'p03', input: 'biggest mover in my portfolio _',          catalog: STD_CATALOG, expected: { topic: 'STOCKS' },   klass: 'positive' },
  { id: 'p04', input: 'morning portfolio check _',                catalog: STD_CATALOG, expected: { topic: 'STOCKS' },   klass: 'positive' },
  { id: 'p05', input: 'tech stocks today _',                      catalog: STD_CATALOG, expected: { topic: 'STOCKS' },   klass: 'positive' },

  { id: 'p06', input: "what's the weather doing _",               catalog: STD_CATALOG, expected: { topic: 'WEATHER' },  klass: 'positive' },
  { id: 'p07', input: 'is it raining _',                          catalog: STD_CATALOG, expected: { topic: 'WEATHER' },  klass: 'positive' },
  { id: 'p08', input: 'do i need a jacket _',                     catalog: STD_CATALOG, expected: { topic: 'WEATHER' },  klass: 'positive' },
  { id: 'p09', input: 'current temperature _',                    catalog: STD_CATALOG, expected: { topic: 'WEATHER' },  klass: 'positive' },
  { id: 'p10', input: 'forecast for today _',                     catalog: STD_CATALOG, expected: { topic: 'WEATHER' },  klass: 'positive' },

  { id: 'p11', input: 'how is bitcoin doing _',                   catalog: STD_CATALOG, expected: '[CRYPTO BTC]',        klass: 'positive' },
  { id: 'p12', input: 'crypto check _',                           catalog: STD_CATALOG, expected: { topic: 'CRYPTO' },   klass: 'positive' },
  { id: 'p13', input: 'eth price _',                              catalog: STD_CATALOG, expected: '[CRYPTO ETH]',        klass: 'positive' },

  { id: 'p14', input: 'draft a quick tweet summarizing my portfolio _', catalog: STD_CATALOG, expected: { topic: 'STOCKS' }, klass: 'positive' },
  { id: 'p15', input: 'one-liner: weather outside _',             catalog: STD_CATALOG, expected: { topic: 'WEATHER' },  klass: 'positive' },

  // Generalization cases — phrasings the previous version failed on
  // live. These avoid the exact synonyms used in the auto-generated
  // examples, so they probe whether the "covers:" hints + rule
  // wording generalize beyond the example phrasings.
  { id: 'p16', input: "what's it like outside right now _",       catalog: STD_CATALOG, expected: { topic: 'WEATHER' },  klass: 'positive' },
  { id: 'p17', input: 'do i need an umbrella today _',            catalog: STD_CATALOG, expected: { topic: 'WEATHER' },  klass: 'positive' },
  { id: 'p18', input: 'how is digital currency doing _',          catalog: STD_CATALOG, expected: { topic: 'CRYPTO' },   klass: 'positive' },
  { id: 'p19', input: 'any movers today in my portfolio _',       catalog: STD_CATALOG, expected: { topic: 'STOCKS' },   klass: 'positive' },
  { id: 'p20', input: 'morning briefing on my holdings _',        catalog: STD_CATALOG, expected: { topic: 'STOCKS' },   klass: 'positive' },

  // ── NEGATIVE — catalog is available but query is unrelated ────────────

  { id: 'n01', input: 'capital of france _',                      catalog: STD_CATALOG, expected: null, klass: 'negative' },
  { id: 'n02', input: 'atomic number of oxygen _',                catalog: STD_CATALOG, expected: null, klass: 'negative' },
  { id: 'n03', input: 'speed of light _',                         catalog: STD_CATALOG, expected: null, klass: 'negative' },
  { id: 'n04', input: 'year apollo 11 landed on the moon _',      catalog: STD_CATALOG, expected: null, klass: 'negative' },
  { id: 'n05', input: 'unicode for ampersand _',                  catalog: STD_CATALOG, expected: null, klass: 'negative' },
  { id: 'n06', input: 'hex for blue _',                           catalog: STD_CATALOG, expected: null, klass: 'negative' },
  { id: 'n07', input: 'who invented the telephone _',             catalog: STD_CATALOG, expected: null, klass: 'negative' },
  { id: 'n08', input: 'cube root of 27 _',                        catalog: STD_CATALOG, expected: null, klass: 'negative' },
  { id: 'n09', input: 'longest river in africa _',                catalog: STD_CATALOG, expected: null, klass: 'negative' },
  { id: 'n10', input: 'mime type for png _',                      catalog: STD_CATALOG, expected: null, klass: 'negative' },

  // ── AMBIGUOUS — catalog could plausibly apply ─────────────────────────

  { id: 'a01', input: "how's the market _",                       catalog: STD_CATALOG, expected: { topic: 'STOCKS' },   klass: 'ambiguous' },
  { id: 'a02', input: 'should i wear a coat _',                   catalog: STD_CATALOG, expected: { topic: 'WEATHER' },  klass: 'ambiguous' },
  { id: 'a03', input: 'good day to bike _',                       catalog: STD_CATALOG, expected: { topic: 'WEATHER' },  klass: 'ambiguous' },
  { id: 'a04', input: 'how rich am i _',                          catalog: STD_CATALOG, expected: { topic: 'STOCKS' },   klass: 'ambiguous' },
  { id: 'a05', input: 'sunny outside _',                          catalog: STD_CATALOG, expected: { topic: 'WEATHER' },  klass: 'ambiguous' },
];
