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
import { BlankLoadingAnimator } from './blank-loading';
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
const STEP = (dir: 'up' | 'down'): BlankIntentDecision => ({ verdict: 'invoke', action: 'step', value: dir });

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

// A SECOND settable blank (different keyword, step, AND a blankSuffix) to
// prove the typed-SET final-state render is blank-generic, not volume-
// specific: it keys on slot.keyword + the read-back, never a hard-coded name.
const BRIGHTNESS_CUE = `---
type: blank
name: brightness
blankKeywords: brightness
blankProximity: 3
blankStep: 10
blankSuffix: %
blankScript: ./brightness.sh
---
`;
async function setupBrightness(gate?: Gate) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/blanks/brightness/BLANK.md': BRIGHTNESS_CUE },
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

  // BUFFER CONTRACT (the regression these tests exist for). The dispatch
  // tests above proved the value changes; this pins what the user SEES.
  // The bug: the typed value word ("40") sat between keyword and `_`, the
  // `keep`-mode splice consumed only "volume" + "_", and the read-back was
  // appended — leaving "volume 40 40". Fix renders the config-intent-style
  // final state "<keyword> <read-back>", consuming the typed value.
  it('SET renders "<keyword> <read-back>" — the typed value is NOT orphaned', async () => {
    const { adapter } = await setupSettable(async () => SET('40'));
    adapter.stubBlankInvoke('volume:set', '');      // set emits nothing
    adapter.stubBlankInvoke('volume:get', '40\n');  // read-back
    adapter.pushText('volume 40 _');
    await tick(); await tick(); await tick(); await tick();
    expect(adapter.getText()).toBe('volume 40');
    // The bug shape — orphaned input word + appended read-back — must not appear.
    expect(adapter.getText()).not.toMatch(/volume\s+40\s+40/);
  });

  it('SET shows the READ-BACK value, not the typed input (clamp fidelity)', async () => {
    const { adapter } = await setupSettable(async () => SET('150'));
    adapter.stubBlankInvoke('volume:set', '');
    adapter.stubBlankInvoke('volume:get', '100\n'); // script clamped 150 → 100
    adapter.pushText('volume 150 _');
    await tick(); await tick(); await tick(); await tick();
    expect(adapter.getText()).toBe('volume 100');   // final state, not the typed 150
    expect(adapter.getText()).not.toContain('150');
  });

  // GENERALISATION: a DIFFERENT settable blank (brightness, with a
  // blankSuffix) renders the same clean final state — proves the fix isn't
  // volume-specific and that blankSuffix composes with the keyword prefix.
  it('generalises to a second settable blank (brightness, with suffix)', async () => {
    const { adapter } = await setupBrightness(async () => SET('70'));
    adapter.stubBlankInvoke('brightness:set', '');
    adapter.stubBlankInvoke('brightness:get', '70\n');
    adapter.pushText('brightness 70 _');
    await tick(); await tick(); await tick(); await tick();
    expect(adapter.getText()).toBe('brightness 70%'); // keyword + read-back + suffix
    expect(adapter.getText()).not.toMatch(/brightness\s+70\s+70/);
  });

  // EDGE: keyword not at position 0 ("set the volume to 40 _"). The typed
  // value + intervening words between keyword and `_` are consumed; content
  // BEFORE the keyword is preserved (consume-context semantics). Documents
  // the actual behaviour for prefixed phrasings.
  it('prefixed phrasing: consumes keyword→blank, preserves the lead-in', async () => {
    const { adapter } = await setupSettable(async () => SET('40'));
    adapter.stubBlankInvoke('volume:set', '');
    adapter.stubBlankInvoke('volume:get', '40\n');
    adapter.pushText('set the volume to 40 _');
    await tick(); await tick(); await tick(); await tick();
    expect(adapter.getText()).toBe('set the volume 40'); // lead-in kept, "to 40" consumed
    expect(adapter.getText()).not.toMatch(/40\s+40/);    // no orphaned value
  });
});

