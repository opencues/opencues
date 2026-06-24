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
import { BlankFill } from './blank-fill';
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

type Gate = (text: string, blankName: string) => Promise<'invoke' | 'cede'>;

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
    const { adapter } = await setup(async () => 'cede');
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('the weather was lovely today _');
    await tick();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('INVOKE runs the script as today', async () => {
    const { adapter } = await setup(async () => 'invoke');
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
    const gate: Gate = async (text, blank) => { calls.push([text, blank]); return 'cede'; };
    const { adapter } = await setup(gate);
    adapter.pushText('weather paris _');
    await tick();
    expect(calls).toEqual([['weather paris _', 'weather']]);
  });

  it('STALENESS: a verdict that resolves after the buffer changed does not dispatch', async () => {
    let release!: (v: 'invoke' | 'cede') => void;
    const gate: Gate = () => new Promise(r => { release = r; });
    const { adapter } = await setup(gate);
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    adapter.pushText('weather london _');   // arms the gate (pending)
    await tick();
    // user keeps typing — buffer moves on before the verdict lands
    adapter.pushText('weather london is nice');
    await tick();
    // now the stale gate finally resolves INVOKE
    release('invoke');
    await tick();
    // the stale 'weather london _' dispatch must be dropped
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
