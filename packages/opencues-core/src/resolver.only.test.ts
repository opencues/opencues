import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CueResolver } from './resolver';
import type { CueContext, CueSource, CueSourceResult } from './types';

function src(id: string, priority: number, calls: string[]): CueSource {
  return { id, priority, isCycleable: true, supports: () => true, getCues: async (): Promise<CueSourceResult> => { calls.push(id); return { results: [] }; } } as unknown as CueSource;
}
const ctx: CueContext = { text: 'zorb undo _', words: ['zorb', 'undo', '_'] };

describe('CueResolver — resolve({ only }) dispatches nothing outside the set', () => {
  for (const parallel of [true, false]) {
    it(`${parallel ? 'parallel' : 'sequential'}: only config-intent is asked; the others make no call at all`, async () => {
      const calls: string[] = [];
      const r = new CueResolver([src('transform-blank', 93, calls), src('config-intent', 94, calls), src('fluid-blank', 95, calls), src('session-cue', 88, calls)], { parallel, timeout: 1000 } as never);
      await r.resolve(ctx, { only: (id) => id === 'config-intent' });
      assert.deepStrictEqual(calls, ['config-intent']);
      calls.length = 0;
      await r.resolve(ctx);
      assert.strictEqual(calls.length, 4);   // without `only`, everyone runs
    });
  }
});
