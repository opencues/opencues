/**
 * Security + behaviour tests for `buildBlankFetchProvider` (typed-sentinel
 * Phase 4 — on-demand parameterized blank fetch).
 *
 * This is the runtime CAPABILITY CHOKEPOINT: the only place an LLM-provided
 * argument reaches a blank's get(). These tests pin the gate so a regression
 * can't silently widen it.
 *
 * Pinned:
 *   - happy path — a `param-safe` fetch blank is in the registry; blankFetch
 *     calls get(arg) and returns the value; getRenderedBlock advertises it.
 *   - CAPABILITY GATE — a blank without `param-safe` is NOT in the registry
 *     AND blankFetch refuses it (get() is NEVER called).
 *   - SCRIPT-BLANK GATE (defense in depth) — a blank with BOTH `param-safe`
 *     and `blankScript` is excluded from the registry AND refused at fetch,
 *     so an LLM-influenced arg can never reach a shell.
 *   - blank-context-mode gate — registry empty when `off`.
 *   - host-impl gate — a param-safe config with no runtime Blank is skipped.
 */

import { describe, it, expect } from 'vitest';
import { buildBlankFetchProvider, paramSafeArgWithinFloor, PARAM_SAFE_ARG_MAX } from './boot-common';
import { DEFAULT_OPENCUES_STATE, type ConfigLoader } from './modules/config-loader';
import type { Blank } from './blanks/types';

class SpyBlank implements Blank {
  readonly readOnly = true;
  calls: string[] = [];
  constructor(public readonly name: string, private readonly value: string) {}
  async get(slot?: string): Promise<string> { this.calls.push(slot ?? ''); return this.value; }
}

type BlankCfg = { name: string; paramSafe?: boolean; blankScript?: string; signature?: string; returns?: string; blankTip?: string };

function makeLoader(blanks: Record<string, BlankCfg>, blankContextMode: 'off' | 'safe' | 'raw' = 'safe'): ConfigLoader {
  return {
    opencuesState: { ...DEFAULT_OPENCUES_STATE, blankContextMode, settings: new Map() },
    identity: { fields: [], catalog: new Map() },
    mergedBlanksConfig: { blanks },
  } as unknown as ConfigLoader;
}

const noop = () => {};

describe('buildBlankFetchProvider — happy path', () => {
  it('registers a param-safe fetch blank + blankFetch calls get(arg)', async () => {
    const spy = new SpyBlank('stocks', 'AMZN: $232.69');
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks', paramSafe: true, signature: '(ticker: string)', returns: 'number', blankTip: 'Stock price' } }),
      new Map([['stocks', spy]]), noop,
    )!;
    expect(prov).toBeTruthy();
    expect([...prov.getParamSafeFns().keys()]).toEqual(['STOCK']);
    const v = await prov.blankFetch('stocks', 'AMZN');
    expect(v).toBe('AMZN: $232.69');
    expect(spy.calls).toEqual(['AMZN']); // get() called once, with the LLM arg
  });

  it('getRenderedBlock advertises the signature', () => {
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks', paramSafe: true, signature: '(ticker: string)', returns: 'number', blankTip: 'Stock price' } }),
      new Map([['stocks', new SpyBlank('stocks', 'x')]]), noop,
    )!;
    expect(prov.getRenderedBlock()).toMatch(/\[STOCK\(ticker: string\): number\]/);
    expect(prov.getRenderedBlock()).toMatch(/LIVE FUNCTIONS/);
  });
});

describe('buildBlankFetchProvider — CAPABILITY GATE', () => {
  it('a blank WITHOUT param-safe is not registered AND blankFetch refuses it (get never called)', async () => {
    const spy = new SpyBlank('stocks', 'leaked');
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks' /* paramSafe absent */ } }),
      new Map([['stocks', spy]]), noop,
    );
    // Provider exists (blanks present) but the registry is empty.
    expect(prov).toBeTruthy();
    expect(prov!.getParamSafeFns().size).toBe(0);
    const v = await prov!.blankFetch('stocks', 'AMZN');
    expect(v).toBeUndefined();
    expect(spy.calls).toEqual([]); // get() NEVER invoked
  });
});

