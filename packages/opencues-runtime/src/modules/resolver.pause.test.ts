/**
 * The pause before a resolve is chosen from the SHAPE of the last keystroke
 * (terminator → fast, inside a word → longer, anything else → the base), never
 * from the words. Pins the rule per shape and its language-agnostic edges:
 * a CJK letter is never "inside a word", a digit-dot is not a terminator,
 * and a mid-buffer edit gets the plain pause.
 */
import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

function make(opts: { debounceMs?: number; terminatorDebounceMs?: number; inWordDebounceMs?: number } = {}) {
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
  it('defaults: base 500, terminator 100, inside a word 800', () => {
    const r = make();
    expect(typed(r, 'the zor', 'the zorb')).toBe(800);           // inside a word
    expect(typed(r, 'the zorb ')).toBeNull();                    // a space adds nothing to resolve: the pending resolve stands
    expect(typed(r, 'the zorb is', 'the zorb is.')).toBe(100);   // closed sentence
    expect(typed(r, 'the zorb is. ')).toBeNull();                // the space after it neither re-fires nor supersedes
    expect(typed(r, 'the zorb is. no', 'the zorb is. no\n')).toBeNull();  // a newline is whitespace too …
    expect(typed(r, 'the zorb is. no\nno')).toBe(800);           // … and typing on resumes the word rule
    expect(typed(r, 'the zorb is. no\nno,')).toBe(500);          // a comma is a boundary, not a close
    expect(typed(r, 'the zorb is. no\nno, ')).toBeNull();
    expect(typed(r, 'the zorb is. no\nno, x')).toBe(800);
  });
  it('the three numbers are options', () => {
    const r = make({ debounceMs: 50, terminatorDebounceMs: 10, inWordDebounceMs: 90 });
    expect(typed(r, 'a', 'ab')).toBe(90);
    expect(typed(r, 'ab,')).toBe(50);
    expect(typed(r, 'ab, c', 'ab, c.')).toBe(10);
  });
  it('a `.` right after a digit is not a terminator: 3. may become 3.5', () => {
    const r = make();
    expect(typed(r, 'costs 3', 'costs 3.')).toBe(500);
    expect(typed(r, 'costs 3.5')).toBe(800);
    expect(typed(r, 'costs 3.5.')).toBe(500);   // still a digit before the period — the rule is by shape, not by counting periods
    expect(typed(r, 'costs 3.5 zorb', 'costs 3.5 zorb.')).toBe(100);
  });
  it('a script without word delimiters is never "inside a word" — CJK keeps the base and its terminators fire fast', () => {
    const r = make();
    expect(typed(r, 'これは', 'これはテ')).toBe(500);
    expect(typed(r, 'これはテスト。')).toBe(100);
    expect(typed(r, 'これはテスト。 ')).toBeNull();
    expect(typed(r, 'これはテスト。 sure', 'これはテスト。 surel')).toBe(800);   // back in a Latin word
  });
  it('only an append at the end of the buffer is shaped: a mid-buffer edit, a deletion, or a paste-over gets the base', () => {
    const r = make();
    expect(typed(r, 'the zorb is', 'the zorb i')).toBe(500);          // backspace
    expect(typed(r, 'the ZORB i')).toBe(500);                         // edit in the middle (same length, not an append)
    expect(typed(r, 'the ZORB is.', 'the ZORB is. ok')).toBe(800);    // appending again resumes shaping
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
