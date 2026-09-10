/**
 * The pause before a resolve is chosen from the SHAPE of the last keystroke
 * (terminator → fast, whitespace-only append → nothing, anything else → the
 * base), never from the words. Pins the rule per shape and its edges: a
 * digit-dot is not a terminator, CJK terminators count, a prompt that ends
 * after a plain word keeps the base (no "inside a word" hold — that was a
 * 300ms regression on the commonest prompt shape), and a mid-buffer edit
 * gets the plain pause.
 */
import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

function make(opts: { debounceMs?: number; terminatorDebounceMs?: number } = {}) {
  const adapter = new MockAdapter();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  return new Resolver(adapter, new HighlightState(), new DynDefs(), loader, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter: {}, ...opts,
  });
}
/** type the buffer one append at a time and return the pause chosen for the LAST state */
function typed(r: Resolver, ...states: string[]): number | null {
  let d: number | null = 0;
  for (const s of states) d = r.pickDelay(s);
  return d;
}

describe('Resolver.pickDelay — the pause from the shape of the last keystroke', () => {
  it('defaults: base 500, terminator 100; a prompt ending after a plain word keeps the base', () => {
    const r = make();
    expect(typed(r, 'the zor', 'the zorb')).toBe(500);           // after a plain word: the person may simply have stopped
    expect(typed(r, 'the zorb ')).toBeNull();                    // a space adds nothing to resolve: the pending resolve stands
    expect(typed(r, 'the zorb is', 'the zorb is.')).toBe(100);   // closed sentence
    expect(typed(r, 'the zorb is. ')).toBeNull();                // the space after it neither re-fires nor supersedes
    expect(typed(r, 'the zorb is. no', 'the zorb is. no\n')).toBeNull();  // a newline is whitespace too …
    expect(typed(r, 'the zorb is. no\nno')).toBe(500);           // … and typing on resumes the base
    expect(typed(r, 'the zorb is. no\nno,')).toBe(500);          // a comma is a boundary, not a close
    expect(typed(r, 'the zorb is. no\nno, ')).toBeNull();
    expect(typed(r, 'the zorb is. no\nno, x')).toBe(500);
  });
  it('the two numbers are options', () => {
    const r = make({ debounceMs: 50, terminatorDebounceMs: 10 });
    expect(typed(r, 'a', 'ab')).toBe(50);
    expect(typed(r, 'ab,')).toBe(50);
    expect(typed(r, 'ab, c', 'ab, c.')).toBe(10);
  });
  it('a `.` right after a digit is not a terminator: 3. may become 3.5', () => {
    const r = make();
    expect(typed(r, 'costs 3', 'costs 3.')).toBe(500);
    expect(typed(r, 'costs 3.5')).toBe(500);
    expect(typed(r, 'costs 3.5.')).toBe(500);   // still a digit before the period — the rule is by shape, not by counting periods
    expect(typed(r, 'costs 3.5 zorb', 'costs 3.5 zorb.')).toBe(100);
  });
  it('CJK: a letter keeps the base and its terminators fire fast', () => {
    const r = make();
    expect(typed(r, 'これは', 'これはテ')).toBe(500);
    expect(typed(r, 'これはテスト。')).toBe(100);
    expect(typed(r, 'これはテスト。 ')).toBeNull();
    expect(typed(r, 'これはテスト。 sure', 'これはテスト。 surel')).toBe(500);
  });
  it('only an append at the end of the buffer is shaped: a mid-buffer edit, a deletion, or a paste-over gets the base', () => {
    const r = make();
    expect(typed(r, 'the zorb is', 'the zorb i')).toBe(500);          // backspace
    expect(typed(r, 'the ZORB i')).toBe(500);                         // edit in the middle (same length, not an append)
    expect(typed(r, 'the ZORB is.', 'the ZORB is. ok')).toBe(500);    // appending again resumes shaping
    expect(typed(r, 'the ZORB is. ok.')).toBe(100);
  });
  it('the first observation has nothing to compare with and gets the base', () => {
    expect(make().pickDelay('the zorb')).toBe(500);
  });
  it('a fresh `_` is never deduped away, even when the append is otherwise whitespace-shaped', () => {
    const r = make();
    typed(r, 'the zorb _');
    expect(r.pickDelay('the zorb _ ', true)).not.toBeNull();
  });
});

describe('scheduleResolve — a whitespace-only append re-arms the pending resolve, never a twin', () => {
  function live() {
    const adapter = new MockAdapter();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const resolver = new Resolver(adapter, new HighlightState(), new DynDefs(), loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter: {}, debounceMs: 40, terminatorDebounceMs: 5,
    });
    const resolved: string[] = [];
    (resolver as unknown as { _resolver: { resolve(ctx: { text: string }): Promise<{ results: never[] }> } })._resolver = {
      resolve: async (ctx) => { resolved.push(ctx.text); return { results: [] }; },
    };
    resolver.subscribe();
    return { adapter, resolved };
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('a space keeps the debounce ticking on the pre-space text: the resolve fires 40ms after the SPACE, once', async () => {
    const { adapter, resolved } = live();
    adapter.pushText('the zorb');
    await sleep(25);
    adapter.pushText('the zorb ');          // whitespace-only append at +25ms
    await sleep(25);                         // +50ms from the letter: a leaked timer would have fired by now
    expect(resolved).toEqual([]);
    await sleep(30);                         // +55ms from the space
    expect(resolved).toEqual(['the zorb']);
  });
  it('a terminator fires fast and the following space neither re-fires nor supersedes it', async () => {
    const { adapter, resolved } = live();
    adapter.pushText('the zorb is');
    adapter.pushText('the zorb is.');
    await sleep(20);
    expect(resolved).toEqual(['the zorb is.']);
    adapter.pushText('the zorb is. ');
    await sleep(70);
    expect(resolved).toEqual(['the zorb is.']);   // no twin
    adapter.pushText('the zorb is. n');
    await sleep(70);
    expect(resolved).toEqual(['the zorb is.', 'the zorb is. n']);
  });
});
