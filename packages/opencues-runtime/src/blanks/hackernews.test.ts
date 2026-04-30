import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HackerNewsControl } from './hackernews';

function mockFetch(responses: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    for (const [pattern, body] of Object.entries(responses)) {
      if (u.includes(pattern)) {
        return {
          ok: true,
          json: async () => body,
          text: async () => JSON.stringify(body),
        } as Response;
      }
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe('HackerNewsControl', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns one title per line for the top stories', async () => {
    const fetchFn = mockFetch({
      'topstories.json': [101, 102, 103],
      '101.json': { title: 'First story' },
      '102.json': { title: 'Second story' },
      '103.json': { title: 'Third story' },
    });
    const ctl = new HackerNewsControl({ fetchFn });
    const out = await ctl.get();
    expect(out).toBe('First story\nSecond story\nThird story');
  });

  it('caches results between calls within TTL', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      calls += 1;
      const u = String(url);
      const body = u.includes('topstories.json') ? [1] : { title: 'cached' };
      return {
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as unknown as typeof fetch;
    const ctl = new HackerNewsControl({ fetchFn });
    await ctl.get();
    const firstCallCount = calls;
    await ctl.get();
    // Second call inside the 5-minute TTL should not re-fetch.
    expect(calls).toBe(firstCallCount);
  });

  it('serves stale cache on fetch errors when cache is populated', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (mode === 'fail') throw new Error('network down');
      const u = String(url);
      const body = u.includes('topstories.json') ? [1] : { title: 'persisted' };
      return {
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }) as unknown as typeof fetch;
    const ctl = new HackerNewsControl({ fetchFn });
    await ctl.get(); // populate
    mode = 'fail';
    // Force expire by waiting (vi.advanceTimersByTime skipped — we
    // exercise the catch path by switching mode). Cache TTL is 5min so
    // the next call within a few ms still hits the cache. Force cache
    // miss by reaching into the instance.
    (ctl as unknown as { _cacheTs: number })._cacheTs = 0;
    const out = await ctl.get();
    // Got the throw, fell back to stale cache.
    expect(out).toBe('persisted');
  });

  it('returns "HN: fetch error" when fetch fails AND cache is empty', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('cold start network down'); }) as unknown as typeof fetch;
    const ctl = new HackerNewsControl({ fetchFn });
    expect(await ctl.get()).toBe('HN: fetch error');
  });

  it('default fetch is bound to globalThis (no Illegal invocation)', async () => {
    // Browsers throw "Illegal invocation" when window.fetch is called
    // without window as `this`. Stub globalThis.fetch with a function
    // that THROWS unless called with the correct `this` to prove the
    // bind is in place.
    const realFetch = globalThis.fetch;
    let invocationContext: unknown = undefined;
    (globalThis as { fetch: unknown }).fetch = function (this: unknown, _url: unknown) {
      invocationContext = this;
      return Promise.resolve({
        ok: true,
        json: async () => [],
        text: async () => '[]',
      } as Response);
    };
    try {
      const ctl = new HackerNewsControl();
      await ctl.get();
      expect(invocationContext).toBe(globalThis);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    }
  });

  it('skips stories whose title is missing', async () => {
    const fetchFn = mockFetch({
      'topstories.json': [1, 2],
      '1.json': { title: 'kept' },
      '2.json': { /* no title */ },
    });
    const ctl = new HackerNewsControl({ fetchFn });
    expect(await ctl.get()).toBe('kept');
  });
});