describe('buildBlankFetchProvider — SCRIPT-BLANK GATE (LLM-arg → shell ban)', () => {
  it('a param-safe blank that ALSO has blankScript is excluded AND refused (get never called)', async () => {
    const spy = new SpyBlank('volume', 'should-not-run');
    const prov = buildBlankFetchProvider(
      makeLoader({ volume: { name: 'volume', paramSafe: true, blankScript: '/x.sh' } }),
      new Map([['volume', spy]]), noop,
    )!;
    expect(prov.getParamSafeFns().size).toBe(0); // not in the registry
    const v = await prov.blankFetch('volume', '99');
    expect(v).toBeUndefined();             // refused at the chokepoint
    expect(spy.calls).toEqual([]);         // the script blank's get() NEVER ran
  });
});

describe('buildBlankFetchProvider — mode + host-impl gates', () => {
  it('registry is empty when blank-context-mode is off', () => {
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks', paramSafe: true } }, 'off'),
      new Map([['stocks', new SpyBlank('stocks', 'x')]]), noop,
    )!;
    expect(prov.getParamSafeFns().size).toBe(0);
  });

  it('a param-safe config with no runtime Blank impl is skipped', () => {
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks', paramSafe: true } }),
      new Map(), // no host impl
      noop,
    );
    // No blanks at all → provider is undefined (nothing to wire).
    expect(prov).toBeUndefined();
  });

  it('mixed config: only the param-safe non-script blank is registered', () => {
    const prov = buildBlankFetchProvider(
      makeLoader({
        stocks: { name: 'stocks', paramSafe: true, signature: '(ticker: string)' },
        weather: { name: 'weather' },                          // not param-safe
        volume: { name: 'volume', paramSafe: true, blankScript: '/v.sh' }, // script → banned
      }),
      new Map([
        ['stocks', new SpyBlank('stocks', 's')],
        ['weather', new SpyBlank('weather', 'w')],
        ['volume', new SpyBlank('volume', 'v')],
      ]), noop,
    )!;
    expect([...prov.getParamSafeFns().values()].map(v => v.blankName)).toEqual(['stocks']);
  });
});

describe('buildBlankFetchProvider — ARG SHAPE FLOOR (defense-in-depth)', () => {
  // The primary defense is each blank encoding its own arg; this floor bounds
  // the blast radius of a custom param-safe blank that forgets to. It must
  // accept normal lookup values and refuse control/URL-injection chars + huge
  // args BEFORE get() runs.
  it('accepts legitimate lookup values (ticker, crypto id, city with spaces/accents/punctuation)', () => {
    for (const ok of ['AMZN', 'btc-usd', 'bitcoin', 'São Paulo', 'St. John\'s', 'Washington, D.C.', 'new york']) {
      expect(paramSafeArgWithinFloor(ok)).toBe(true);
    }
  });

  it('rejects URL-structure / injection chars, control chars, and over-length', () => {
    for (const bad of [
      '',                              // empty
      'x&admin=1',                     // extra query param
      'evil.com/path',                 // slash
      'a?b', 'a#b', 'a@b', 'a%2e',     // ? # @ %
      'a\\b', 'a<b>', 'a"b', 'a`b',    // backslash, angle, quote, backtick
      'a\nb', 'a\rb', 'a\x00b', 'a\x1fb', // CRLF / null / control
      'x'.repeat(PARAM_SAFE_ARG_MAX + 1), // length cap
    ]) {
      expect(paramSafeArgWithinFloor(bad)).toBe(false);
    }
  });

  it('blankFetch refuses a floor-failing arg — get() is NEVER called', async () => {
    const spy = new SpyBlank('stocks', 'leaked');
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks', paramSafe: true, signature: '(ticker: string)', returns: 'number', blankTip: 'Stock price' } }),
      new Map([['stocks', spy]]), noop,
    )!;
    const v = await prov.blankFetch('stocks', 'AMZN&token=stolen');
    expect(v).toBeUndefined();
    expect(spy.calls).toEqual([]); // get() never reached — refused at the floor
  });
});
