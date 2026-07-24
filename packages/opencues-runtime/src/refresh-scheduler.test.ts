/**
 * Refresh scheduler — the system-owns-cadence contract (July 2026).
 * Resources declare due-ness; the tick refreshes what's due, one
 * in-flight per resource, failures retried when next due, never in the
 * keystroke path.
 */

import { describe, it, expect } from 'vitest';
import { createRefreshScheduler } from './refresh-scheduler';

const noop = (): void => {};

describe('createRefreshScheduler', () => {
  it('refreshes a due resource on tick and skips a not-due one', () => {
    const s = createRefreshScheduler(noop, { tickMs: 999_999 });
    let a = 0, b = 0;
    s.register({ id: 'a', due: () => true, refresh: () => { a++; } });
    s.register({ id: 'b', due: () => false, refresh: () => { b++; } });
    s.tickNow();
    s.tickNow();
    expect(a).toBe(2);
    expect(b).toBe(0);
    s.stop();
  });

  it('holds ONE in-flight refresh per resource (slow refresh skips ticks, never stacks)', async () => {
    const s = createRefreshScheduler(noop, { tickMs: 999_999 });
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    s.register({ id: 'slow', due: () => true, refresh: async () => { started++; await gate; } });
    s.tickNow();
    s.tickNow();
    s.tickNow();
    expect(started).toBe(1);
    release();
    await new Promise(r => setTimeout(r, 10));
    s.tickNow();
    expect(started).toBe(2);
    s.stop();
  });

  it('a rejecting refresh is contained and retried when next due', async () => {
    const msgs: string[] = [];
    const s = createRefreshScheduler(m => msgs.push(m), { tickMs: 999_999 });
    let calls = 0;
    s.register({ id: 'flaky', due: () => true, refresh: async () => { calls++; throw new Error('feed down'); } });
    s.tickNow();
    await new Promise(r => setTimeout(r, 10));
    s.tickNow();
    await new Promise(r => setTimeout(r, 10));
    expect(calls).toBe(2);
    expect(msgs.some(m => m.includes('flaky') && m.includes('feed down'))).toBe(true);
    s.stop();
  });

  it('a throwing due() is contained (scheduler survives)', () => {
    const msgs: string[] = [];
    const s = createRefreshScheduler(m => msgs.push(m), { tickMs: 999_999 });
    let ok = 0;
    s.register({ id: 'bad-due', due: () => { throw new Error('boom'); }, refresh: noop });
    s.register({ id: 'good', due: () => true, refresh: () => { ok++; } });
    s.tickNow();
    expect(ok).toBe(1);
    expect(msgs.some(m => m.includes('bad-due'))).toBe(true);
    s.stop();
  });

  it('jitter defers first eligibility; stop() halts everything', () => {
    let t = 1_000_000;
    const s = createRefreshScheduler(noop, { tickMs: 999_999, now: () => t });
    let n = 0;
    s.register({ id: 'j', due: () => true, refresh: () => { n++; }, jitterMs: 5_000 });
    s.tickNow();                 // within jitter window → not eligible
    expect(n).toBe(0);
    t += 6_000;
    s.tickNow();
    expect(n).toBe(1);
    s.stop();
    t += 60_000;
    s.tickNow();                 // stopped → no-op
    expect(n).toBe(1);
  });
});
