import { describe, it, expect, vi } from 'vitest';
import { StocksBlank } from './stocks';

function fetchOk(body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response)) as unknown as typeof fetch;
}

describe('StocksBlank', () => {
  it('returns empty string when called with no keyword', async () => {
    const ctl = new StocksBlank({ apiKey: 'x', fetchFn: fetchOk({ c: 1 }) });
    expect(await ctl.get()).toBe('');
  });

  it('returns "Unknown: <kw>" for keywords not in the ticker map', async () => {
    const ctl = new StocksBlank({ apiKey: 'x', fetchFn: fetchOk({ c: 1 }) });
    expect(await ctl.get('not-a-ticker')).toBe('Unknown: not-a-ticker');
  });

  it('returns "<TICKER>: no API key" when apiKey is missing', async () => {
    const ctl = new StocksBlank({ fetchFn: fetchOk({ c: 1 }) });
    expect(await ctl.get('aapl')).toBe('AAPL: no API key');
  });

  it('formats Finnhub current-price response as "$X.XX"', async () => {
    const ctl = new StocksBlank({ apiKey: 'k', fetchFn: fetchOk({ c: 201.66 }) });
    expect(await ctl.get('aapl')).toBe('$201.66');
  });

  it('caches subsequent lookups for the same ticker within TTL', async () => {
    const fetchFn = vi.fn(fetchOk({ c: 99.99 }));
    const ctl = new StocksBlank({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    await ctl.get('aapl');
    await ctl.get('apple'); // same ticker via different keyword
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns "<TICKER>: HTTP <code>" on non-ok response', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 429 } as Response)) as unknown as typeof fetch;
    const ctl = new StocksBlank({ apiKey: 'k', fetchFn });
    expect(await ctl.get('aapl')).toBe('AAPL: HTTP 429');
  });

  it('returns "<TICKER>: error" on fetch throw', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const ctl = new StocksBlank({ apiKey: 'k', fetchFn });
    expect(await ctl.get('aapl')).toBe('AAPL: error');
  });

  it('honours customTickers overrides on top of defaults', async () => {
    const ctl = new StocksBlank({
      apiKey: 'k',
      customTickers: { spy: 'SPY' },
      fetchFn: fetchOk({ c: 500.5 }),
    });
    expect(await ctl.get('spy')).toBe('$500.50');
    // Defaults still present.
    expect(await ctl.get('aapl')).toBe('$500.50');
  });
});
