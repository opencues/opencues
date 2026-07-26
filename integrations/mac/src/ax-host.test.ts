import { describe, expect, it } from 'vitest';
import { WriteRing, charBudgetForBundle, countMarkers, freshMarkerAtCursor, replaceQueryForBundle, shouldDropDuplicateChange, utf16Diff } from './ax-host';

describe('utf16Diff', () => {
  it('null on identical', () => {
    expect(utf16Diff('abc', 'abc')).toBeNull();
  });
  it('single insertion', () => {
    expect(utf16Diff('hello world', 'hello brave world')).toEqual({ start: 6, length: 0, text: 'brave ' });
  });
  it('single deletion', () => {
    expect(utf16Diff('hello brave world', 'hello world')).toEqual({ start: 6, length: 6, text: '' });
  });
  it('replacement (the blank fill shape)', () => {
    const d = utf16Diff('capital of france _', 'capital of france Paris');
    expect(d).toEqual({ start: 18, length: 1, text: 'Paris' });
  });
  it('animation frame swap (single char)', () => {
    expect(utf16Diff('q •', 'q _')).toEqual({ start: 2, length: 1, text: '_' });
  });
  it('surrogate pairs stay intact (UTF-16 units)', () => {
    const d = utf16Diff('a 😀 b', 'a 😀 c');
    expect(d).toEqual({ start: 5, length: 1, text: 'c' });
  });
});

describe('freshMarkerAtCursor', () => {
  it('arms on a standalone `_` just typed at the caret', () => {
    expect(freshMarkerAtCursor('capital of peru _', 17, 'capital of peru ')).toBe(16);
  });
  it('does not arm mid-word (snake_case)', () => {
    expect(freshMarkerAtCursor('my_var', 3, 'myvar')).toBeNull();
  });
  it('does not arm when the marker predates the change (caret move)', () => {
    expect(freshMarkerAtCursor('q _ done', 3, 'q _ don')).toBeNull();
  });
  it('arms mid-text when followed by whitespace', () => {
    expect(freshMarkerAtCursor('a _ b', 3, 'a  b')).toBe(2);
  });
  it('arms before closing punctuation', () => {
    expect(freshMarkerAtCursor('(sum _)', 6, '(sum )')).toBe(5);
  });
  it('never arms when the typed char is not the marker', () => {
    expect(freshMarkerAtCursor('hello _x', 8, 'hello _')).toBeNull();
  });
});

describe('shouldDropDuplicateChange', () => {
  const state = { value: 'capital of istanbul _', cursor: 21 };
  it('drops a byte-identical non-echo duplicate (Spotlight fires 2-3 per keystroke)', () => {
    expect(shouldDropDuplicateChange('capital of istanbul _', 21, state, false)).toBe(true);
  });
  it('keeps an echo even when identical — the optimistic write makes echoes look like dups', () => {
    expect(shouldDropDuplicateChange('capital of istanbul _', 21, state, true)).toBe(false);
  });
  it('keeps real changes (value or cursor differs)', () => {
    expect(shouldDropDuplicateChange('capital of istanbul x', 21, state, false)).toBe(false);
    expect(shouldDropDuplicateChange('capital of istanbul _', 20, state, false)).toBe(false);
  });
  it('keeps everything when nothing is focused', () => {
    expect(shouldDropDuplicateChange('x', 1, null, false)).toBe(false);
  });
});

describe('charBudgetForBundle', () => {
  it('Spotlight gets the built-in 37; unknown bundles get null', () => {
    expect(charBudgetForBundle('com.apple.Spotlight')).toBe(37);
    expect(charBudgetForBundle('com.apple.TextEdit')).toBe(null);
  });
  it('env overrides the default and adds new bundles', () => {
    expect(charBudgetForBundle('com.apple.Spotlight', 'com.apple.Spotlight=50')).toBe(50);
    expect(charBudgetForBundle('com.raycast.macos', 'com.raycast.macos=40')).toBe(40);
    expect(charBudgetForBundle('com.apple.Spotlight', 'com.raycast.macos=40')).toBe(37);
  });
  it('a value < 1 removes the entry (opt-out)', () => {
    expect(charBudgetForBundle('com.apple.Spotlight', 'com.apple.Spotlight=0')).toBe(null);
  });
  it('malformed env entries are ignored', () => {
    expect(charBudgetForBundle('com.apple.Spotlight', 'garbage,=5,x=,com.apple.Spotlight=abc')).toBe(37);
  });
});

describe('replaceQueryForBundle', () => {
  it('Spotlight only by default — a real document keeps FILL', () => {
    expect(replaceQueryForBundle('com.apple.Spotlight')).toBe(true);
    expect(replaceQueryForBundle('com.apple.TextEdit')).toBe(false);
    expect(replaceQueryForBundle('com.raycast.macos')).toBe(false);
    expect(replaceQueryForBundle('')).toBe(false);
  });
  it('env is a whitelist that REPLACES the default set', () => {
    expect(replaceQueryForBundle('com.raycast.macos', 'com.raycast.macos')).toBe(true);
    // Spotlight is no longer listed → back to FILL there.
    expect(replaceQueryForBundle('com.apple.Spotlight', 'com.raycast.macos')).toBe(false);
    expect(replaceQueryForBundle('com.apple.Spotlight', 'com.raycast.macos, com.apple.Spotlight')).toBe(true);
  });
  it('"off" disables the feature entirely', () => {
    expect(replaceQueryForBundle('com.apple.Spotlight', 'off')).toBe(false);
    expect(replaceQueryForBundle('com.apple.Spotlight', 'OFF')).toBe(false);
  });
  it('empty / whitespace env falls back to the default set', () => {
    expect(replaceQueryForBundle('com.apple.Spotlight', '')).toBe(true);
    expect(replaceQueryForBundle('com.apple.Spotlight', '   ')).toBe(true);
  });
});

describe('WriteRing', () => {
  it('classifies recent writes as echo, capped', () => {
    const r = new WriteRing(2);
    r.record('a');
    r.record('b');
    expect(r.isEcho('a')).toBe(true);
    r.record('c'); // evicts 'a'
    expect(r.isEcho('a')).toBe(false);
    expect(r.isEcho('b')).toBe(true);
    expect(r.isEcho('c')).toBe(true);
  });
  it('clear() forgets everything (user owns the buffer)', () => {
    const r = new WriteRing();
    r.record('x');
    r.clear();
    expect(r.isEcho('x')).toBe(false);
  });
});
