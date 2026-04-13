import type { BrowserControl } from './types';

/**
 * Stock price control using Finnhub API.
 * Read-only: fetches live price for a ticker keyword.
 *
 * Runs in content script; CORS-safe via service worker fallback.
 */

const DEFAULT_TICKERS: Record<string, string> = {
  aapl: 'AAPL', apple: 'AAPL',
  goog: 'GOOGL', google: 'GOOGL',
  msft: 'MSFT', microsoft: 'MSFT',
  amzn: 'AMZN', amazon: 'AMZN',
  tsla: 'TSLA', tesla: 'TSLA',
  meta: 'META', facebook: 'META',
  nvda: 'NVDA', nvidia: 'NVDA',
  rddt: 'RDDT', reddit: 'RDDT',
  nflx: 'NFLX', netflix: 'NFLX',
  spot: 'SPOT', spotify: 'SPOT',
};

/** Cache: ticker → { price, timestamp } */
const cache = new Map<string, { price: string; ts: number }>();
const CACHE_TTL = 60_000; // 1 minute

export class StocksControl implements BrowserControl {
  readonly name = 'stocks';
  readonly readOnly = true;
  private apiKey: string;
  private tickers: Record<string, string>;

  constructor(apiKey?: string, customTickers?: Record<string, string>) {
    this.apiKey = apiKey || '';
    this.tickers = { ...DEFAULT_TICKERS, ...customTickers };
  }

  async get(keyword?: string): Promise<string> {
    if (!keyword) return '';
    const ticker = this.tickers[keyword.toLowerCase()];
    if (!ticker) return `Unknown: ${keyword}`;

    // Check cache
    const cached = cache.get(ticker);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.price;

    if (!this.apiKey) return `${ticker}: no API key`;

    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${this.apiKey}`;
      const resp = await this.fetchWithFallback(url);
      const data = JSON.parse(resp);
      const price = `$${data.c?.toFixed(2) ?? '?'}`;
      const display = `${ticker}: ${price}`;
      cache.set(ticker, { price: display, ts: Date.now() });
      return display;
    } catch {
      return `${ticker}: error`;
    }
  }

  /** Try direct fetch, fall back to service worker proxy for CORS */
  private async fetchWithFallback(url: string): Promise<string> {
    try {
      const resp = await fetch(url);
      if (resp.ok) return resp.text();
    } catch { /* CORS blocked, try service worker */ }

    // Proxy via background service worker
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'api-request', url, method: 'GET' },
        (response) => {
          if (response?.ok) resolve(response.text);
          else reject(new Error(response?.error || 'proxy failed'));
        },
      );
    });
  }
}
