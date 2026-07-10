/**
 * Security + behaviour tests for `buildBlankFetchProvider` (typed-sentinel
 * Phase 4 — on-demand parameterized blank fetch).
 *
 * This is the runtime CAPABILITY CHOKEPOINT: the only place an LLM-provided
 * argument reaches a blank's get(). These tests pin the gate so a regression
 * can't silently widen it.
 *
 * Pinned:
 *   - happy path — a `ai-callable` fetch blank is in the registry; blankFetch
 *     calls get(arg) and returns the value; getRenderedBlock advertises it.
 *   - CAPABILITY GATE — a blank without `ai-callable` is NOT in the registry
 *     AND blankFetch refuses it (get() is NEVER called).
 *   - SCRIPT-BLANK GATE (defense in depth) — a blank with BOTH `ai-callable`
 *     and `blankScript` is excluded from the registry AND refused at fetch,
 *     so an LLM-influenced arg can never reach a shell.
 *   - blank-context-mode gate — registry empty when `off`.
 *   - host-impl gate — a ai-callable config with no runtime Blank is skipped.
 */

import { describe, it, expect } from 'vitest';
import { buildBlankFetchProvider, aiCallableArgWithinFloor, AI_CALLABLE_ARG_MAX } from './boot-common';
import { DEFAULT_OPENCUES_STATE, type ConfigLoader } from './modules/config-loader';
import type { Blank } from './blanks/types';
import { StocksBlank } from './blanks/stocks';

class SpyBlank implements Blank {
  readonly readOnly = true;
  calls: string[] = [];
  constructor(public readonly name: string, private readonly value: string) {}
  async get(slot?: string): Promise<string> { this.calls.push(slot ?? ''); return this.value; }
}

// A real audited core class with a stubbed fetch — instanceof StocksBlank, so
// it's ai-callable by CODE IDENTITY without needing a user trust entry.
function realStocks(value = 232.69): StocksBlank {
  return new StocksBlank({
    apiKey: 'k',
    fetchFn: (async () => ({ ok: true, json: async () => ({ c: value }) })) as unknown as typeof fetch,
  });
}

type BlankCfg = { name: string; aiCallable?: boolean; blankScript?: string; signature?: string; returns?: string; blankTip?: string };

function makeLoader(
  blanks: Record<string, BlankCfg>,
  blankContextMode: 'off' | 'safe' | 'raw' = 'safe',
  aiCallableAllow: readonly string[] = [],
): ConfigLoader {
  return {
    opencuesState: { ...DEFAULT_OPENCUES_STATE, blankContextMode, aiCallableAllow, settings: new Map() },
    identity: { fields: [], catalog: new Map() },
    mergedBlanksConfig: { blanks },
  } as unknown as ConfigLoader;
}

const noop = () => {};

describe('buildBlankFetchProvider — happy path', () => {
  it('audited core class is ai-callable by code identity + blankFetch calls get(arg)', async () => {
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks', aiCallable: true, signature: '(ticker: string)', returns: 'number' } }),
      new Map([['stocks', realStocks(232.69)]]), noop, // real StocksBlank → instanceof gate passes, NO trust entry
    )!;
    expect(prov).toBeTruthy();
    expect([...prov.getAiCallableFns().keys()]).toEqual(['STOCK']);
    const v = await prov.blankFetch('stocks', 'AMZN');
    expect(v).toBe('AMZN: $232.69'); // get(arg) ran through the real (sanitizing) class
  });

  it('getRenderedBlock advertises the signature', () => {
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks', aiCallable: true, signature: '(ticker: string)', returns: 'number' } }),
      new Map([['stocks', realStocks()]]), noop,
    )!;
    expect(prov.getRenderedBlock()).toMatch(/\[STOCK\(ticker: string\): number\]/);
    expect(prov.getRenderedBlock()).toMatch(/LIVE FUNCTIONS/);
  });

  it('getRenderedBlock presents itself as ADDITIVE to the catalogs (issue #279)', () => {
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks', aiCallable: true, signature: '(ticker: string)', returns: 'number' } }),
      new Map([['stocks', realStocks()]]), noop,
    )!;
    // Load-bearing prompt clause: without "IN ADDITION to the catalog
    // tokens above", gpt-oss-120b reads the fn block as REPLACING the
    // identity/blank-context catalogs and bails identity lookups
    // (`i work at _`) to SPAN=NONE on any host with an ai-callable
    // blank registered. Repro + fix: issue #279. If this assertion
    // fails you are editing the block wording — re-run
    // tests/benchmarks/typed-sentinel-language/livefn-bench.ts (and
    // keep its LIVE_FUNCTIONS mirror in sync) plus the #279 identity
    // case before shipping.
    expect(prov.getRenderedBlock()).toMatch(/LIVE FUNCTIONS — IN ADDITION to the catalog tokens above \(all catalog rules still apply\)/);
  });
});

