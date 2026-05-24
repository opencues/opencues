// Failure-state UX taxonomy + bus behaviour.
//
// These tests pin the contract the status line + every provider error
// path depends on. Drift in classification is silently visible to the
// user (wrong error wording, sticky events that should auto-clear, or
// vice versa) — keep the matrix exhaustive.

import { describe, it, expect, vi } from 'vitest';
import {
  classifyProviderError,
  ProviderHealth,
  type ProviderHealthEvent,
} from './provider-health';

describe('classifyProviderError', () => {
  describe('happy path', () => {
    it('returns null on 200 with no body', () => {
      expect(classifyProviderError({ status: 200 })).toBeNull();
    });
    it('returns null on empty input', () => {
      expect(classifyProviderError({})).toBeNull();
    });
  });

  describe('auth — sticky', () => {
    it('classifies HTTP 401 as auth/sticky', () => {
      const ev = classifyProviderError({ status: 401, body: '{"error":"unauthorized"}', provider: 'groq' });
      expect(ev?.kind).toBe('auth');
      expect(ev?.sticky).toBe(true);
      expect(ev?.provider).toBe('groq');
    });
    it('classifies HTTP 403 as auth/sticky with different message', () => {
      const ev = classifyProviderError({ status: 403 });
      expect(ev?.kind).toBe('auth');
      expect(ev?.sticky).toBe(true);
      expect(ev?.message).toMatch(/forbidden/i);
    });
    it('classifies "invalid api key" in cause as auth (no status)', () => {
      const ev = classifyProviderError({ cause: new Error('invalid_api_key') });
      expect(ev?.kind).toBe('auth');
      expect(ev?.sticky).toBe(true);
    });
    it('classifies "authentication failed" body without status as auth', () => {
      const ev = classifyProviderError({ body: 'authentication failed' });
      expect(ev?.kind).toBe('auth');
    });
  });

  describe('quota — sticky, wins over rate-limit', () => {
    it('classifies HTTP 402 as quota/sticky', () => {
      const ev = classifyProviderError({ status: 402 });
      expect(ev?.kind).toBe('quota');
      expect(ev?.sticky).toBe(true);
    });
    it('classifies "insufficient_quota" body as quota even on 429', () => {
      const ev = classifyProviderError({ status: 429, body: '{"code":"insufficient_quota"}' });
      expect(ev?.kind).toBe('quota');
      expect(ev?.sticky).toBe(true);
    });
    it('classifies "out of credit" body as quota', () => {
      const ev = classifyProviderError({ body: 'You are out of credit. Add billing to continue.' });
      expect(ev?.kind).toBe('quota');
    });
    it('classifies "payment_required" body as quota', () => {
      const ev = classifyProviderError({ body: '{"error":"payment_required"}' });
      expect(ev?.kind).toBe('quota');
    });
  });

  describe('rate-limit — transient, not sticky', () => {
    it('classifies HTTP 429 (plain) as rate-limit/non-sticky', () => {
      const ev = classifyProviderError({ status: 429, body: 'Too many requests' });
      expect(ev?.kind).toBe('rate-limit');
      expect(ev?.sticky).toBe(false);
    });
    it('classifies "rate_limit" body alone as rate-limit', () => {
      const ev = classifyProviderError({ body: '{"error":{"code":"rate_limit_exceeded"}}' });
      expect(ev?.kind).toBe('rate-limit');
    });
  });

  describe('outage — transient, not sticky', () => {
    it('classifies 500 as outage', () => {
      const ev = classifyProviderError({ status: 500 });
      expect(ev?.kind).toBe('outage');
      expect(ev?.sticky).toBe(false);
      expect(ev?.message).toContain('500');
    });
    it('classifies 503 as outage', () => {
      const ev = classifyProviderError({ status: 503 });
      expect(ev?.kind).toBe('outage');
    });
    it('classifies ECONNREFUSED as outage (network)', () => {
      const ev = classifyProviderError({ cause: new Error('connect ECONNREFUSED 127.0.0.1:443') });
      expect(ev?.kind).toBe('outage');
      expect(ev?.message).toMatch(/network/);
    });
    it('classifies ENOTFOUND as outage', () => {
      const ev = classifyProviderError({ cause: new Error('getaddrinfo ENOTFOUND api.groq.com') });
      expect(ev?.kind).toBe('outage');
    });
    it('classifies "service unavailable" body as outage', () => {
      const ev = classifyProviderError({ body: 'Service Unavailable' });
      expect(ev?.kind).toBe('outage');
    });
  });

  describe('model-missing — sticky', () => {
    it('classifies 404 + "model" in body as model-missing', () => {
      const ev = classifyProviderError({ status: 404, body: 'Model big-pickle not found', model: 'big-pickle' });
      expect(ev?.kind).toBe('model-missing');
      expect(ev?.sticky).toBe(true);
      expect(ev?.message).toContain('big-pickle');
    });
    it('classifies "model X is not supported" without status as model-missing', () => {
      const ev = classifyProviderError({ body: 'Model opencode/big-pickle is not supported', model: 'opencode/big-pickle' });
      expect(ev?.kind).toBe('model-missing');
    });
    it('does NOT misclassify bare 404 with no model hint', () => {
      const ev = classifyProviderError({ status: 404, body: 'Not Found' });
      expect(ev?.kind).not.toBe('model-missing');
    });
  });

  describe('precedence', () => {
    it('quota wins over rate-limit when 429 + insufficient_quota', () => {
      const ev = classifyProviderError({ status: 429, body: 'insufficient_quota' });
      expect(ev?.kind).toBe('quota');
    });
    it('auth (HTTP status) wins over body-text model-missing', () => {
      // Real case: 401 response that also includes a model error message
      // (server-side composes errors before checking auth).
      const ev = classifyProviderError({ status: 401, body: 'Model X is not supported' });
      expect(ev?.kind).toBe('auth');
    });
  });

  describe('metadata pass-through', () => {
    it('carries provider + model on the event', () => {
      const ev = classifyProviderError({ status: 401, provider: 'opencode-zen', model: 'big-pickle' });
      expect(ev?.provider).toBe('opencode-zen');
      expect(ev?.model).toBe('big-pickle');
    });
  });
});

