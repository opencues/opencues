/**
 * Unit tests for BlankContextCache. Runs under vitest (the runtime's
 * test runner — see vitest.config.ts).
 *
 * Layers exercised:
 *   - lazy fetch on prompt-build
 *   - per-blank TTL respected on re-call
 *   - capacity cap evicts oldest
 *   - failed fetch surfaces as [STALE], snapshot still builds
 */

import { describe, it, expect } from 'vitest';
import { BlankContextCache } from './blank-context-cache';
import type { Blank } from '../blanks/types';
import type { BlankContextSlot } from '@opencues/core';

class StubBlank implements Blank {
  readonly readOnly = true;
  public calls = 0;
  constructor(
    public readonly name: string,
    private readonly _impl: (slot: string) => Promise<string>,
  ) {}
  async get(slot?: string): Promise<string> {
    this.calls += 1;
    return this._impl(slot ?? '');
  }
}

function plan(blankName: string, slot: string, token: string): BlankContextSlot {
  return { blankName, slot, token, description: 'test slot' };
}

describe('BlankContextCache.snapshot', () => {
  it('fetches once on cold call and caches the result', async () => {
    const stub = new StubBlank('stocks', async slot => `${slot}: $100`);
    const cache = new BlankContextCache({ now: () => 1000 });
    const snap1 = await cache.snapshot(
      [plan('stocks', 'AAPL', '[STOCK AAPL]')],
      new Map([['stocks', stub]]),
      new Map([['stocks', 60_000]]),
    );
    expect(snap1.fields[0].value).toBe('AAPL: $100');
    expect(stub.calls).toBe(1);

    const snap2 = await cache.snapshot(
      [plan('stocks', 'AAPL', '[STOCK AAPL]')],
      new Map([['stocks', stub]]),
      new Map([['stocks', 60_000]]),
    );
    expect(snap2.fields[0].value).toBe('AAPL: $100');
    expect(stub.calls).toBe(1); // cached
  });

  it('re-fetches when TTL has passed', async () => {
    const stub = new StubBlank('stocks', async slot => `${slot}: ${stub.calls}`);
    let now = 1000;
    const cache = new BlankContextCache({ now: () => now });
    await cache.snapshot(
      [plan('stocks', 'AAPL', '[STOCK AAPL]')],
      new Map([['stocks', stub]]),
      new Map([['stocks', 5_000]]),
    );
    now = 1000 + 6_000;
    const snap = await cache.snapshot(
      [plan('stocks', 'AAPL', '[STOCK AAPL]')],
      new Map([['stocks', stub]]),
      new Map([['stocks', 5_000]]),
    );
    expect(stub.calls).toBe(2);
    expect(snap.fields[0].value).toBe('AAPL: 2');
  });

  it('surfaces failed fetches as [STALE] and keeps building', async () => {
    const stub = new StubBlank('stocks', async () => {
      throw new Error('network down');
    });
    const cache = new BlankContextCache();
    const snap = await cache.snapshot(
      [plan('stocks', 'AAPL', '[STOCK AAPL]')],
      new Map([['stocks', stub]]),
      new Map([['stocks', 60_000]]),
    );
    expect(snap.fields.length).toBe(1);
    expect(snap.fields[0].value).toBe('[STALE]');
    expect(snap.catalog.get('[STOCK AAPL]')).toBe('[STALE]');
  });

  it('handles missing blank entry gracefully', async () => {
    const cache = new BlankContextCache();
    const snap = await cache.snapshot(
      [plan('unknown', 'X', '[UNKNOWN X]')],
      new Map(),
      new Map(),
    );
    expect(snap.fields[0].value).toBe('[STALE]');
  });

  it('evicts oldest when capacity is exceeded', async () => {
    const stub = new StubBlank('s', async slot => `v-${slot}`);
    const cache = new BlankContextCache({ capacity: 2 });
    const blanks = new Map([['s', stub]]);
    const ttls = new Map([['s', 60_000]]);
    await cache.snapshot([plan('s', 'A', '[S A]')], blanks, ttls);
    await cache.snapshot([plan('s', 'B', '[S B]')], blanks, ttls);
    await cache.snapshot([plan('s', 'C', '[S C]')], blanks, ttls);
    expect(cache.size()).toBe(2);
  });

  it('re-fetches an entry whose previous fetch errored', async () => {
    let mode: 'fail' | 'ok' = 'fail';
    const stub = new StubBlank('w', async () => {
      if (mode === 'fail') throw new Error('boom');
      return 'ok value';
    });
    const cache = new BlankContextCache({ now: () => 1000 });
    const snap1 = await cache.snapshot(
      [plan('w', 'london', '[WEATHER LONDON]')],
      new Map([['w', stub]]),
      new Map([['w', 60_000]]),
    );
    expect(snap1.fields[0].value).toBe('[STALE]');

    mode = 'ok';
    const snap2 = await cache.snapshot(
      [plan('w', 'london', '[WEATHER LONDON]')],
      new Map([['w', stub]]),
      new Map([['w', 60_000]]),
    );
    // null value should re-fetch even within ttl
    expect(snap2.fields[0].value).toBe('ok value');
  });

  it('clear() drops every cached tuple', async () => {
    const stub = new StubBlank('s', async slot => slot);
    const cache = new BlankContextCache();
    await cache.snapshot(
      [plan('s', 'A', '[S A]')],
      new Map([['s', stub]]),
      new Map([['s', 60_000]]),
    );
    expect(cache.size()).toBe(1);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
