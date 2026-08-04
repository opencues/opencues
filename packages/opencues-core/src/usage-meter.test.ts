import { describe, it, expect, beforeEach } from 'vitest';
import {
  UsageMeter,
  registerUsageSink,
  reportUsage,
  hasUsageSinks,
  mergeSnapshots,
  priceFor,
  estimateRowCostUSD,
  estimateCost,
  type UsageEvent,
} from './usage-meter';

const ev = (o: Partial<UsageEvent>): UsageEvent => ({
  providerId: 'cerebras', model: 'gpt-oss-120b', promptTokens: 0, cachedTokens: 0, completionTokens: 0, ...o,
});

describe('UsageMeter', () => {
  it('accumulates per (provider, model) and counts calls', () => {
    const m = new UsageMeter();
    m.record(ev({ promptTokens: 100, completionTokens: 20 }));
    m.record(ev({ promptTokens: 50, cachedTokens: 30, completionTokens: 10 }));
    m.record(ev({ providerId: 'anthropic', model: 'claude-haiku-4-5-20251001', promptTokens: 200, completionTokens: 40 }));
    const rows = m.rows();
    expect(rows).toHaveLength(2);
    const cer = rows.find((r) => r.providerId === 'cerebras')!;
    expect(cer.calls).toBe(2);
    expect(cer.promptTokens).toBe(150);
    expect(cer.cachedTokens).toBe(30);
    expect(cer.completionTokens).toBe(30);
  });

  it('clamps negatives / non-integers defensively', () => {
    const m = new UsageMeter();
    m.record(ev({ promptTokens: -5, completionTokens: 3.9 }));
    const r = m.rows()[0];
    expect(r.promptTokens).toBe(0);
    expect(r.completionTokens).toBe(3);
  });

  it('reset clears totals', () => {
    const m = new UsageMeter();
    m.record(ev({ promptTokens: 10 }));
    m.reset();
    expect(m.rows()).toHaveLength(0);
  });
});

describe('sink registry', () => {
  beforeEach(() => { /* sinks are module-global; each test registers+unregisters its own */ });

  it('reportUsage fans out to registered sinks; unregister stops delivery', () => {
    const seen: UsageEvent[] = [];
    expect(hasUsageSinks()).toBe(false);
    const off = registerUsageSink((e) => seen.push(e));
    expect(hasUsageSinks()).toBe(true);
    reportUsage(ev({ promptTokens: 1 }));
    expect(seen).toHaveLength(1);
    off();
    expect(hasUsageSinks()).toBe(false);
    reportUsage(ev({ promptTokens: 2 }));
    expect(seen).toHaveLength(1);   // no longer delivered
  });

  it('a throwing sink does not break dispatch (other sinks still fire)', () => {
    const seen: number[] = [];
    const offA = registerUsageSink(() => { throw new Error('boom'); });
    const offB = registerUsageSink((e) => seen.push(e.promptTokens));
    expect(() => reportUsage(ev({ promptTokens: 7 }))).not.toThrow();
    expect(seen).toEqual([7]);
    offA(); offB();
  });

  it('a registered UsageMeter accumulates reported events', () => {
    const m = new UsageMeter();
    const off = registerUsageSink((e) => m.record(e));
    reportUsage(ev({ promptTokens: 100, completionTokens: 10 }));
    reportUsage(ev({ promptTokens: 100, completionTokens: 10 }));
    off();
    expect(m.rows()[0].calls).toBe(2);
    expect(m.rows()[0].promptTokens).toBe(200);
  });
});

describe('mergeSnapshots', () => {
  it('sums rows across multiple process snapshots', () => {
    const a = { rows: [{ providerId: 'cerebras', model: 'gpt-oss-120b', calls: 1, promptTokens: 100, cachedTokens: 0, completionTokens: 10 }] };
    const b = { rows: [{ providerId: 'cerebras', model: 'gpt-oss-120b', calls: 2, promptTokens: 50, cachedTokens: 20, completionTokens: 5 }] };
    const merged = mergeSnapshots([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].calls).toBe(3);
    expect(merged[0].promptTokens).toBe(150);
    expect(merged[0].cachedTokens).toBe(20);
  });
});

describe('pricing + cost', () => {
  it('resolves an exact model, then the provider _default', () => {
    expect(priceFor('cerebras', 'gpt-oss-120b')).toEqual({ input: 0.35, output: 0.75 });
    // unknown cerebras model → provider default
    expect(priceFor('cerebras', 'gemma-4-31b')).toEqual({ input: 0.35, output: 0.75 });
    // unknown provider → undefined (unpriced)
    expect(priceFor('nonesuch', 'x')).toBeUndefined();
  });

  it('costs a row with the cache discount applied to cached tokens', () => {
    // 1M prompt (200k cached), 100k completion, anthropic (input 1.0, cached 0.1, output 5.0)
    const row = { calls: 1, promptTokens: 1_000_000, cachedTokens: 200_000, completionTokens: 100_000 };
    const price = { input: 1.0, output: 5.0, cachedInput: 0.1 };
    // uncached 800k*1.0 + cached 200k*0.1 + out 100k*5.0 = 0.8 + 0.02 + 0.5 = 1.32
    expect(estimateRowCostUSD(row, price)).toBeCloseTo(1.32, 6);
  });

  it('defaults cachedInput to input when the provider gives no cache discount', () => {
    const row = { calls: 1, promptTokens: 1_000_000, cachedTokens: 500_000, completionTokens: 0 };
    // cerebras: no cachedInput → all prompt billed at input 0.35 → $0.35
    expect(estimateRowCostUSD(row, { input: 0.35, output: 0.75 })).toBeCloseTo(0.35, 6);
  });

  it('estimateCost sums priced rows, flags unpriced + approx, sorts by cost', () => {
    const rows = [
      { providerId: 'cerebras', model: 'gpt-oss-120b', calls: 10, promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 100_000 }, // 0.35+0.075=0.425
      { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001', calls: 2, promptTokens: 100_000, cachedTokens: 0, completionTokens: 10_000 }, // approx: 0.1+0.05=0.15
      { providerId: 'mystery', model: 'z', calls: 1, promptTokens: 1000, cachedTokens: 0, completionTokens: 100 }, // unpriced
    ];
    const rep = estimateCost(rows);
    expect(rep.hasUnpriced).toBe(true);
    expect(rep.hasApprox).toBe(true);
    expect(rep.totalUSD).toBeCloseTo(0.425 + 0.15, 4);
    // sorted by cost desc → cerebras first, mystery (unpriced) last
    expect(rep.rows[0].providerId).toBe('cerebras');
    expect(rep.rows[rep.rows.length - 1].providerId).toBe('mystery');
    expect(rep.rows[rep.rows.length - 1].costUSD).toBeUndefined();
  });
});
