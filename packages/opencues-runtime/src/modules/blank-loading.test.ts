import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  BlankLoadingAnimator,
  framesFor,
  BOUNCE_FRAMES,
  DOT_WALK_FRAMES,
  BRAILLE_ROTATE_FRAMES,
  ALL_FRAME_CHARS,
} from './blank-loading';
import type { HostAdapter } from '../adapter';

// Minimal HostAdapter stub — only the bits the animator touches.
function makeAdapter(initial: string): {
  adapter: HostAdapter;
  setTextCalls: string[];
  setBufferDirect: (s: string) => void;
} {
  let buffer = initial;
  const setTextCalls: string[] = [];
  const adapter: Partial<HostAdapter> = {
    getText: () => buffer,
    setText: (s: string) => { buffer = s; setTextCalls.push(s); },
  };
  return {
    adapter: adapter as HostAdapter,
    setTextCalls,
    setBufferDirect: (s: string) => { buffer = s; },
  };
}

describe('framesFor', () => {
  it('returns BOUNCE_FRAMES for "bounce"', () => {
    expect(framesFor('bounce')).toEqual(['_', '-', '‾', '-']);
    expect(framesFor('bounce')).toBe(BOUNCE_FRAMES);
  });
  it('returns DOT_WALK_FRAMES for "dot-walk"', () => {
    expect(framesFor('dot-walk')).toEqual(['_', '.', '·', '.']);
    expect(framesFor('dot-walk')).toBe(DOT_WALK_FRAMES);
  });
  it('returns BRAILLE_ROTATE_FRAMES for "braille-rotate"', () => {
    expect(framesFor('braille-rotate')).toEqual(['_', '⠁', '⠈', '⠐', '⠠', '⠄', '⠂']);
    expect(framesFor('braille-rotate')).toBe(BRAILLE_ROTATE_FRAMES);
  });
  it('returns empty for "off" (disabled)', () => {
    expect(framesFor('off')).toEqual([]);
  });
});

describe('BRAILLE_ROTATE_FRAMES — circular ordering', () => {
  it('starts at `_` rest and walks 6 dot positions clockwise', () => {
    // Frame 0 = `_`, then top-left → top-right → mid-right → bot-right
    // → bot-left → mid-left → loop back to `_`.
    expect(BRAILLE_ROTATE_FRAMES[0]).toBe('_');
    expect(BRAILLE_ROTATE_FRAMES[1]).toBe('⠁'); // top-left
    expect(BRAILLE_ROTATE_FRAMES[2]).toBe('⠈'); // top-right
    expect(BRAILLE_ROTATE_FRAMES[3]).toBe('⠐'); // mid-right
    expect(BRAILLE_ROTATE_FRAMES[4]).toBe('⠠'); // bot-right
    expect(BRAILLE_ROTATE_FRAMES[5]).toBe('⠄'); // bot-left
    expect(BRAILLE_ROTATE_FRAMES[6]).toBe('⠂'); // mid-left
  });
  it('every position is a single-dot braille codepoint (one of U+2801..U+2820)', () => {
    const singleDotMask = (cp: number): boolean => {
      // Braille pattern dots block: U+2800 + bitmask of 8 dots.
      const bits = cp - 0x2800;
      if (bits < 0 || bits > 0xFF) return false;
      // popcount: single dot = exactly one bit set.
      let n = bits; let c = 0;
      while (n) { c += n & 1; n >>= 1; }
      return c === 1;
    };
    for (let i = 1; i < BRAILLE_ROTATE_FRAMES.length; i++) {
      const cp = BRAILLE_ROTATE_FRAMES[i].codePointAt(0)!;
      expect(singleDotMask(cp), `frame ${i} (${BRAILLE_ROTATE_FRAMES[i]}) should be a single-dot braille char`).toBe(true);
    }
  });
});

describe('ALL_FRAME_CHARS — sanity', () => {
  it('contains every char from every sequence', () => {
    for (const c of BOUNCE_FRAMES) expect(ALL_FRAME_CHARS.has(c)).toBe(true);
    for (const c of DOT_WALK_FRAMES) expect(ALL_FRAME_CHARS.has(c)).toBe(true);
    for (const c of BRAILLE_ROTATE_FRAMES) expect(ALL_FRAME_CHARS.has(c)).toBe(true);
  });
  it('does NOT contain ordinary letters (so user text doesn\'t trip detection)', () => {
    for (const c of 'abcXYZ012') expect(ALL_FRAME_CHARS.has(c)).toBe(false);
  });
});