describe('buildBlankFetchProvider — CAPABILITY GATE (code-identity + user trust)', () => {
  // A pack can ship `ai-callable: true`, but installing ≠ enabling: the flag is
  // honoured ONLY for an audited core class (instanceof) OR a name the USER put
  // in ai-callable-allow. This is the security-first redesign — a pack can never
  // self-grant LLM-arg invocation.
  it('a NON-audited blank with the flag but NO user trust is REFUSED (pack self-grant denied)', async () => {
    const spy = new SpyBlank('evil', 'pwned');
    const prov = buildBlankFetchProvider(
      makeLoader({ evil: { name: 'evil', aiCallable: true, signature: '(x: string)' } }), // flag set, but...
      new Map([['evil', spy]]), noop,                                                    // not audited, not trusted
    )!;
    expect(prov.getAiCallableFns().size).toBe(0);          // NOT in the registry
    const v = await prov.blankFetch('evil', 'anything');
    expect(v).toBeUndefined();                            // refused at the chokepoint
    expect(spy.calls).toEqual([]);                        // get() NEVER invoked
  });

  it('a NON-audited blank the USER trusted (ai-callable-allow) IS honoured', async () => {
    const spy = new SpyBlank('myfetch', 'custom-value');
    const prov = buildBlankFetchProvider(
      makeLoader({ myfetch: { name: 'myfetch', aiCallable: true, signature: '(q: string)' } }, 'safe', ['myfetch']),
      new Map([['myfetch', spy]]), noop,
    )!;
    expect([...prov.getAiCallableFns().values()].map(v => v.blankName)).toEqual(['myfetch']);
    const v = await prov.blankFetch('myfetch', 'query');
    expect(v).toBe('custom-value');
    expect(spy.calls).toEqual(['query']);
  });

  it('audited core class is honoured WITHOUT any user trust entry', () => {
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks', aiCallable: true } }), // no ai-callable-allow
      new Map([['stocks', realStocks()]]), noop,
    )!;
    expect([...prov.getAiCallableFns().values()].map(v => v.blankName)).toEqual(['stocks']);
  });
});

describe('buildBlankFetchProvider — CAPABILITY GATE', () => {
  it('a blank WITHOUT ai-callable is not registered AND blankFetch refuses it (get never called)', async () => {
    const spy = new SpyBlank('stocks', 'leaked');
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks' /* aiCallable absent */ } }),
      new Map([['stocks', spy]]), noop,
    );
    // Provider exists (blanks present) but the registry is empty.
    expect(prov).toBeTruthy();
    expect(prov!.getAiCallableFns().size).toBe(0);
    const v = await prov!.blankFetch('stocks', 'AMZN');
    expect(v).toBeUndefined();
    expect(spy.calls).toEqual([]); // get() NEVER invoked
  });
});

describe('buildBlankFetchProvider — SCRIPT-BLANK GATE (LLM-arg → shell ban)', () => {
  it('a ai-callable blank that ALSO has blankScript is excluded AND refused (get never called)', async () => {
    const spy = new SpyBlank('volume', 'should-not-run');
    const prov = buildBlankFetchProvider(
      makeLoader({ volume: { name: 'volume', aiCallable: true, blankScript: '/x.sh' } }),
      new Map([['volume', spy]]), noop,
    )!;
    expect(prov.getAiCallableFns().size).toBe(0); // not in the registry
    const v = await prov.blankFetch('volume', '99');
    expect(v).toBeUndefined();             // refused at the chokepoint
    expect(spy.calls).toEqual([]);         // the script blank's get() NEVER ran
  });
});

describe('buildBlankFetchProvider — mode + host-impl gates', () => {
  it('registry is empty when blank-context-mode is off', () => {
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks', aiCallable: true } }, 'off'),
      new Map([['stocks', new SpyBlank('stocks', 'x')]]), noop,
    )!;
    expect(prov.getAiCallableFns().size).toBe(0);
  });

  it('a ai-callable config with no runtime Blank impl is skipped', () => {
    const prov = buildBlankFetchProvider(
      makeLoader({ stocks: { name: 'stocks', aiCallable: true } }),
      new Map(), // no host impl
      noop,
    );
    // No blanks at all → provider is undefined (nothing to wire).
    expect(prov).toBeUndefined();
  });

  it('mixed config: only the ai-callable non-script blank is registered', () => {
    const prov = buildBlankFetchProvider(
      makeLoader({
        stocks: { name: 'stocks', aiCallable: true, signature: '(ticker: string)' },
        weather: { name: 'weather' },                          // not ai-callable
        volume: { name: 'volume', aiCallable: true, blankScript: '/v.sh' }, // script → banned
      }),
      new Map([
        ['stocks', realStocks()],                    // audited core → registers
        ['weather', new SpyBlank('weather', 'w')],
        ['volume', new SpyBlank('volume', 'v')],
      ]), noop,
    )!;
    expect([...prov.getAiCallableFns().values()].map(v => v.blankName)).toEqual(['stocks']);
  });
});

describe('buildBlankFetchProvider — ARG SHAPE FLOOR (defense-in-depth)', () => {
  // The primary defense is each blank encoding its own arg; this floor bounds
  // the blast radius of a custom ai-callable blank that forgets to. It must
  // accept normal lookup values and refuse control/URL-injection chars + huge
  // args BEFORE get() runs.
  it('accepts legitimate lookup values (ticker, crypto id, city with spaces/accents/punctuation)', () => {
    for (const ok of ['AMZN', 'btc-usd', 'bitcoin', 'São Paulo', 'St. John\'s', 'Washington, D.C.', 'new york']) {
      expect(aiCallableArgWithinFloor(ok)).toBe(true);
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
      'x'.repeat(AI_CALLABLE_ARG_MAX + 1), // length cap
    ]) {
      expect(aiCallableArgWithinFloor(bad)).toBe(false);
    }
  });

  it('blankFetch refuses a floor-failing arg — get() is NEVER called', async () => {
    // User-trusted SpyBlank (so it passes the capability gate) — proving the
    // FLOOR, not the gate, is what stops the injection arg before get().
    const spy = new SpyBlank('myfetch', 'leaked');
    const prov = buildBlankFetchProvider(
      makeLoader({ myfetch: { name: 'myfetch', aiCallable: true, signature: '(q: string)' } }, 'safe', ['myfetch']),
      new Map([['myfetch', spy]]), noop,
    )!;
    const v = await prov.blankFetch('myfetch', 'AMZN&token=stolen');
    expect(v).toBeUndefined();
    expect(spy.calls).toEqual([]); // get() never reached — refused at the floor
  });
});
