// End-to-end failure-state scenarios — the user-visible path that
// proves the ProviderHealth → Statusline wiring + the free-pool walker
// surface real LLM failures instead of silently no-op'ing.
//
// Why this file (and not unit tests in each module): the May 2026
// agentic-harness incident found a Cerebras account that had been out
// of credits for weeks while every cue source silently returned
// nothing — the unit tests on each individual source PASSED, but the
// user journey ("blank fires → fails → user sees nothing") was never
// exercised end-to-end. These scenarios pin THAT journey.

import { describe, it, expect } from 'vitest';
import { Statusline, type StatuslinePayload } from './statusline';
import { ProviderHealth, classifyProviderError } from './provider-health';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

function setup(opts: { transientTtlMs?: number } = {}) {
  const adapter = new MockAdapter();
  adapter.pushText('hello world');
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const ph = new ProviderHealth({ transientTtlMs: opts.transientTtlMs ?? 5_000 });
  const statusline = new Statusline(
    adapter,
    hlState,
    dynDefs,
    { exportPath: '/tmp/test-status.json' },
    undefined, undefined, undefined, undefined,
    ph,
  );
  statusline.subscribe();
  return { adapter, hlState, dynDefs, statusline, ph };
}

// MockAdapter.writeFile resolves synchronously after a microtask boundary
// (it's `async fn() { map.set(...) }`). One `await Promise.resolve()` is
// enough to drain its `.then(...)` handler — using setImmediate would
// hang under fake timers, and we avoid fake timers here so failures don't
// leak between scenarios.
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function latestSnapshot(adapter: MockAdapter): StatuslinePayload | undefined {
  const snaps = adapter.events.filter(e => e.type === 'statusline.snapshot');
  return snaps[snaps.length - 1]?.body as StatuslinePayload | undefined;
}