describe('BlankLoadingAnimator — start/stop lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('start is a no-op when mode is "off"', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'off', frameIntervalMs: 100 });
    a.start(1);
    expect(a.active).toBe(false);
    vi.advanceTimersByTime(500);
    expect(setTextCalls).toEqual([]);
  });

  it('start with mode "bounce" registers the slot but does NOT write on frame 0', () => {
    // Frame 0 is `_` — the slot already shows `_`. No write until first tick.
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: 100 });
    a.start(1);
    expect(a.active).toBe(true);
    expect(setTextCalls).toEqual([]);
  });

  it('first tick advances to frame 1 ("-") and writes the buffer', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: 100 });
    a.start(1);
    vi.advanceTimersByTime(100);
    expect(setTextCalls).toEqual(['volume -']);
  });

  it('subsequent ticks cycle through frames (palindrome)', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: 100 });
    a.start(1);
    vi.advanceTimersByTime(100);  // → frame 1 (-)
    vi.advanceTimersByTime(100);  // → frame 2 (‾)
    vi.advanceTimersByTime(100);  // → frame 3 (-)
    vi.advanceTimersByTime(100);  // → frame 0 (_)
    vi.advanceTimersByTime(100);  // → frame 1 (-)
    expect(setTextCalls).toEqual([
      'volume -',
      'volume ‾',
      'volume -',
      'volume _',
      'volume -',
    ]);
  });

  it('dot-walk produces its own progression', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'dot-walk', frameIntervalMs: 100 });
    a.start(1);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect(setTextCalls).toEqual([
      'volume .',
      'volume ·',
      'volume .',
    ]);
  });

  it('stop() snaps the slot back to `_` and halts ticking', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: 100 });
    a.start(1);
    vi.advanceTimersByTime(100);   // → 'volume -'
    a.stop(1);
    expect(setTextCalls).toEqual(['volume -', 'volume _']);  // restored
    expect(a.active).toBe(false);
    vi.advanceTimersByTime(500);   // no further ticks
    expect(setTextCalls).toEqual(['volume -', 'volume _']);
  });

  it('stop() is a no-op if the slot is already on `_`', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: 100 });
    a.start(1);
    a.stop(1);                     // before any tick fires → slot still `_`
    expect(setTextCalls).toEqual([]);
  });

  it('stop() preserves user content when the slot is no longer one of our frame chars', () => {
    // User typed over the animating slot — animator must NOT clobber.
    const { adapter, setTextCalls, setBufferDirect } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: 100 });
    a.start(1);
    setBufferDirect('volume hello');  // user wiped the `_` and typed
    a.stop(1);
    expect(setTextCalls).toEqual([]);  // animator left the user's text alone
  });

  it('start() on an already-active wordIndex is idempotent', () => {
    const { adapter } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: 100 });
    a.start(1);
    a.start(1);
    expect(a.activeSlots.size).toBe(1);
  });

  it('multiple slots animate independently with a single shared timer', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _ brightness _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: 100 });
    a.start(1);
    a.start(3);
    vi.advanceTimersByTime(100);
    // Both slots advance on the same tick. Order is insertion order.
    // First swap: volume slot (index 1) → "-". Second swap: brightness slot (index 3) → "-".
    expect(setTextCalls).toEqual([
      'volume - brightness _',
      'volume - brightness -',
    ]);
  });

  it('user typing over the slot mid-animation drops the slot silently', () => {
    const { adapter, setTextCalls, setBufferDirect } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: 100 });
    a.start(1);
    vi.advanceTimersByTime(100);   // → 'volume -'
    setBufferDirect('volume X');   // user types over the loading char
    vi.advanceTimersByTime(100);   // next tick: detect `X` not in frame set → drop quietly
    expect(setTextCalls).toEqual(['volume -']);
    expect(a.active).toBe(false);
  });

  it('stopAll() drops every active slot', () => {
    const { adapter } = makeAdapter('volume _ brightness _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: 100 });
    a.start(1);
    a.start(3);
    expect(a.active).toBe(true);
    a.stopAll();
    expect(a.active).toBe(false);
  });

  it('mode is read lazily — switching mode between start() calls works', () => {
    let mode: 'bounce' | 'dot-walk' = 'bounce';
    const { adapter, setTextCalls } = makeAdapter('a _ b _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => mode, frameIntervalMs: 100 });
    a.start(1);
    vi.advanceTimersByTime(100);   // bounce: → '-'
    expect(setTextCalls.at(-1)).toBe('a - b _');
    mode = 'dot-walk';
    a.start(3);
    vi.advanceTimersByTime(100);
    // Slot 1 keeps bouncing (it was created with bounce frames).
    // Slot 3 advances on dot-walk.
    expect(setTextCalls.at(-1)).toContain('b .');
  });

  it('frameIntervalMs default is 150 when not provided', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce' });
    a.start(1);
    vi.advanceTimersByTime(149);
    expect(setTextCalls).toEqual([]);   // not yet
    vi.advanceTimersByTime(1);
    expect(setTextCalls).toEqual(['volume -']);
  });

  it('handles disappearing slot (text shrank, wordIndex out of bounds)', () => {
    const { adapter, setTextCalls, setBufferDirect } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: 100 });
    a.start(1);
    setBufferDirect('');           // user wiped the whole buffer
    vi.advanceTimersByTime(100);   // tick → can't find wordIndex 1 → drop quietly
    expect(setTextCalls).toEqual([]);
    expect(a.active).toBe(false);
  });
});
