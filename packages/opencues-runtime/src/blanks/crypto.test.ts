import { describe, it, expect, vi } from 'vitest';
import { CryptoBlank } from './crypto';

function fetchOk(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response)) as unknown as typeof fetch;
}

describe('CryptoBlank', () => {
  it('returns empty string when called with no keyword', async () => {
    const ctl = new CryptoBlank({ fetchFn: fetchOk({}) });
    expect(await ctl.get()).toBe('');
  });

  it('returns "Unknown: <kw>" for keywords not in the coin map', async () => {
    const ctl = new CryptoBlank({ fetchFn: fetchOk({}) });
    expect(await ctl.get('not-a-coin')).toBe('Unknown: not-a-coin');
  });

  it('formats price >= $1 with commas + 2 decimals', async () => {
    const ctl = new CryptoBlank({ fetchFn: fetchOk({ bitcoin: { usd: 68432.5 } }) });
    expect(await ctl.get('btc')).toBe('BTC: $68,432.50');
  });

  it('formats price < $1 with 4 decimals (no commas)', async () => {
    const ctl = new CryptoBlank({ fetchFn: fetchOk({ dogecoin: { usd: 0.1245 } }) });
    expect(await ctl.get('doge')).toBe('DOGE: $0.1245');
  });

  it('maps multiple keywords to the same coin id (btc/bitcoin → bitcoin)', async () => {
    const fetchFn = vi.fn(fetchOk({ bitcoin: { usd: 100 } }));
    const ctl = new CryptoBlank({ fetchFn: fetchFn as unknown as typeof fetch, cacheTtlMs: 60_000 });
    await ctl.get('btc');
    await ctl.get('bitcoin');
    // Only one network call — same coin-id, cache hit on second.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns "<id>: HTTP <code>" on non-ok response', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 429 } as Response)) as unknown as typeof fetch;
    const ctl = new CryptoBlank({ fetchFn });
    expect(await ctl.get('btc')).toBe('bitcoin: HTTP 429');
  });

  it('returns "<id>: error" on fetch throw', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const ctl = new CryptoBlank({ fetchFn });
    expect(await ctl.get('btc')).toBe('bitcoin: error');
  });

  it('honours customCoins overrides on top of defaults', async () => {
    // Mock returns price data keyed by whatever id is requested in the URL.
    const fetchFn = vi.fn(async (url: string) => {
      const id = new URL(url).searchParams.get('ids')!;
      const usd = id === 'pepe' ? 0.0000123 : 100;
      return {
        ok: true, status: 200,
        json: async () => ({ [id]: { usd } }),
        text: async () => '',
      } as Response;
    }) as unknown as typeof fetch;
    const ctl = new CryptoBlank({
      customCoins: { pepe: 'pepe' },
      fetchFn,
    });
    expect(await ctl.get('pepe')).toBe('PEPE: $0.0000');
    expect(await ctl.get('btc')).toBe('BTC: $100.00');
  });

  it('returns "<id>: no price" when API returns no price field', async () => {
    const ctl = new CryptoBlank({ fetchFn: fetchOk({ bitcoin: {} }) });
    expect(await ctl.get('btc')).toBe('bitcoin: no price');
  });
});