describe('ProviderHealth bus', () => {
  it('reports + reads current event', () => {
    const ph = new ProviderHealth();
    ph.report({ kind: 'auth', message: 'bad key', sticky: true, at: 0 });
    expect(ph.current()?.kind).toBe('auth');
  });

  it('stamps event.at via injected now()', () => {
    const ph = new ProviderHealth({ now: () => 12345 });
    ph.report({ kind: 'auth', message: 'bad key', sticky: true, at: 0 });
    expect(ph.current()?.at).toBe(12345);
  });

  it('clear() removes the current event', () => {
    const ph = new ProviderHealth();
    ph.report({ kind: 'auth', message: 'bad key', sticky: true, at: 0 });
    ph.clear();
    expect(ph.current()).toBeNull();
  });

  it('notifies subscribers on report + clear', () => {
    const ph = new ProviderHealth();
    const seen: Array<ProviderHealthEvent | null> = [];
    ph.subscribe(ev => seen.push(ev));
    ph.report({ kind: 'auth', message: 'x', sticky: true, at: 0 });
    ph.clear();
    expect(seen).toHaveLength(2);
    expect(seen[0]?.kind).toBe('auth');
    expect(seen[1]).toBeNull();
  });

  it('unsubscribe stops further notifications', () => {
    const ph = new ProviderHealth();
    const fn = vi.fn();
    const unsub = ph.subscribe(fn);
    ph.report({ kind: 'auth', message: 'x', sticky: true, at: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    ph.report({ kind: 'outage', message: 'y', sticky: false, at: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('auto-clears non-sticky events after transientTtlMs', () => {
    vi.useFakeTimers();
    try {
      const ph = new ProviderHealth({ transientTtlMs: 5_000 });
      ph.report({ kind: 'rate-limit', message: 'slow down', sticky: false, at: 0 });
      expect(ph.current()?.kind).toBe('rate-limit');
      vi.advanceTimersByTime(5_001);
      expect(ph.current()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT auto-clear sticky events', () => {
    vi.useFakeTimers();
    try {
      const ph = new ProviderHealth({ transientTtlMs: 5_000 });
      ph.report({ kind: 'auth', message: 'bad key', sticky: true, at: 0 });
      vi.advanceTimersByTime(60_000);
      expect(ph.current()?.kind).toBe('auth');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fresh report cancels the pending auto-clear of the previous one', () => {
    vi.useFakeTimers();
    try {
      const ph = new ProviderHealth({ transientTtlMs: 5_000 });
      ph.report({ kind: 'rate-limit', message: 'first', sticky: false, at: 0 });
      vi.advanceTimersByTime(3_000);
      ph.report({ kind: 'outage', message: 'second', sticky: false, at: 0 });
      vi.advanceTimersByTime(3_000);
      // First's 5s window would have elapsed (3+3=6s) but second's
      // window is only 3s in — should still be visible.
      expect(ph.current()?.message).toBe('second');
      vi.advanceTimersByTime(2_500);
      expect(ph.current()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reportFrom classifies + reports in one call', () => {
    const ph = new ProviderHealth();
    const ev = ph.reportFrom({ status: 401, provider: 'groq' });
    expect(ev?.kind).toBe('auth');
    expect(ph.current()?.kind).toBe('auth');
  });

  it('reportFrom returns null on healthy input without touching state', () => {
    const ph = new ProviderHealth();
    const ev = ph.reportFrom({ status: 200 });
    expect(ev).toBeNull();
    expect(ph.current()).toBeNull();
  });

  it('a throwing subscriber does not break the bus for other subscribers', () => {
    const ph = new ProviderHealth();
    const good = vi.fn();
    ph.subscribe(() => { throw new Error('bad subscriber'); });
    ph.subscribe(good);
    ph.report({ kind: 'auth', message: 'x', sticky: true, at: 0 });
    expect(good).toHaveBeenCalledOnce();
  });
});
