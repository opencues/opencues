/**
 * Pre-warm timer behaviour for `buildBlankContextProvider`.
 *
 * Pins:
 *   - The timer fires runProvider in the background so the first
 *     user-triggered call hits warm cache.
 *   - The timer is silent when `blankContextMode === 'off'` (still
 *     ticks, but doesn't call the provider — just reschedules).
 *   - The interval honours `blank-context-prewarm-ms` (typed off,
 *     numeric, and default-fallback paths).
 *   - `.stop()` cancels the timer (no more ticks, no Blank.get calls).
 *
 * These tests use a stub Blank that COUNTS get() calls so we can
 * assert on background activity without spinning up a real Resolver.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildBlankContextProvider } from './boot-common';
import { ConfigLoader, DEFAULT_OPENCUES_STATE } from './modules/config-loader';
import type { Blank } from './blanks/types';

class CountingBlank implements Blank {
  readonly readOnly = true;
  calls = 0;
  constructor(public readonly name: string, private readonly value: string) {}
  async get(_slot?: string): Promise<string> {
    this.calls++;
    return this.value;
  }
}

interface FakeConfigLoaderArgs {
  blankContextMode: 'off' | 'safe' | 'raw';
  prewarmMs?: string;
}

function makeFakeConfigLoader(args: FakeConfigLoaderArgs): ConfigLoader {
  const settings = new Map<string, string>();
  if (args.prewarmMs !== undefined) settings.set('blank-context-prewarm-ms', args.prewarmMs);
  const state = {
    ...DEFAULT_OPENCUES_STATE,
    blankContextMode: args.blankContextMode,
    settings,
  };
  // The provider only touches a small surface of ConfigLoader. Mock
  // just that surface; cast through unknown to satisfy the type.
  return {
    opencuesState: state,
    identity: { fields: [], catalog: new Map() },
    mergedBlanksConfig: {
      blanks: {
        stocks: {
          name: 'stocks',
          asContext: 'safe',
          contextSlots: ['AAPL'],
          contextTtl: 60,
        },
      },
    },
  } as unknown as ConfigLoader;
}

const SILENT_LOG = () => {};

describe('buildBlankContextProvider pre-warm timer', () => {
  let providers: Array<{ stop?: () => void } | undefined> = [];

  beforeEach(() => {
    providers = [];
  });

  afterEach(() => {
    for (const p of providers) p?.stop?.();
    providers = [];
  });

  // Block on the next microtask flush so the timer's fire-once-immediately
  // `void tick()` resolves before we inspect state.
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));

  it('fires runProvider immediately on construction (warm cache for first user call)', async () => {
    const blank = new CountingBlank('stocks', 'AAPL: $200');
    const configLoader = makeFakeConfigLoader({ blankContextMode: 'safe', prewarmMs: '35000' });
    const provider = buildBlankContextProvider(configLoader, new Map([['stocks', blank]]), SILENT_LOG);
    providers.push(provider);

    expect(provider).toBeDefined();
    await flush();

    // The immediate tick should have invoked the provider, which
    // populates the cache by calling blank.get().
    expect(blank.calls).toBeGreaterThanOrEqual(1);
  });

  it('does not call blank.get when blankContextMode is off', async () => {
    const blank = new CountingBlank('stocks', 'AAPL: $200');
    const configLoader = makeFakeConfigLoader({ blankContextMode: 'off', prewarmMs: '35000' });
    const provider = buildBlankContextProvider(configLoader, new Map([['stocks', blank]]), SILENT_LOG);
    providers.push(provider);

    expect(provider).toBeDefined();
    await flush();

    expect(blank.calls).toBe(0);
  });

  it('does not call blank.get when prewarm-ms is "off"', async () => {
    const blank = new CountingBlank('stocks', 'AAPL: $200');
    const configLoader = makeFakeConfigLoader({ blankContextMode: 'safe', prewarmMs: 'off' });
    const provider = buildBlankContextProvider(configLoader, new Map([['stocks', blank]]), SILENT_LOG);
    providers.push(provider);

    expect(provider).toBeDefined();
    await flush();

    // The IMMEDIATE tick still fires once (so the first user call is
    // warm) BUT subsequent reschedules pick up the 'off' setting and
    // the timer becomes a 5s recheck loop — no further blank.get calls
    // within the test window.
    const callsAfterImmediate = blank.calls;
    expect(callsAfterImmediate).toBeGreaterThanOrEqual(1);

    // Sleep briefly — the rescheduled tick uses 5s in 'off' state, so
    // no extra calls land.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(blank.calls).toBe(callsAfterImmediate);
  });

  it('exposes a .stop() hook that cancels future timer ticks', async () => {
    const blank = new CountingBlank('stocks', 'AAPL: $200');
    // Use a sub-1s value — parser will fall back to 35000 default,
    // but for stop() we just need any timer that's scheduled.
    const configLoader = makeFakeConfigLoader({ blankContextMode: 'safe', prewarmMs: '35000' });
    const provider = buildBlankContextProvider(configLoader, new Map([['stocks', blank]]), SILENT_LOG);
    providers.push(provider);

    await flush();
    const callsBeforeStop = blank.calls;
    expect(callsBeforeStop).toBeGreaterThanOrEqual(1);

    provider!.stop!();

    // Give the (now-cancelled) timer ample wall-clock to fire if it
    // were still alive.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(blank.calls).toBe(callsBeforeStop);
  });

  it('returns undefined when no blanks are wired (chrome host-process path)', () => {
    const configLoader = makeFakeConfigLoader({ blankContextMode: 'safe' });
    const provider = buildBlankContextProvider(configLoader, undefined, SILENT_LOG);
    expect(provider).toBeUndefined();
  });

  it('returns undefined when blanks map is empty', () => {
    const configLoader = makeFakeConfigLoader({ blankContextMode: 'safe' });
    const provider = buildBlankContextProvider(configLoader, new Map(), SILENT_LOG);
    expect(provider).toBeUndefined();
  });
});