describe('ProviderHealth + Statusline — end-to-end failure surface', () => {
  it('SCENARIO: free-pool 401 → sticky auth error → statusline payload carries it', async () => {
    const { adapter, hlState, statusline, ph } = setup();

    // 1. Healthy starting state — no error in payload.
    hlState.activate(0, 'hello world');
    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();
    expect(latestSnapshot(adapter)?.providerError).toBeNull();

    // 2. Simulate a free-pool dispatch failing with 401 (bad API key
    //    on a paid model). dispatchWithFreePool/withFreePool would have
    //    bubbled this Error; the source's catch block routes it via
    //    classifyProviderError → ph.report.
    ph.reportFrom({
      status: 401,
      body: '{"error":"invalid_api_key"}',
      provider: 'opencode-zen',
      model: 'big-pickle',
    });

    // 3. Force a re-render — host's forceRender → onRender → maybeWrite.
    adapter.forceRender?.();
    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();

    const snap = latestSnapshot(adapter);
    expect(snap?.providerError).toBeTruthy();
    expect(snap?.providerError?.kind).toBe('auth');
    expect(snap?.providerError?.sticky).toBe(true);
    expect(snap?.providerError?.provider).toBe('opencode-zen');
    expect(snap?.providerError?.message).toMatch(/bad.*key/i);
  });

  it('SCENARIO: out-of-credits (402) classifies as quota — surfaces to statusline', async () => {
    const { adapter, hlState, statusline, ph } = setup();
    hlState.activate(0, 'hello world');

    // Cerebras-shaped 402 response (the exact bug from the May 2026
    // incident): root-level message+code instead of nested error envelope.
    ph.reportFrom({
      status: 402,
      body: '{"message":"Payment required.","code":"payment_required","type":"payment_required_error"}',
      provider: 'cerebras',
    });

    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();
    const snap = latestSnapshot(adapter);
    expect(snap?.providerError?.kind).toBe('quota');
    expect(snap?.providerError?.sticky).toBe(true);
  });

  it('SCENARIO: rate-limit auto-clears after TTL — user sees error briefly, then it goes away', async () => {
    // 50ms real TTL — bus's setTimeout cleanly resolves; no fake timers
    // (those tangle with the writeFile microtask flushing in this file).
    const { adapter, hlState, statusline, ph } = setup({ transientTtlMs: 50 });
    hlState.activate(0, 'hello world');

    ph.reportFrom({ status: 429, body: 'too many requests', provider: 'groq' });
    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();
    expect(latestSnapshot(adapter)?.providerError?.kind).toBe('rate-limit');
    expect(latestSnapshot(adapter)?.providerError?.sticky).toBe(false);

    // Wait past the TTL — bus clears itself.
    await new Promise(r => setTimeout(r, 100));
    expect(ph.current()).toBeNull();
    // Re-render so the now-null state mirrors into the payload.
    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();
    expect(latestSnapshot(adapter)?.providerError).toBeNull();
  });

  it('SCENARIO: user fixes the API key → ph.clear() → next render shows no error', async () => {
    const { adapter, hlState, statusline, ph } = setup();
    hlState.activate(0, 'hello world');

    ph.reportFrom({ status: 401, provider: 'opencode-zen' });
    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();
    expect(latestSnapshot(adapter)?.providerError?.kind).toBe('auth');

    // User edits OPENCUES.md with a fresh key → caller clears the bus.
    ph.clear();
    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();
    expect(latestSnapshot(adapter)?.providerError).toBeNull();
  });

  it('SCENARIO: model-missing (404) — sticky, carries model name in message', async () => {
    const { adapter, hlState, statusline, ph } = setup();
    hlState.activate(0, 'hello world');

    ph.reportFrom({
      status: 404,
      body: 'Model big-pickle not found',
      provider: 'opencode-zen',
      model: 'big-pickle',
    });

    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();
    const snap = latestSnapshot(adapter);
    expect(snap?.providerError?.kind).toBe('model-missing');
    expect(snap?.providerError?.sticky).toBe(true);
    expect(snap?.providerError?.message).toContain('big-pickle');
  });

  it('SCENARIO: a successful call after a failure can clear the error explicitly', async () => {
    const { adapter, hlState, statusline, ph } = setup();
    hlState.activate(0, 'hello world');

    ph.reportFrom({ status: 503, provider: 'groq' });
    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();
    expect(latestSnapshot(adapter)?.providerError?.kind).toBe('outage');

    // Source resolves a request successfully → caller can opt to clear.
    ph.clear();
    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();
    expect(latestSnapshot(adapter)?.providerError).toBeNull();
  });

  it('PROPERTY: statusline payload omits providerError when no health bus wired', async () => {
    const adapter = new MockAdapter();
    adapter.pushText('hello');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    // No ProviderHealth passed.
    const statusline = new Statusline(adapter, hlState, dynDefs, { exportPath: '/tmp/x.json' });
    statusline.subscribe();
    hlState.activate(0, 'hello');
    statusline.maybeWrite({ text: 'hello', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();
    // Field is absent (not null) when no bus is wired — back-compat for
    // existing hosts that haven't added the ProviderHealth surface yet.
    expect('providerError' in (latestSnapshot(adapter) ?? {})).toBe(false);
  });

  it('PROPERTY: errors during one render do not break subsequent renders', async () => {
    const { adapter, hlState, statusline, ph } = setup();
    hlState.activate(0, 'hello world');

    // First failure.
    ph.reportFrom({ status: 401, provider: 'groq' });
    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();

    // Second, different failure of the same kind (overwrites).
    ph.reportFrom({ status: 403, provider: 'openai' });
    statusline.maybeWrite({ text: 'hello world', cursor: 0, externalHighlights: [] });
    await flushMicrotasks();

    const snap = latestSnapshot(adapter);
    expect(snap?.providerError?.provider).toBe('openai');
    expect(snap?.providerError?.message).toMatch(/forbidden/i);
  });
});

describe('classifyProviderError ↔ free-pool walker integration', () => {
  it('PROPERTY: walker onFailure callback can feed straight into ProviderHealth.reportFrom', () => {
    const ph = new ProviderHealth();
    // Simulate the shape the withFreePool / dispatchWithFreePool walker
    // emits via its `onFailure` callback. The integration contract is
    // that classifyProviderError accepts that shape directly.
    const ev = classifyProviderError({
      cause: new Error('overloaded: server_error'),
      provider: 'opencode-zen',
      model: 'big-pickle',
    });
    expect(ev?.kind).toBe('outage');
    if (ev) ph.report(ev);
    expect(ph.current()?.kind).toBe('outage');
    expect(ph.current()?.model).toBe('big-pickle');
  });

  it('PROPERTY: auth failure from walker bubbles via reportFrom as sticky', () => {
    const ph = new ProviderHealth();
    ph.reportFrom({
      cause: new Error('unauthorized: invalid_api_key'),
      provider: 'opencode-zen',
    });
    expect(ph.current()?.kind).toBe('auth');
    expect(ph.current()?.sticky).toBe(true);
  });
});
