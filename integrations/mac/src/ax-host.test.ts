import { describe, expect, it } from 'vitest';
import { WriteRing, countMarkers, freshMarkerAtCursor, utf16Diff } from './ax-host';

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
