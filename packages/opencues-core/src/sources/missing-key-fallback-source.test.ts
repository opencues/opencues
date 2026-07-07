/**
 * Tests for MissingKeyFallbackSource — the lowest-priority source that
 * turns "no LLM API key configured" into a visible, in-buffer message
 * instead of a silent no-op on `_`.
 *
 * See docs/features/missing-key-fallback.md for the full contract:
 * only claims when `_` is present in `context.words`, never claims a
 * slot already consumed by a higher-priority source, and always offers
 * `_` as alternatives[0] so cycling back dismisses the message.
 */

import { describe, expect, it } from 'vitest';
import { MissingKeyFallbackSource } from './missing-key-fallback-source';
import type { CueContext } from '../types';

function ctx(text: string, extra?: Partial<CueContext>): CueContext {
  return { text, words: text.split(/\s+/).filter(w => w), ...extra };
}

describe('MissingKeyFallbackSource — happy path', () => {
  it('supports() claims a buffer containing a bare `_`', () => {
    const src = new MissingKeyFallbackSource({ message: '[no key]' });
    expect(src.supports(ctx('hello _ world'))).toBe(true);
  });

  it('supports() does not claim a buffer with no `_`', () => {
    const src = new MissingKeyFallbackSource({ message: '[no key]' });
    expect(src.supports(ctx('hello world'))).toBe(false);
  });

  it('getCues substitutes the configured message at the `_` position', async () => {
    const src = new MissingKeyFallbackSource({ message: '[OpenCues: no API key]' });
    const result = await src.getCues(ctx('what is the weather _'));

    expect(result.results.length).toBe(1);
    const r = result.results[0];
    expect(r.wordIndex).toBe(4);
    expect(r.word).toBe('_');
    expect(r.source).toBe('missing-key-fallback');
    expect(r.priority).toBe(1);
  });

  it('alternatives[0] is the bare `_` (cycle-back dismiss) and alternatives[1] is the message', async () => {
    const src = new MissingKeyFallbackSource({ message: '[hint text]' });
    const result = await src.getCues(ctx('draft email _'));

    expect(result.results[0].alternatives).toEqual(['_', '[hint text]']);
  });

  it('carries a fixed, user-facing cueTip regardless of the configured message', async () => {
    const src = new MissingKeyFallbackSource({ message: '[anything]' });
    const result = await src.getCues(ctx('_'));

    expect(result.results[0].cueTip).toBe('OpenCues is not configured — add an API key to use blanks');
  });

  it('isCycleable is false — this source offers a dismiss, not a cycle set', () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    expect(src.isCycleable).toBe(false);
  });

  it('id is the stable "missing-key-fallback" string used by build-sources\' hasLLMSource check', () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    expect(src.id).toBe('missing-key-fallback');
  });

  it('priority is 1 — strictly below every shipped LLM-backed source', () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    expect(src.priority).toBe(1);
  });
});

describe('MissingKeyFallbackSource — edge cases', () => {
  it('claims the FIRST `_` when multiple blanks are present in one buffer', async () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    const result = await src.getCues(ctx('_ and also _'));

    expect(result.results.length).toBe(1);
    expect(result.results[0].wordIndex).toBe(0);
  });

  it('cedes when the blank slot is already in consumedBlankSlots', async () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    const result = await src.getCues(ctx('hello _ world', { consumedBlankSlots: [1] }));

    expect(result.results).toEqual([]);
  });

  it('still claims when consumedBlankSlots names a DIFFERENT index than the blank', async () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    const result = await src.getCues(ctx('hello _ world', { consumedBlankSlots: [99] }));

    expect(result.results.length).toBe(1);
  });

  it('empty consumedBlankSlots array behaves like undefined (still claims)', async () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    const result = await src.getCues(ctx('hello _ world', { consumedBlankSlots: [] }));

    expect(result.results.length).toBe(1);
  });

  it('empty string message is accepted at construction (build-sources gates on length before constructing, not this class)', async () => {
    const src = new MissingKeyFallbackSource({ message: '' });
    const result = await src.getCues(ctx('_'));

    expect(result.results[0].alternatives).toEqual(['_', '']);
  });

  it('very long message string is passed through unmodified', async () => {
    const longMsg = '[OpenCues] '.repeat(500);
    const src = new MissingKeyFallbackSource({ message: longMsg });
    const result = await src.getCues(ctx('_'));

    expect(result.results[0].alternatives[1]).toBe(longMsg);
    expect(result.results[0].alternatives[1].length).toBe(longMsg.length);
  });

  it('message containing unicode / emoji is passed through unmodified', async () => {
    const src = new MissingKeyFallbackSource({ message: '⚠️ 设置 API 密钥 →' });
    const result = await src.getCues(ctx('_'));

    expect(result.results[0].alternatives[1]).toBe('⚠️ 设置 API 密钥 →');
  });

  it('getCues on an empty words array returns no results', async () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    const result = await src.getCues({ text: '', words: [] });

    expect(result.results).toEqual([]);
  });

  it('supports() returns false on an empty words array', () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    expect(src.supports({ text: '', words: [] })).toBe(false);
  });

  it('a word merely containing an underscore (e.g. "snake_case") does NOT count as a blank', async () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    const result = await src.getCues(ctx('use snake_case here'));

    expect(result.results).toEqual([]);
    expect(src.supports(ctx('use snake_case here'))).toBe(false);
  });
});

describe('MissingKeyFallbackSource — invalid input', () => {
  it('getCues on context with only whitespace text yields no `_` and no results', async () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    const result = await src.getCues(ctx('   '));

    expect(result.results).toEqual([]);
  });

  it('supports() tolerates a words array containing non-string-shaped empty entries gracefully', () => {
    // words is typed as string[]; an empty string slipped in should never
    // be mistaken for the blank sentinel.
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    expect(src.supports({ text: '', words: [''] })).toBe(false);
  });

  it('malformed consumedBlankSlots (non-numeric-looking but still a number array) does not throw', async () => {
    const src = new MissingKeyFallbackSource({ message: '[msg]' });
    // NaN can never equal a real index, so this should behave like "not consumed".
    const result = await src.getCues(ctx('_', { consumedBlankSlots: [NaN] }));

    expect(result.results.length).toBe(1);
  });

  // Runtime-invalid shape: config constructed without a `message` at all.
  // TypeScript's MissingKeyFallbackConfig requires `message: string`, so this
  // is only reachable via an untyped caller (e.g. JS consumer, or a bad
  // JSON-derived options object cast through `as`). The class does not
  // guard against `undefined` — it interpolates it straight into the
  // alternatives array. Documenting current (arguably buggy) behavior
  // without patching the source, per task rules.
  it.fails('getCues with a missing `message` field should not crash and should degrade gracefully', async () => {
    const src = new MissingKeyFallbackSource({} as unknown as { message: string });
    const result = await src.getCues(ctx('_'));
    // Expected (if the class defended against this): alternatives[1] is a
    // string (empty or a safe fallback). Actual: alternatives[1] is
    // `undefined`, which downstream substitution/rendering code likely
    // does not expect from a CueResult.alternatives entry.
    expect(typeof result.results[0].alternatives[1]).toBe('string');
  });
});
