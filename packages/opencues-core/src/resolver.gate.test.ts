import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CueResolver } from './resolver';
import type { CueContext, CueSource, CueSourceResult } from './types';

function src(id: string, priority: number, calls: string[]): CueSource {
  return { id, priority, isCycleable: true, supports: () => true, getCues: async (): Promise<CueSourceResult> => { calls.push(id); return { results: [] }; } } as unknown as CueSource;
}
const ctx: CueContext = { text: 'the zorb is fine', words: ['the', 'zorb', 'is', 'fine'] };

describe('CueResolver — the fan-out gate', () => {
  it('gated sources wait for the verdict and are skipped on NO; ungated sources dispatch at once', async () => {
    const calls: string[] = [];
    const r = new CueResolver([src('session-cue', 88, calls), src('sentence-cue:zeta', 85, calls), src('word-cues', 60, calls)], { parallel: true, timeout: 1000 } as never);
    let release!: (v: boolean) => void;
    const verdict = new Promise<boolean>((res) => { release = res; });
    const pass = r.resolve(ctx, { gate: { verdict, applies: (id) => id !== 'session-cue' } });
    await new Promise((t) => setTimeout(t, 5));
    assert.deepStrictEqual(calls, ['session-cue']);          // only the ungated source has gone out
    release(false);
    await pass;
    assert.deepStrictEqual(calls, ['session-cue']);          // NO: the gated pair never dispatched
  });
  it('YES releases the gated sources; a rejected verdict fails open', async () => {
    const calls: string[] = [];
    const r = new CueResolver([src('session-cue', 88, calls), src('sentence-cue:zeta', 85, calls)], { parallel: true, timeout: 1000 } as never);
    await r.resolve(ctx, { gate: { verdict: Promise.resolve(true), applies: (id) => id.startsWith('sentence-cue:') } });
    assert.deepStrictEqual(calls.sort(), ['sentence-cue:zeta', 'session-cue']);
    const calls2: string[] = [];
    const r2 = new CueResolver([src('sentence-cue:zeta', 85, calls2)], { parallel: true, timeout: 1000 } as never);
    await r2.resolve(ctx, { gate: { verdict: Promise.reject(new Error('judge down')), applies: () => true } });
    assert.deepStrictEqual(calls2, ['sentence-cue:zeta']);
  });
});
