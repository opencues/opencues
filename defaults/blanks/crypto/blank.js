/// <reference path="../../user-blank.d.ts" />
/**
 * @type {import('../../user-blank').UserBlankModule}
 *
 * crypto — live crypto prices via CoinGecko (no auth on free tier).
 * 60s cache per coin. Migrated from
 * packages/opencues-runtime/src/blanks/crypto.ts (May 2026).
 */

const ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price';
const CACHE_TTL_MS = 60_000;

const COINS = {
  btc: 'bitcoin', bitcoin: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum',
  sol: 'solana', solana: 'solana',
  ada: 'cardano', cardano: 'cardano',
  xrp: 'ripple', ripple: 'ripple',
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

export default {
  async get(ctx, args) {
    const keyword = (args[0] || '').toLowerCase().trim();
    if (!keyword) return '';
    const id = COINS[keyword];
    if (!id) return 'Unknown: ' + keyword;

    const cacheKey = 'price:' + id;
    const tsKey = 'ts:' + id;
    const cached = await ctx.storage.get(cacheKey);
    const cacheTsStr = await ctx.storage.get(tsKey);
    const cacheTs = cacheTsStr ? parseInt(cacheTsStr, 10) : 0;
    if (cached && ctx.now() - cacheTs < CACHE_TTL_MS) return cached;

    try {
      const url = ENDPOINT + '?ids=' + id + '&vs_currencies=usd';
      const resp = await ctx.fetch(url);
      if (!resp.ok) return id + ': HTTP ' + resp.status;
      const data = await resp.json();
      const usd = data[id] && data[id].usd;
      if (usd == null) return id + ': no price';
      const price = usd < 1
        ? '$' + usd.toFixed(4)
        : '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      await ctx.storage.set(cacheKey, price);
      await ctx.storage.set(tsKey, String(ctx.now()));
      return price;
    } catch (e) {
      return id + ': error';
    }
  },
};
