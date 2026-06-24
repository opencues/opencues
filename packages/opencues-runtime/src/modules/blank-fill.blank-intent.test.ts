/**
 * BlankFill × BlankIntent gate — runtime-contract scenarios.
 *
 * These assert the GATE WIRING contract, not LLM quality (the bench owns
 * that). The injected gate is a deterministic stub so the assertions hold
 * regardless of what a real classifier would say:
 *
 *   - CEDE  → the blank's script is SUPPRESSED (no spawn / no blankInvoke).
 *   - INVOKE → the script runs exactly as today.
 *   - gate throws → DEGRADE to running the script (never silently disable
 *     a user-summoned tool).
 *   - no gate wired → today's proximity behaviour (script runs).
 *   - stale buffer (gate resolved after the user moved on) → no dispatch.
 */

import { describe, expect, it, vi } from 'vitest';
import { BlankFill, type BlankIntentDecision } from './blank-fill';
import { ConfigLoader } from './config-loader';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';

const TIPS = wrapTipsAsCuesMd({ concepts: [] });
const WEATHER_CUE = `---
type: blank
name: weather
blankKeywords: weather
blankProximity: 10
blankScript: ./weather.sh
---
`;

type Gate = (text: string, blankName: string) => Promise<BlankIntentDecision>;
const INVOKE: BlankIntentDecision = { verdict: 'invoke', action: 'get', value: null };
const CEDE: BlankIntentDecision = { verdict: 'cede' };
const SET = (value: string): BlankIntentDecision => ({ verdict: 'invoke', action: 'set', value });

