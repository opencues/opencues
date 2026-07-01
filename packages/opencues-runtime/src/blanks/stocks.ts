// StocksBlank — fetches a live stock quote from Finnhub for a
// keyword that maps to a ticker (e.g. "aapl" → AAPL, "Tesla" → TSLA).
// Read-only. 1-minute cache per ticker. Returns "$201.66"-style strings.
//
// The default ticker map covers the most-asked names; hosts can extend
// it with `customTickers` at construction time. Without an API key the
// blank returns a friendly "<TICKER>: no API key" so missing config
// doesn't masquerade as a network error.

import type { Blank } from './types';

const DEFAULT_TICKERS: Record<string, string> = {
  rddt: 'RDDT', reddit: 'RDDT', 'reddit stock': 'RDDT',
  nvda: 'NVDA', nvidia: 'NVDA', 'nvidia stock': 'NVDA',
  aapl: 'AAPL', apple: 'AAPL', 'apple stock': 'AAPL',
  googl: 'GOOGL', google: 'GOOGL', 'google stock': 'GOOGL',
  msft: 'MSFT', microsoft: 'MSFT', 'microsoft stock': 'MSFT',
  amzn: 'AMZN', amazon: 'AMZN', 'amazon stock': 'AMZN',
  tsla: 'TSLA', tesla: 'TSLA', 'tesla stock': 'TSLA',
  meta: 'META', 'meta stock': 'META',
};

const CACHE_TTL_MS = 60_000;

export interface StocksBlankOptions {
  /** Finnhub API key. Without it, get() returns "<TICKER>: no API key". */
  readonly apiKey?: string;
  /** Extra keyword → ticker mappings, merged on top of DEFAULT_TICKERS. */
  readonly customTickers?: Record<string, string>;
  /** Override fetch — same shape as globalThis.fetch. Tests + sandboxed
   *  hosts that need a CORS-proxy wrapper inject here. Defaults to
   *  globalThis.fetch.bind(globalThis). */
  readonly fetchFn?: typeof fetch;
}

export class StocksBlank implements Blank {
  readonly name = 'stocks';
  readonly readOnly = true;
  private readonly _apiKey: string;
  private readonly _tickers: Record<string, string>;
  private readonly _fetch: typeof fetch;
  private readonly _cache = new Map<string, { price: string; ts: number }>();

  constructor(opts: StocksBlankOptions = {}) {
    this._apiKey = opts.apiKey ?? '';
    this._tickers = { ...DEFAULT_TICKERS, ...(opts.customTickers ?? {}) };
    // Bind to globalThis when capturing the default — bare fetch.call
    // throws "Illegal invocation" in browsers (window.fetch needs window
    // as `this`). Same pattern as HackerNewsBlank.
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async get(keyword?: string): Promise<string> {
    if (!keyword) return '';
    // Known company-name/alias → ticker (tesla → TSLA). Otherwise treat the
    // arg AS a ticker symbol — this is what makes the ai-callable on-demand
    // path work for ANY ticker (AMD, INTC), not just the hardcoded aliases.
    // SANITIZE to [A-Z0-9.] — the on-demand arg is LLM-chosen and flows into
    // the Finnhub URL, so bound it to a valid symbol shape (ai-callable floor).
    const mapped = this._tickers[keyword.toLowerCase()];
    const ticker = (mapped ?? keyword).toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!ticker) return `Unknown: ${keyword}`;

    const cached = this._cache.get(ticker);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.price;

    if (!this._apiKey) return `${ticker}: no API key`;

    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${this._apiKey}`;
      const resp = await this._fetch(url);
      if (!resp.ok) return `${ticker}: HTTP ${resp.status}`;
      const data = (await resp.json()) as { c?: number };
      // Embed ticker so the output is self-contained: a shaped get clears
      // the whole command span ("nvda _" → "NVDA: $198.47").
      const price = `${ticker}: $${data.c?.toFixed(2) ?? '?'}`;
      this._cache.set(ticker, { price, ts: Date.now() });
      return price;
    } catch {
      return `${ticker}: error`;
    }
  }
}