describe('BlankFill × BlankIntent loading coverage', () => {
  // The lag fix: a gated script-blank must animate its `_` DURING the gate's
  // LLM classification (~250-300ms), not only at the post-gate dispatch.
  // Otherwise the slot sits dead for the whole classify window. Pin that
  // start(slotIndex, 'blank-fill') fires WHILE the gate promise is pending.
  it('starts the slot loader before the gate resolves (covers the classify window)', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/volume/BLANK.md': SETTABLE_CUE },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const animator = new BlankLoadingAnimator({ adapter, mode: () => 'off', frameIntervalMs: () => 100 });
    const startSpy = vi.spyOn(animator, 'start');
    // A gate that stays PENDING until we release it — so any loader start we
    // observe happened strictly during classification, before any dispatch.
    let releaseGate: (d: BlankIntentDecision) => void = () => {};
    const gate: Gate = () => new Promise<BlankIntentDecision>((res) => { releaseGate = res; });
    const bf = new BlankFill(adapter, loader, undefined, undefined, undefined, undefined, animator, gate);
    bf.subscribe();

    adapter.pushText('volume 30 _');     // slot at index 2
    await tick(); await tick();          // run the gate IIFE up to `await gate`

    // Loader is animating the `_` while the gate is still unresolved.
    const gateWindowStarts = startSpy.mock.calls.filter(c => c[1] === 'blank-fill');
    expect(gateWindowStarts.length).toBeGreaterThanOrEqual(1);
    expect(startSpy).toHaveBeenCalledWith(2, 'blank-fill');

    releaseGate(INVOKE);                  // let it finish so nothing leaks
    await tick(); await tick();
  });

  // The "no dead gap" property: the loader started before the gate must NOT
  // be stopped until the dispatch produces a result — i.e. it runs
  // continuously gate → dispatch, not flash-stop-flash.
  it('does not stop the loader between the gate and the dispatch (continuous coverage)', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/volume/BLANK.md': SETTABLE_CUE },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const animator = new BlankLoadingAnimator({ adapter, mode: () => 'off', frameIntervalMs: () => 100 });
    const startSpy = vi.spyOn(animator, 'start');
    const stopSpy = vi.spyOn(animator, 'stop');
    let releaseGate: (d: BlankIntentDecision) => void = () => {};
    const gate: Gate = () => new Promise<BlankIntentDecision>((res) => { releaseGate = res; });
    const bf = new BlankFill(adapter, loader, undefined, undefined, undefined, undefined, animator, gate);
    bf.subscribe();
    adapter.stubBlankInvoke('volume:get', '40\n'); // read-back for the dispatch

    adapter.pushText('volume _');         // `_` at index 1
    await tick(); await tick();
    // Mid-gate: loader is running and has NOT been stopped (no premature stop).
    expect(startSpy).toHaveBeenCalledWith(1, 'blank-fill');
    expect(stopSpy).not.toHaveBeenCalled();

    releaseGate(INVOKE);
    await tick(); await tick(); await tick(); await tick();
    // After the result: stopped exactly once, at the end.
    expect(stopSpy).toHaveBeenCalledWith(1, 'blank-fill');
  });

  // No-leak on CEDE: when the gate suppresses the blank, the loader started
  // for the classify window must be released (not left spinning forever).
  it('releases the loader when the gate CEDEs (no leak)', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/volume/BLANK.md': SETTABLE_CUE },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const animator = new BlankLoadingAnimator({ adapter, mode: () => 'off', frameIntervalMs: () => 100 });
    const startSpy = vi.spyOn(animator, 'start');
    const stopSpy = vi.spyOn(animator, 'stop');
    let releaseGate: (d: BlankIntentDecision) => void = () => {};
    const gate: Gate = () => new Promise<BlankIntentDecision>((res) => { releaseGate = res; });
    const bf = new BlankFill(adapter, loader, undefined, undefined, undefined, undefined, animator, gate);
    bf.subscribe();

    adapter.pushText('the volume was lovely _');
    await tick(); await tick();
    expect(startSpy).toHaveBeenCalledWith(expect.any(Number), 'blank-fill'); // animated during classify

    releaseGate(CEDE);
    await tick(); await tick();
    // CEDE suppresses the script — but the loader must be released.
    expect(stopSpy).toHaveBeenCalledWith(expect.any(Number), 'blank-fill');
  });
});

describe('BlankFill × BlankIntent typed-STEP', () => {
  // SETTABLE_CUE has blankStep: 6. Stub the get to a number so STEP can
  // compute current ± step; the set then dispatches the new ABSOLUTE value.
  it('STEP up reads current, sets current + blankStep (54 → 60)', async () => {
    const { adapter } = await setupSettable(async () => STEP('up'));
    adapter.stubBlankInvoke('volume:get', '54\n'); // read-back value
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('volume up _');
    await tick(); await tick(); await tick(); await tick();
    const calls = setArgs(spawnSpy);
    expect(calls.some(a => a.includes('set') && a.includes('60'))).toBe(true);
  });

  it('STEP down sets current - blankStep (54 → 48)', async () => {
    const { adapter } = await setupSettable(async () => STEP('down'));
    adapter.stubBlankInvoke('volume:get', '54\n');
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('volume down _');
    await tick(); await tick(); await tick(); await tick();
    const calls = setArgs(spawnSpy);
    expect(calls.some(a => a.includes('set') && a.includes('48'))).toBe(true);
  });

  it('STEP clamps at 100 (98 + 6 → 100)', async () => {
    const { adapter } = await setupSettable(async () => STEP('up'));
    adapter.stubBlankInvoke('volume:get', '98\n');
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('volume up _');
    await tick(); await tick(); await tick(); await tick();
    const calls = setArgs(spawnSpy);
    expect(calls.some(a => a.includes('set') && a.includes('100'))).toBe(true);
  });

  it('STEP renders "<keyword> <read-back>" — the direction word is NOT orphaned', async () => {
    // Buffer contract for STEP (mirrors the SET buffer tests). `volume up _`
    // must render the final state "volume <value>", consuming the "up"
    // direction word — not leave "volume up 60".
    const { adapter } = await setupSettable(async () => STEP('up'));
    adapter.stubBlankInvoke('volume:set', '');
    adapter.stubBlankInvoke('volume:get', '60\n');
    adapter.pushText('volume up _');
    await tick(); await tick(); await tick(); await tick();
    expect(adapter.getText()).toBe('volume 60');
    expect(adapter.getText()).not.toContain('up'); // direction word consumed
  });

  it('STEP with a non-numeric current value degrades to a plain get (no set)', async () => {
    const { adapter } = await setupSettable(async () => STEP('up'));
    adapter.stubBlankInvoke('volume:get', 'loud\n'); // unparseable
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('volume up _');
    await tick(); await tick(); await tick(); await tick();
    const calls = setArgs(spawnSpy);
    expect(calls.some(a => a.includes('set'))).toBe(false);
  });

  it('STEP on a NON-settable blank (no blankStep) degrades to a plain get', async () => {
    const { adapter } = await setup(async () => STEP('up')); // weather: no blankStep
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('weather up _');
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
