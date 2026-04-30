// CryptoControl — fetches a live crypto price from CoinGecko's public
// API (no auth on the demo / free tier). Read-only. 60s cache per coin.
// Returns "$68,432.50"-style strings.
//
// Mirrors StocksControl shape: keyword maps to a CoinGecko coin ID
// (e.g. "btc" → "bitcoin", "eth" → "ethereum"). Hosts can extend the
// coin map via `customCoins` at construction.

import type { Blank } from './types';

// CoinGecko uses slug-style IDs (not ticker symbols) — "bitcoin", not "BTC".
const DEFAULT_COINS: Record<string, string> = {
  btc: 'bitcoin', bitcoin: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum',
  sol: 'solana', solana: 'solana',
  ada: 'cardano', cardano: 'cardano',
  xrp: 'ripple', ripple: 'ripple', xrp_coin: 'ripple',
  doge: 'dogecoin', dogecoin: 'dogecoin',
  matic: 'matic-network', polygon: 'matic-network',
  dot: 'polkadot', polkadot: 'polkadot',
  avax: 'avalanche-2', avalanche: 'avalanche-2',
  link: 'chainlink', chainlink: 'chainlink',
  uni: 'uniswap', uniswap: 'uniswap',
  ltc: 'litecoin', litecoin: 'litecoin',
  bnb: 'binancecoin', binance: 'binancecoin',
  trx: 'tron', tron: 'tron',
  shib: 'shiba-inu', shiba: 'shiba-inu',
};

const CACHE_TTL_MS = 60_000;
const ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price';

export interface CryptoControlOptions {
  /** Extra keyword → CoinGecko coin-id mappings, merged on top of DEFAULT_COINS. */
  readonly customCoins?: Record<string, string>;
  /** Override fetch — same shape as globalThis.fetch. */
  readonly fetchFn?: typeof fetch;
  /** Override TTL for testing (default 60s). */
  readonly cacheTtlMs?: number;
}

export class CryptoControl implements Blank {
  readonly name = 'crypto';
  readonly readOnly = true;
  private readonly _coins: Record<string, string>;
  private readonly _fetch: typeof fetch;
  private readonly _ttl: number;
  private readonly _cache = new Map<string, { price: string; ts: number }>();

  constructor(opts: CryptoControlOptions = {}) {
    this._coins = { ...DEFAULT_COINS, ...(opts.customCoins ?? {}) };
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this._ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  }

  async get(keyword?: string): Promise<string> {
    if (!keyword) return '';
    const id = this._coins[keyword.toLowerCase().trim()];
    if (!id) return `Unknown: ${keyword}`;

    const cached = this._cache.get(id);
    if (cached && Date.now() - cached.ts < this._ttl) return cached.price;

    try {
      const url = `${ENDPOINT}?ids=${id}&vs_currencies=usd`;
      const resp = await this._fetch(url);
      if (!resp.ok) return `${id}: HTTP ${resp.status}`;
      const data = (await resp.json()) as Record<string, { usd?: number }>;
      const usd = data[id]?.usd;
      if (usd == null) return `${id}: no price`;
      // Format: $68,432.50 (commas + 2 decimals when < $1, else integers)
      const price = usd < 1
        ? `$${usd.toFixed(4)}`
        : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      this._cache.set(id, { price, ts: Date.now() });
      return price;
    } catch {
      return `${id}: error`;
    }
  }
}