async function setup(gate?: Gate) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/blanks/weather/BLANK.md': WEATHER_CUE },
  });
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const bf = new BlankFill(adapter, loader, undefined, undefined, undefined, undefined, undefined, gate);
  bf.subscribe();
  return { adapter, loader, bf };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('BlankFill × BlankIntent gate', () => {
  it('CEDE suppresses the script (no spawn)', async () => {
    const { adapter } = await setup(async () => CEDE);
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('the weather was lovely today _');
    await tick();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('INVOKE runs the script as today', async () => {
    const { adapter } = await setup(async () => INVOKE);
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('weather london _');
    await tick();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith(expect.objectContaining({
      command: 'bash',
      args: expect.arrayContaining(['get', 'weather', 'london']),
    }));
  });

  it('a thrown gate DEGRADES to running the script', async () => {
    const { adapter } = await setup(async () => { throw new Error('classifier exploded'); });
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('weather london _');
    await tick();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('no gate wired → script runs (today behaviour, byte-identical)', async () => {
    const { adapter } = await setup(undefined);
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('the weather was lovely today _');
    // No gate → synchronous dispatch, no tick needed.
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('passes (text, blankName) to the gate', async () => {
    const calls: Array<[string, string]> = [];
    const gate: Gate = async (text, blank) => { calls.push([text, blank]); return CEDE; };
    const { adapter } = await setup(gate);
    adapter.pushText('weather paris _');
    await tick();
    expect(calls).toEqual([['weather paris _', 'weather']]);
  });

  it('STALENESS: a verdict that resolves after the buffer changed does not dispatch', async () => {
    let release!: (v: BlankIntentDecision) => void;
    const gate: Gate = () => new Promise(r => { release = r; });
    const { adapter } = await setup(gate);
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('weather london _');   // arms the gate (pending)
    await tick();
    // user keeps typing — buffer moves on before the verdict lands
    adapter.pushText('weather london is nice');
    await tick();
    // now the stale gate finally resolves INVOKE
    release(INVOKE);
    await tick();
    // the stale 'weather london _' dispatch must be dropped
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('REGRESSION: a built-in blank (no blankScript, blankInvoke path) is ALSO gated', async () => {
    // The shipped fetch blanks (weather/stocks/countries/…) omit impl: and
    // run via blankInvoke. Gating on `blankScript || impl` left them ungated
    // — this pins the fix (gate every maybeRunScripts dispatch).
    const BUILTIN_CUE = `---
type: blank
name: facts
blankKeywords: capital of
blankProximity: 5
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      // Built-in blanks dispatch via blankInvoke — the host must advertise
      // that capability (real CC does) or the slot is skipped before the
      // gate. This is exactly why the field-based gate check missed them.
      // Mirror the default cap set (so text-change source detection works)
      // and add blank-invoke.
      capabilities: ['shimmer', 'render-override', 'dim-ranges', 'highlight-range', 'selection', 'spawn-process', 'file-read', 'file-write', 'force-render', 'change-source', 'blank-invoke'],
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/facts/BLANK.md': BUILTIN_CUE },
    });
    adapter.stubBlankInvoke('facts:get', 'Paris\n');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    let ceded = false;
    const gate: Gate = async () => { ceded = true; return CEDE; };
    const bf = new BlankFill(adapter, loader, undefined, undefined, undefined, undefined, undefined, gate);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('capital of france _');
    await tick();
    expect(ceded).toBe(true); // the gate WAS consulted for the built-in blank
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(adapter.blankInvokeCalls.length).toBe(0); // CEDE → no blankInvoke dispatch
  });
});

// Typed-SET: a `set <value>` verdict on a SETTABLE blank (one with
// `blankStep`) dispatches `set <value>` then a read-back `get`. On a
// non-settable blank, or a non-numeric value, it degrades to a plain get.
const SETTABLE_CUE = `---
type: blank
name: volume
blankKeywords: volume
blankProximity: 3
blankStep: 6
blankScript: ./volume.sh
---
`;
async function setupSettable(gate?: Gate) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/blanks/volume/BLANK.md': SETTABLE_CUE },
  });
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const bf = new BlankFill(adapter, loader, undefined, undefined, undefined, undefined, undefined, gate);
  bf.subscribe();
  return { adapter, loader, bf };
}
const setArgs = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map(c => (c[0] as { args: string[] }).args);

describe('BlankFill × BlankIntent typed-SET', () => {
  it('SET on a settable blank dispatches `set <value>` THEN a read-back `get`', async () => {
    const { adapter } = await setupSettable(async () => SET('30'));
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('volume 30 _');
    // set is awaited before the get → allow both microtask hops.
    await tick(); await tick(); await tick();
    const calls = setArgs(spawnSpy);
    expect(calls.some(a => a.includes('set') && a.includes('30'))).toBe(true);
    expect(calls.some(a => a.includes('get'))).toBe(true);
    // ordering: set fired before get
    const setIdx = calls.findIndex(a => a.includes('set'));
    const getIdx = calls.findIndex(a => a.includes('get'));
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeLessThan(getIdx);
  });

  it('SET on a NON-settable blank (no blankStep) degrades to a plain get', async () => {
    // weather has no blankStep → a stray `set` verdict must NOT issue a set.
    const { adapter } = await setup(async () => SET('30'));
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('weather 30 _');
    await tick(); await tick();
    const calls = setArgs(spawnSpy);
    expect(calls.some(a => a.includes('set'))).toBe(false);
    expect(calls.some(a => a.includes('get'))).toBe(true);
  });

  it('SET with a non-numeric value degrades to a plain get (defensive)', async () => {
    const { adapter } = await setupSettable(async () => SET('loud'));
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('volume loud _');
    await tick(); await tick();
    const calls = setArgs(spawnSpy);
    expect(calls.some(a => a.includes('set'))).toBe(false);
    expect(calls.some(a => a.includes('get'))).toBe(true);
  });

  it('a plain get-invoke on a settable blank does NOT issue a set', async () => {
    const { adapter } = await setupSettable(async () => INVOKE);
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('volume _');
    await tick(); await tick();
    const calls = setArgs(spawnSpy);
    expect(calls.some(a => a.includes('set'))).toBe(false);
    expect(calls.some(a => a.includes('get'))).toBe(true);
  });
});

// Phase-1 line-scoped window (runtime side). When the gate is active,
// BlankFill.matchKeyword uses the SHARED keyword-window predicate
// (line-scoped) instead of per-blank `blankProximity` — identical to the
// resolver sources, so they can't disagree on who owns the `_`.
describe('BlankFill × BlankIntent Phase-1 line-scoped window', () => {
  // brightness-shaped: keyword-bound, NO blankProximity → defaults to 0.
  const BRIGHT_CUE = `---
type: blank
name: brightness
blankKeywords: brightness
blankStep: 10
blankScript: ./b.sh
---
`;
  async function setupMode(mode: 'on' | 'off', gate?: Gate) {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/mock/CUES.md': TIPS,
        '/proj/blanks/brightness/BLANK.md': BRIGHT_CUE,
        '/proj/.cues/OPENCUES.md': `---\nblank-intent-mode: ${mode}\n---\n`,
      },
    });
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/.cues/OPENCUES.md' });
    await loader.load();
    const bf = new BlankFill(adapter, loader, undefined, undefined, undefined, undefined, undefined, gate);
    return { bf };
  }
  const names = (bf: BlankFill, text: string) => bf.scan(text).map(s => s.blankName);

  it('gate ON + wired: non-adjacent keyword on the same line ("brightness 30 _", proximity 0) matches', async () => {
    const { bf } = await setupMode('on', async () => INVOKE);
    expect(names(bf, 'brightness 30 _')).toContain('brightness');
  });

  it('gate ON: a FAR keyword on the SAME line still matches (line-scope is not word-capped)', async () => {
    const { bf } = await setupMode('on', async () => INVOKE);
    expect(names(bf, 'brightness in the room of this house was really quite nice and pleasant 50 _')).toContain('brightness');
  });

  it('gate ON: a keyword on a PREVIOUS line does NOT match (line-scoped)', async () => {
    const { bf } = await setupMode('on', async () => INVOKE);
    expect(names(bf, 'i adjusted the brightness\nplease set it to 50 _')).not.toContain('brightness');
  });

  it('gate OFF: "brightness 30 _" produces NO slot (tuned proximity 0 — master behaviour)', async () => {
    const { bf } = await setupMode('off', async () => INVOKE);
    expect(names(bf, 'brightness 30 _')).not.toContain('brightness');
  });

  it('mode ON but gate NOT wired: tuned proximity applies (line-scope needs an active gate)', async () => {
    const { bf } = await setupMode('on', undefined);
    expect(names(bf, 'brightness 30 _')).not.toContain('brightness');
  });

  it('adjacent "brightness _" matches in BOTH states', async () => {
    const on = await setupMode('on', async () => INVOKE);
    const off = await setupMode('off');
    expect(names(on.bf, 'brightness _')).toContain('brightness');
    expect(names(off.bf, 'brightness _')).toContain('brightness');
  });
});
