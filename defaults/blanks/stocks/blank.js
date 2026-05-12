/// <reference path="../../user-blank.d.ts" />
/**
 * @type {import('../../user-blank').UserBlankModule}
 *
 * stocks — live stock quotes via Finnhub. 60s cache per ticker.
 * Migrated from packages/opencues-runtime/src/blanks/stocks.ts
 * (May 2026).
 *
 * Demonstrates the `secrets:` capability — declares FINNHUB_API_KEY
 * in BLANK.md, reads it via ctx.secrets.FINNHUB_API_KEY at runtime.
 * No key → friendly "<TICKER>: no API key" (same as the TS class).
 */

const CACHE_TTL_MS = 60_000;

const TICKERS = {
  rddt: 'RDDT', reddit: 'RDDT', 'reddit stock': 'RDDT',
  nvda: 'NVDA', nvidia: 'NVDA', 'nvidia stock': 'NVDA',
  aapl: 'AAPL', apple: 'AAPL', 'apple stock': 'AAPL',
  googl: 'GOOGL', google: 'GOOGL', 'google stock': 'GOOGL',
  msft: 'MSFT', microsoft: 'MSFT', 'microsoft stock': 'MSFT',
  amzn: 'AMZN', amazon: 'AMZN', 'amazon stock': 'AMZN',
  tsla: 'TSLA', tesla: 'TSLA', 'tesla stock': 'TSLA',
  meta: 'META', 'meta stock': 'META',
};

export default {
  async get(ctx, args) {
    const keyword = (args[0] || '').toLowerCase();
    if (!keyword) return '';
    const ticker = TICKERS[keyword];
    if (!ticker) return 'Unknown: ' + keyword;

    const cacheKey = 'price:' + ticker;
    const tsKey = 'ts:' + ticker;
    const cached = await ctx.storage.get(cacheKey);
    const cacheTsStr = await ctx.storage.get(tsKey);
    const cacheTs = cacheTsStr ? parseInt(cacheTsStr, 10) : 0;
    if (cached && ctx.now() - cacheTs < CACHE_TTL_MS) return cached;

    const apiKey = ctx.secrets && ctx.secrets.FINNHUB_API_KEY;
    if (!apiKey) return ticker + ': no API key';

    try {
      const url = 'https://finnhub.io/api/v1/quote?symbol=' + ticker + '&token=' + apiKey;
      const resp = await ctx.fetch(url);
      if (!resp.ok) return ticker + ': HTTP ' + resp.status;
      const data = await resp.json();
      // Embed ticker in the answer so `blankReplace: auto` produces
      // self-contained output when the trigger is wiped
      // ("nvda _" → "NVDA: $198.47").
      const price = ticker + ': $' + (data.c != null ? data.c.toFixed(2) : '?');
      await ctx.storage.set(cacheKey, price);
      await ctx.storage.set(tsKey, String(ctx.now()));
      return price;
    } catch (e) {
      return ticker + ': error';
    }
  },
};
