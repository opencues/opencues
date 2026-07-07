import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuotaTracker } from './quota';

// Per-blank quota enforcement (sliding-60s window + hard ceilings).
// See quota.ts's header comment for the threat model: a runaway or
// malicious user-blank shouldn't be able to hammer external APIs or
// fill the user's disk. Defaults: 120 fetches/min, 30 LLM/min, 1MB
// storage. Hard ceilings: 600/min, 120/min, 10MB — even an author who
// declares a higher cap in frontmatter is clamped.

describe('createQuotaTracker — happy path', () => {
  it('allows fetches under the default cap without throwing', () => {
    const q = createQuotaTracker();
    for (let i = 0; i < 10; i++) {
      expect(() => q.recordFetch()).not.toThrow();
    }
    expect(q.inspect().fetches).toBe(10);
  });

  it('allows llm calls under the default cap without throwing', () => {
    const q = createQuotaTracker();
    for (let i = 0; i < 5; i++) {
      expect(() => q.recordLlm()).not.toThrow();
    }
    expect(q.inspect().llm).toBe(5);
  });

  it('allows storage writes under the default cap', () => {
    const q = createQuotaTracker();
    expect(() => q.checkStorageBytes(1024)).not.toThrow();
  });

  it('inspect() reports configured maxima alongside live counts', () => {
    const q = createQuotaTracker({ maxFetchesPerMinute: 5, maxLlmPerMinute: 2, maxStorageBytes: 100 });
    const snap = q.inspect();
    expect(snap).toEqual({ fetches: 0, llm: 0, maxFetches: 5, maxLlm: 2, maxStorage: 100 });
  });

  it('fetch and llm counters are independent within one tracker', () => {
    const q = createQuotaTracker({ maxFetchesPerMinute: 2, maxLlmPerMinute: 2 });
    q.recordFetch();
    q.recordFetch();
    expect(() => q.recordFetch()).toThrow(/fetch rate-limit exceeded/);
    // llm budget untouched by fetch exhaustion
    expect(() => q.recordLlm()).not.toThrow();
  });
});

describe('createQuotaTracker — limit boundaries', () => {
  it('permits exactly N calls at cap N, refuses the (N+1)th', () => {
    const q = createQuotaTracker({ maxFetchesPerMinute: 3 });
    q.recordFetch();
    q.recordFetch();
    q.recordFetch();
    expect(q.inspect().fetches).toBe(3);
    expect(() => q.recordFetch()).toThrow(/quota: fetch rate-limit exceeded \(3\/min\)/);
    // Still refused on repeat — this isn't a one-shot rejection.
    expect(() => q.recordFetch()).toThrow();
  });

  it('permits exactly N llm calls at cap N, refuses the (N+1)th', () => {
    const q = createQuotaTracker({ maxLlmPerMinute: 2 });
    q.recordLlm();
    q.recordLlm();
    expect(() => q.recordLlm()).toThrow(/quota: llm rate-limit exceeded \(2\/min\)/);
  });

  it('checkStorageBytes allows a value exactly AT the cap (only strictly-over throws)', () => {
    const q = createQuotaTracker({ maxStorageBytes: 500 });
    expect(() => q.checkStorageBytes(500)).not.toThrow();
    expect(() => q.checkStorageBytes(501)).toThrow(/quota: storage size 501b exceeds cap 500b/);
  });

  it('rejects a zero-configured cap on the very first call', () => {
    const q = createQuotaTracker({ maxFetchesPerMinute: 0 });
    expect(() => q.recordFetch()).toThrow(/quota: fetch rate-limit exceeded \(0\/min\)/);
  });
});

describe('createQuotaTracker — hard ceilings', () => {
  it('clamps an outrageous author-declared fetch cap to the hard ceiling (600/min)', () => {
    const q = createQuotaTracker({ maxFetchesPerMinute: 999_999 });
    expect(q.inspect().maxFetches).toBe(600);
  });

  it('clamps an outrageous author-declared llm cap to the hard ceiling (120/min)', () => {
    const q = createQuotaTracker({ maxLlmPerMinute: 999_999 });
    expect(q.inspect().maxLlm).toBe(120);
  });

  it('clamps an outrageous author-declared storage cap to the hard ceiling (10MB)', () => {
    const q = createQuotaTracker({ maxStorageBytes: 999_999_999 });
    expect(q.inspect().maxStorage).toBe(10 * 1024 * 1024);
  });

  it('a cap declared BELOW the hard ceiling is honoured as-is (ceiling is a cap, not a floor)', () => {
    const q = createQuotaTracker({ maxFetchesPerMinute: 10 });
    expect(q.inspect().maxFetches).toBe(10);
  });

  it('defaults are themselves under the hard ceilings when no config is given', () => {
    const q = createQuotaTracker();
    const snap = q.inspect();
    expect(snap.maxFetches).toBe(120);
    expect(snap.maxLlm).toBe(30);
    expect(snap.maxStorage).toBe(1024 * 1024);
  });
});

