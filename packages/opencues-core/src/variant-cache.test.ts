// VariantCache — generic per-key LRU cache state machine.
// Shared primitive used by FluidBlank / ConfigIntent / TransformBlank.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { VariantCache } from './variant-cache';

describe('VariantCache — building phase', () => {
  it('every select returns kind=fresh while entries.length < poolSize', () => {
    const c = new VariantCache<string>(3, 32);
    assert.strictEqual(c.select('k').kind, 'fresh');
    c.record('k', 'a');
    assert.strictEqual(c.select('k').kind, 'fresh');
    c.record('k', 'b');
    assert.strictEqual(c.select('k').kind, 'fresh');
    c.record('k', 'c');
    // pool now full → next select cycles
    assert.strictEqual(c.select('k').kind, 'cache');
  });

  it('size() reflects entries.length per key', () => {
    const c = new VariantCache<string>(3, 32);
    assert.strictEqual(c.size('k'), 0);
    c.record('k', 'a');
    assert.strictEqual(c.size('k'), 1);
    c.record('k', 'b');
    assert.strictEqual(c.size('k'), 2);
  });

  it('fresh.others carries the current entries snapshot (read-only)', () => {
    const c = new VariantCache<string>(3, 32);
    c.record('k', 'a');
    c.record('k', 'b');
    const r = c.select('k');
    assert.strictEqual(r.kind, 'fresh');
    assert.deepStrictEqual(r.others, ['a', 'b']);
  });
});

describe('VariantCache — cycling phase', () => {
  it('serves each entry in order, then enters refresh', () => {
    const c = new VariantCache<string>(3, 32);
    c.record('k', 'a');
    c.record('k', 'b');
    c.record('k', 'c');
    // pool full → next 3 selects are cache hits
    const r1 = c.select('k');
    assert.strictEqual(r1.kind, 'cache');
    if (r1.kind === 'cache') assert.strictEqual(r1.value, 'a');

    const r2 = c.select('k');
    assert.strictEqual(r2.kind, 'cache');
    if (r2.kind === 'cache') assert.strictEqual(r2.value, 'b');

    const r3 = c.select('k');
    assert.strictEqual(r3.kind, 'cache');
    if (r3.kind === 'cache') assert.strictEqual(r3.value, 'c');

    // cycle done → refresh
    assert.strictEqual(c.select('k').kind, 'fresh');
  });

  it('cache.others excludes the just-served value', () => {
    const c = new VariantCache<string>(3, 32);
    c.record('k', 'a');
    c.record('k', 'b');
    c.record('k', 'c');
    const r = c.select('k');
    assert.strictEqual(r.kind, 'cache');
    if (r.kind === 'cache') {
      assert.strictEqual(r.value, 'a');
      assert.deepStrictEqual(r.others, ['b', 'c']);
    }
  });
});

describe('VariantCache — refresh phase + FIFO eviction', () => {
  it('record() at capacity evicts oldest and resets cyclePos', () => {
    const c = new VariantCache<string>(3, 32);
    c.record('k', 'a');
    c.record('k', 'b');
    c.record('k', 'c');
    // cycle through all
    c.select('k'); c.select('k'); c.select('k');
    // refresh phase
    const r = c.select('k');
    assert.strictEqual(r.kind, 'fresh');
    // record evicts oldest ('a')
    c.record('k', 'd');
    assert.deepStrictEqual(c.entries('k'), ['b', 'c', 'd']);
    // cyclePos reset → next 3 selects cycle b → c → d
    const r1 = c.select('k');
    assert.strictEqual(r1.kind, 'cache');
    if (r1.kind === 'cache') assert.strictEqual(r1.value, 'b');
  });
});

describe('VariantCache — LRU eviction on outer Map', () => {
  it('exceeding keyCap evicts least-recently-used key', () => {
    const c = new VariantCache<string>(3, 3);  // keyCap=3
    c.record('k1', 'v1');
    c.record('k2', 'v2');
    c.record('k3', 'v3');
    assert.strictEqual(c.size('k1'), 1);
    // k4 evicts k1 (oldest unused)
    c.record('k4', 'v4');
    assert.strictEqual(c.size('k1'), 0);
    assert.strictEqual(c.size('k4'), 1);
  });

  it('select() touches LRU recency (delete + re-insert)', () => {
    const c = new VariantCache<string>(3, 3);
    c.record('k1', 'v1');
    c.record('k2', 'v2');
    c.record('k3', 'v3');
    // touch k1 — moves it to tail
    c.select('k1');
    // k4 should now evict k2 (oldest after the touch)
    c.record('k4', 'v4');
    assert.strictEqual(c.size('k1'), 1);
    assert.strictEqual(c.size('k2'), 0);
  });
});

describe('VariantCache — generic value types', () => {
  it('works with structured value types (TransformBlank shape)', () => {
    const c = new VariantCache<{ rewrite: string; span: string }>(3, 32);
    c.record('k', { rewrite: 'r1', span: 's1' });
    c.record('k', { rewrite: 'r2', span: 's2' });
    c.record('k', { rewrite: 'r3', span: 's3' });
    const r = c.select('k');
    assert.strictEqual(r.kind, 'cache');
    if (r.kind === 'cache') {
      assert.deepStrictEqual(r.value, { rewrite: 'r1', span: 's1' });
      assert.deepStrictEqual(r.others, [
        { rewrite: 'r2', span: 's2' },
        { rewrite: 'r3', span: 's3' },
      ]);
    }
  });
});

describe('VariantCache — clear()', () => {
  it('empties all keys', () => {
    const c = new VariantCache<string>(3, 32);
    c.record('k1', 'v1');
    c.record('k2', 'v2');
    c.clear();
    assert.strictEqual(c.size('k1'), 0);
    assert.strictEqual(c.size('k2'), 0);
  });
});