describe('createQuotaTracker — invalid / adversarial input', () => {
  it('a negative configured cap refuses every call immediately (0 >= negative is true)', () => {
    // Documents current behaviour: Math.min(-5, 600) = -5, and the
    // sliding-window check is `fetches.length >= maxFetches`, so an
    // empty array (length 0) already trips a negative cap. This is a
    // safe failure mode (denies rather than allows unbounded calls),
    // not a bypass — pinning it so a future refactor doesn't silently
    // turn a negative config into "unlimited".
    const q = createQuotaTracker({ maxFetchesPerMinute: -5 });
    expect(() => q.recordFetch()).toThrow(/quota: fetch rate-limit exceeded \(-5\/min\)/);
  });

  it('a negative maxStorageBytes still allows checkStorageBytes(0) (0 > -5 is false, but any positive size throws)', () => {
    const q = createQuotaTracker({ maxStorageBytes: -5 });
    expect(() => q.checkStorageBytes(0)).toThrow(/quota: storage size 0b exceeds cap -5b/);
  });

  it('rapid-fire calls within the same millisecond are all counted individually', () => {
    // The sliding window keys on Date.now() timestamps, but the check
    // is against array LENGTH, not distinct timestamps — several
    // calls landing in the same tick still consume budget one-by-one.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const q = createQuotaTracker({ maxFetchesPerMinute: 3 });
      q.recordFetch();
      q.recordFetch();
      q.recordFetch();
      expect(q.inspect().fetches).toBe(3);
      expect(() => q.recordFetch()).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkStorageBytes with a negative currentBytes never throws (defensive — caller-side bug, not this module\'s concern)', () => {
    const q = createQuotaTracker({ maxStorageBytes: 100 });
    expect(() => q.checkStorageBytes(-50)).not.toThrow();
  });
});

describe('createQuotaTracker — sliding window rollover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('entries older than 60s are pruned and free up budget', () => {
    vi.setSystemTime(0);
    const q = createQuotaTracker({ maxFetchesPerMinute: 2 });
    q.recordFetch();
    q.recordFetch();
    expect(() => q.recordFetch()).toThrow();

    // Advance to just past the 60s window boundary.
    vi.setSystemTime(60_001);
    expect(() => q.recordFetch()).not.toThrow();
    expect(q.inspect().fetches).toBe(1);
  });

  it('entries exactly at the 60s boundary are NOT yet pruned (cutoff comparison is strict-less-than)', () => {
    vi.setSystemTime(0);
    const q = createQuotaTracker({ maxFetchesPerMinute: 1 });
    q.recordFetch();
    // prune() drops entries strictly less than `now - 60_000`; an
    // entry recorded at t=0 is dropped once now=60_000 (cutoff=0, and
    // the loop condition is `arr[0] < cutoff`, i.e. 0 < 0 is false —
    // so it is NOT pruned yet at exactly 60_000).
    vi.setSystemTime(60_000);
    expect(() => q.recordFetch()).toThrow();
    // One tick later it finally falls out of the window.
    vi.setSystemTime(60_001);
    expect(() => q.recordFetch()).not.toThrow();
  });

  it('a partially-full window keeps only the still-live entries after a partial rollover', () => {
    vi.setSystemTime(0);
    const q = createQuotaTracker({ maxFetchesPerMinute: 3 });
    q.recordFetch(); // t=0
    vi.setSystemTime(30_000);
    q.recordFetch(); // t=30000
    vi.setSystemTime(61_000); // t=0 entry now stale (61000-60000=1000 > 0), t=30000 still live
    expect(q.inspect().fetches).toBe(1);
    expect(() => q.recordFetch()).not.toThrow();
    expect(() => q.recordFetch()).not.toThrow();
    // Budget of 3: one live carry-over + two new = at cap now.
    expect(() => q.recordFetch()).toThrow();
  });
});

describe('createQuotaTracker — multiple independent trackers', () => {
  it('two trackers do not share state', () => {
    const a = createQuotaTracker({ maxFetchesPerMinute: 1 });
    const b = createQuotaTracker({ maxFetchesPerMinute: 1 });
    a.recordFetch();
    expect(() => a.recordFetch()).toThrow();
    // b's budget is untouched by a's usage.
    expect(() => b.recordFetch()).not.toThrow();
  });

  it('per-blank config differences are respected independently', () => {
    const generous = createQuotaTracker({ maxFetchesPerMinute: 500 });
    const stingy = createQuotaTracker({ maxFetchesPerMinute: 1 });
    stingy.recordFetch();
    expect(() => stingy.recordFetch()).toThrow();
    for (let i = 0; i < 50; i++) {
      expect(() => generous.recordFetch()).not.toThrow();
    }
  });
});
