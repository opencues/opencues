import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  BlankLoadingAnimator,
  framesFor,
  loopStartIdxFor,
  parseCustomFrames,
  parseRgbColors,
  parseAnsiColors,
  parseFrameIntervalMs,
  FRAME_INTERVAL_DEFAULT_MS,
  FRAME_INTERVAL_MIN_MS,
  FRAME_INTERVAL_MAX_MS,
  DEFAULT_RGB_PALETTE,
  DEFAULT_ANSI_PALETTE,
  BOUNCE_FRAMES,
  BRAILLE_ROTATE_FRAMES,
  FLIPPER_FRAMES,
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
  it('returns BRAILLE_ROTATE_FRAMES for "braille-rotate"', () => {
    expect(framesFor('braille-rotate')).toEqual(['_', '⠁', '⠈', '⠐', '⠠', '⠄', '⠂']);
    expect(framesFor('braille-rotate')).toBe(BRAILLE_ROTATE_FRAMES);
  });
  it('returns FLIPPER_FRAMES for "flipper"', () => {
    expect(framesFor('flipper')).toEqual(['_', '\\', '|', '/']);
    expect(framesFor('flipper')).toBe(FLIPPER_FRAMES);
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
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'off', frameIntervalMs: () => 100 });
    a.start(1);
    expect(a.active).toBe(false);
    vi.advanceTimersByTime(500);
    expect(setTextCalls).toEqual([]);
  });

  it('start with mode "bounce" registers the slot but does NOT write on frame 0', () => {
    // Frame 0 is `_` — the slot already shows `_`. No write until first tick.
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1);
    expect(a.active).toBe(true);
    expect(setTextCalls).toEqual([]);
  });

  it('first tick advances to frame 1 ("-") and writes the buffer', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1);
    vi.advanceTimersByTime(100);
    expect(setTextCalls).toEqual(['volume -']);
  });

  it('subsequent ticks cycle through frames (palindrome)', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
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

  it('braille-rotate: intro `_` plays once then loops the 6 dot positions, never returning to `_`', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'braille-rotate', frameIntervalMs: () => 100 });
    a.start(1);
    // Frames are: ['_', '⠁', '⠈', '⠐', '⠠', '⠄', '⠂']
    // loopStartIdx = 1, so after frame 6 (⠂), the next wraps to frame 1 (⠁) — NOT 0.
    for (let i = 0; i < 8; i++) vi.advanceTimersByTime(100);
    expect(setTextCalls).toEqual([
      'volume ⠁',  // tick 1: enter rotation
      'volume ⠈',  // tick 2
      'volume ⠐',  // tick 3
      'volume ⠠',  // tick 4
      'volume ⠄',  // tick 5
      'volume ⠂',  // tick 6
      'volume ⠁',  // tick 7: wrap to loopStartIdx=1, NOT back to `_`
      'volume ⠈',  // tick 8
    ]);
    // Confirm: `_` only appears as the initial slot state, never re-written.
    expect(setTextCalls.filter(s => s.endsWith(' _'))).toHaveLength(0);
  });

  it('bounce: full loop INCLUDES `_` on every cycle (loopStartIdx === 0)', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1);
    for (let i = 0; i < 6; i++) vi.advanceTimersByTime(100);
    expect(setTextCalls).toEqual([
      'volume -',  // tick 1
      'volume ‾',  // tick 2
      'volume -',  // tick 3
      'volume _',  // tick 4: full-loop wraps to 0, returning to `_`
      'volume -',  // tick 5
      'volume ‾',  // tick 6
    ]);
  });

  it('flipper: full loop returns to `_` every 4 frames (loopStartIdx === 0)', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'flipper', frameIntervalMs: () => 100 });
    a.start(1);
    for (let i = 0; i < 5; i++) vi.advanceTimersByTime(100);
    expect(setTextCalls).toEqual([
      'volume \\',  // tick 1
      'volume |',   // tick 2
      'volume /',   // tick 3
      'volume _',   // tick 4: full-loop wraps to 0
      'volume \\',  // tick 5
    ]);
  });

  it('loopStartIdxFor: bounce=0, braille-rotate=1, flipper=0, off=0', () => {
    expect(loopStartIdxFor('bounce')).toBe(0);
    expect(loopStartIdxFor('braille-rotate')).toBe(1);
    expect(loopStartIdxFor('flipper')).toBe(0);
    expect(loopStartIdxFor('off')).toBe(0);
  });

  it('stop() snaps the slot back to `_` and halts ticking', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
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
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1);
    a.stop(1);                     // before any tick fires → slot still `_`
    expect(setTextCalls).toEqual([]);
  });

  it('stop() preserves user content when the slot is no longer one of our frame chars', () => {
    // User typed over the animating slot — animator must NOT clobber.
    const { adapter, setTextCalls, setBufferDirect } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1);
    setBufferDirect('volume hello');  // user wiped the `_` and typed
    a.stop(1);
    expect(setTextCalls).toEqual([]);  // animator left the user's text alone
  });

  it('start() on an already-active wordIndex is idempotent', () => {
    const { adapter } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1);
    a.start(1);
    expect(a.activeSlots.size).toBe(1);
  });

  it('multiple slots animate independently with a single shared timer', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _ brightness _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
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
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1);
    vi.advanceTimersByTime(100);   // → 'volume -'
    setBufferDirect('volume X');   // user types over the loading char
    vi.advanceTimersByTime(100);   // next tick: detect `X` not in frame set → drop quietly
    expect(setTextCalls).toEqual(['volume -']);
    expect(a.active).toBe(false);
  });

  it('stopAll() drops every active slot', () => {
    const { adapter } = makeAdapter('volume _ brightness _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1);
    a.start(3);
    expect(a.active).toBe(true);
    a.stopAll();
    expect(a.active).toBe(false);
  });

  it('mode is read lazily — switching mode between start() calls works', () => {
    let mode: 'bounce' | 'braille-rotate' = 'bounce';
    const { adapter, setTextCalls } = makeAdapter('a _ b _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => mode, frameIntervalMs: () => 100 });
    a.start(1);
    vi.advanceTimersByTime(100);   // bounce: → '-'
    expect(setTextCalls.at(-1)).toBe('a - b _');
    mode = 'braille-rotate';
    a.start(3);
    vi.advanceTimersByTime(100);
    // Slot 1 keeps bouncing (it was created with bounce frames).
    // Slot 3 advances on braille-rotate.
    expect(setTextCalls.at(-1)).toContain('b ⠁');
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
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1);
    setBufferDirect('');           // user wiped the whole buffer
    vi.advanceTimersByTime(100);   // tick → can't find wordIndex 1 → drop quietly
    expect(setTextCalls).toEqual([]);
    expect(a.active).toBe(false);
  });
});

describe('BlankLoadingAnimator — owner refcount', () => {
  // The scenario this guards: BlankFill animates a keyword-bound `_`
  // (stocks, weather, volume) for the full duration of its async
  // fetch (~200-500ms). The Resolver ALSO starts animation on every
  // `_` slot and stops them when its own pipeline returns — which is
  // ~1ms when no resolver-side source claims the slot. Without the
  // refcount the resolver's stop killed BlankFill's animation before
  // the first frame (150ms tick) ever painted.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('two owners on the same slot: stop from one keeps animation alive', () => {
    const { adapter, setTextCalls } = makeAdapter('nvda stock _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(2, 'blank-fill');
    a.start(2, 'resolver');
    expect(a.active).toBe(true);
    // Resolver's fast stop — animation should KEEP going (blank-fill
    // still owns the slot).
    a.stop(2, 'resolver');
    expect(a.active).toBe(true);
    vi.advanceTimersByTime(100);
    expect(setTextCalls).toEqual(['nvda stock -']);   // tick happened
    vi.advanceTimersByTime(100);
    expect(setTextCalls).toEqual(['nvda stock -', 'nvda stock ‾']);
    // blank-fill's fetch returns and releases its claim → finally stops.
    a.stop(2, 'blank-fill');
    expect(a.active).toBe(false);
    expect(setTextCalls.at(-1)).toBe('nvda stock _');  // restored
  });

  it('symmetric: blank-fill stops first, resolver still animates', () => {
    const { adapter, setTextCalls } = makeAdapter('foo _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1, 'blank-fill');
    a.start(1, 'resolver');
    a.stop(1, 'blank-fill');
    expect(a.active).toBe(true);
    vi.advanceTimersByTime(100);
    expect(setTextCalls).toEqual(['foo -']);
    a.stop(1, 'resolver');
    expect(a.active).toBe(false);
  });

  it('same owner double-start is a no-op', () => {
    const { adapter } = makeAdapter('foo _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1, 'blank-fill');
    a.start(1, 'blank-fill');
    a.stop(1, 'blank-fill');
    // One stop matches both starts (idempotent for same owner).
    expect(a.active).toBe(false);
  });

  it('stop with unknown owner is a no-op', () => {
    const { adapter } = makeAdapter('foo _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1, 'blank-fill');
    a.stop(1, 'resolver');     // resolver never started this slot
    expect(a.active).toBe(true);
    a.stop(1, 'blank-fill');
    expect(a.active).toBe(false);
  });

  it('default owner used when none supplied (back-compat)', () => {
    const { adapter, setTextCalls } = makeAdapter('foo _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1);
    a.stop(1);
    expect(a.active).toBe(false);
    expect(setTextCalls).toEqual([]);  // never ticked before stop
  });

  it('stopAll(owner) only drops that owner\'s claims', () => {
    const { adapter } = makeAdapter('a _ b _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1, 'resolver');
    a.start(1, 'blank-fill');
    a.start(3, 'resolver');           // only resolver on this slot
    a.stopAll('resolver');
    // Slot 1 still has blank-fill; slot 3 had only resolver → dropped.
    expect(a.active).toBe(true);
    expect(a.activeSlots.has(1)).toBe(true);
    expect(a.activeSlots.has(3)).toBe(false);
    a.stop(1, 'blank-fill');
    expect(a.active).toBe(false);
  });

  it('stopAll() (no owner) hard-drops every slot regardless of owners', () => {
    const { adapter } = makeAdapter('a _ b _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce', frameIntervalMs: () => 100 });
    a.start(1, 'resolver');
    a.start(1, 'blank-fill');
    a.start(3, 'blank-fill');
    a.stopAll();
    expect(a.active).toBe(false);
  });
});

describe('parseCustomFrames', () => {
  it('returns null for empty input', () => {
    expect(parseCustomFrames(undefined)).toBeNull();
    expect(parseCustomFrames('')).toBeNull();
    expect(parseCustomFrames('   ')).toBeNull();
  });

  it('parses comma-separated frames, trims whitespace', () => {
    expect(parseCustomFrames('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseCustomFrames(' a , b , c ')).toEqual(['a', 'b', 'c']);
  });

  it('drops empty entries in the middle', () => {
    // "a,,b" — user wrote three commas thinking they had three frames;
    // the empty middle item gets dropped, two frames survive.
    expect(parseCustomFrames('a,,b')).toEqual(['a', 'b']);
  });

  it('caps at CUSTOM_FRAMES_MAX (5)', () => {
    expect(parseCustomFrames('1,2,3,4,5,6,7')).toEqual(['1', '2', '3', '4', '5']);
  });

  it('returns null when every item is empty after trim', () => {
    expect(parseCustomFrames(',,,,')).toBeNull();
    expect(parseCustomFrames(' , , ')).toBeNull();
  });

  it('allows multi-character frames (dot-walk style)', () => {
    expect(parseCustomFrames('.,..,...,....,.....')).toEqual(['.', '..', '...', '....', '.....']);
  });
});

describe('custom mode', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('uses the supplied frames when valid', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter,
      mode: () => 'custom',
      customFrames: () => ['◐', '◓', '◑', '◒'],
      frameIntervalMs: () => 100,
    });
    a.start(1);
    vi.advanceTimersByTime(100);
    expect(setTextCalls.at(-1)).toBe('volume ◓');
    vi.advanceTimersByTime(100);
    expect(setTextCalls.at(-1)).toBe('volume ◑');
    vi.advanceTimersByTime(100);
    expect(setTextCalls.at(-1)).toBe('volume ◒');
    vi.advanceTimersByTime(100);
    // Wraps to frame 0 (no intro for custom).
    expect(setTextCalls.at(-1)).toBe('volume ◐');
  });

  it('falls back to braille-rotate when customFrames returns null', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter,
      mode: () => 'custom',
      customFrames: () => null,
      frameIntervalMs: () => 100,
    });
    a.start(1);
    vi.advanceTimersByTime(100);
    // braille-rotate's first dot frame (intro `_` was the START frame).
    expect(setTextCalls.at(-1)).toBe('volume ⠁');
  });

  it('falls back to braille-rotate when customFrames returns empty array', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter,
      mode: () => 'custom',
      customFrames: () => [],
      frameIntervalMs: () => 100,
    });
    a.start(1);
    vi.advanceTimersByTime(100);
    expect(setTextCalls.at(-1)).toBe('volume ⠁');
  });

  it('falls back to braille-rotate when customFrames option is omitted entirely', () => {
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter,
      mode: () => 'custom',
      frameIntervalMs: () => 100,
    });
    a.start(1);
    vi.advanceTimersByTime(100);
    expect(setTextCalls.at(-1)).toBe('volume ⠁');
  });

  it('stop() restores `_` even for custom characters', () => {
    // The pre-fix ALL_FRAME_CHARS check refused to restore custom
    // chars because they weren't in the static set. Pin that
    // custom-char slots now restore correctly via per-slot frames.
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter,
      mode: () => 'custom',
      customFrames: () => ['X', 'Y'],
      frameIntervalMs: () => 100,
    });
    a.start(1);
    vi.advanceTimersByTime(100);   // → 'X' or 'Y'
    expect(setTextCalls.at(-1)).toMatch(/volume [XY]/);
    a.stop(1);
    expect(setTextCalls.at(-1)).toBe('volume _');
  });

  it('hot-flips when customFrames thunk return changes', () => {
    let frames: readonly string[] = ['A', 'B'];
    const { adapter, setTextCalls } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter,
      mode: () => 'custom',
      customFrames: () => frames,
      frameIntervalMs: () => 100,
    });
    a.start(1);
    vi.advanceTimersByTime(100);
    expect(setTextCalls.at(-1)).toBe('volume B');
    a.stop(1);
    // OPENCUES.md edited → new frames take effect on the NEXT start().
    frames = ['C', 'D', 'E'];
    a.start(1);
    vi.advanceTimersByTime(100);
    expect(setTextCalls.at(-1)).toBe('volume D');
  });
});

describe('parseRgbColors', () => {
  it('returns null for empty input', () => {
    expect(parseRgbColors(undefined)).toBeNull();
    expect(parseRgbColors('')).toBeNull();
    expect(parseRgbColors('   ')).toBeNull();
  });

  it('parses 6-digit hex', () => {
    expect(parseRgbColors('#ff5500,#00aaff'))
      .toEqual(['#ff5500', '#00aaff']);
  });

  it('parses 3-digit hex and expands to 6', () => {
    expect(parseRgbColors('#abc,#f00')).toEqual(['#aabbcc', '#ff0000']);
  });

  it('drops invalid tokens, keeps valid ones', () => {
    expect(parseRgbColors('#ff5500,not-a-colour,#00aaff'))
      .toEqual(['#ff5500', '#00aaff']);
  });

  it('returns null when no entries are valid', () => {
    expect(parseRgbColors('foo, bar, baz')).toBeNull();
  });

  it('rejects rgb() function syntax (use hex)', () => {
    // rgb()'s internal commas collide with the list-separator comma.
    expect(parseRgbColors('rgb(255,85,0)')).toBeNull();
  });

  it('caps at 5 colours', () => {
    expect(parseRgbColors('#000000,#111111,#222222,#333333,#444444,#555555'))
      .toEqual(['#000000', '#111111', '#222222', '#333333', '#444444']);
  });
});

describe('parseAnsiColors', () => {
  it('returns null for empty input', () => {
    expect(parseAnsiColors(undefined)).toBeNull();
    expect(parseAnsiColors('')).toBeNull();
  });

  it('parses named 8-colour set', () => {
    expect(parseAnsiColors('red,yellow,green,cyan,blue'))
      .toEqual(['red', 'yellow', 'green', 'cyan', 'blue']);
  });

  it('parses bright_ variants', () => {
    expect(parseAnsiColors('bright_red,bright_cyan'))
      .toEqual(['bright_red', 'bright_cyan']);
  });

  it('normalises gray/grey to bright_black', () => {
    expect(parseAnsiColors('gray,grey')).toEqual(['bright_black', 'bright_black']);
  });

  it('accepts 256-colour indices', () => {
    expect(parseAnsiColors('0,128,255,100')).toEqual(['0', '128', '255', '100']);
  });

  it('rejects indices > 255', () => {
    expect(parseAnsiColors('256,300')).toBeNull();
  });

  it('rejects unknown tokens, keeps valid ones', () => {
    expect(parseAnsiColors('red,puce,42,not-a-real-color'))
      .toEqual(['red', '42']);
  });

  it('caps at 5 colours', () => {
    expect(parseAnsiColors('red,green,blue,cyan,magenta,yellow,white'))
      .toEqual(['red', 'green', 'blue', 'cyan', 'magenta']);
  });
});

describe('getActiveColor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns null when slot is not animating', () => {
    const { adapter } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter, mode: () => 'bounce',
      rgbColors: () => ['#ff0000'],
      ansiColors: () => ['red'],
    });
    expect(a.getActiveColor(1, 'rgb')).toBeNull();
    expect(a.getActiveColor(1, 'ansi')).toBeNull();
  });

  it('returns null when colour list is empty/unset', () => {
    const { adapter } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({ adapter, mode: () => 'bounce' });
    a.start(1);
    expect(a.getActiveColor(1, 'rgb')).toBeNull();
    expect(a.getActiveColor(1, 'ansi')).toBeNull();
  });

  it('walks the colour list parallel to frames', () => {
    const { adapter } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter, mode: () => 'flipper', frameIntervalMs: () => 100,
      ansiColors: () => ['red', 'yellow', 'green', 'cyan'],
    });
    a.start(1);
    // Slot starts at frameIdx 0.
    expect(a.getActiveColor(1, 'ansi')).toBe('red');
    vi.advanceTimersByTime(100); // frameIdx → 1
    expect(a.getActiveColor(1, 'ansi')).toBe('yellow');
    vi.advanceTimersByTime(100); // frameIdx → 2
    expect(a.getActiveColor(1, 'ansi')).toBe('green');
    vi.advanceTimersByTime(100); // frameIdx → 3
    expect(a.getActiveColor(1, 'ansi')).toBe('cyan');
  });

  it('wraps around when fewer colours than frames', () => {
    const { adapter } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter, mode: () => 'flipper', frameIntervalMs: () => 100,
      ansiColors: () => ['red', 'green'],   // only 2 colours for 4 frames
    });
    a.start(1);
    expect(a.getActiveColor(1, 'ansi')).toBe('red');     // frame 0 % 2 = 0 → red
    vi.advanceTimersByTime(100);
    expect(a.getActiveColor(1, 'ansi')).toBe('green');   // frame 1 % 2 = 1 → green
    vi.advanceTimersByTime(100);
    expect(a.getActiveColor(1, 'ansi')).toBe('red');     // frame 2 % 2 = 0 → red
  });

  it('rgb and ansi paths are independent', () => {
    const { adapter } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter, mode: () => 'flipper',
      rgbColors: () => ['#ff0000', '#00ff00'],
      ansiColors: () => ['red', 'green'],
    });
    a.start(1);
    expect(a.getActiveColor(1, 'rgb')).toBe('#ff0000');
    expect(a.getActiveColor(1, 'ansi')).toBe('red');
  });
});

describe('parseFrameIntervalMs', () => {
  it('returns default for empty / undefined input', () => {
    expect(parseFrameIntervalMs(undefined)).toBe(FRAME_INTERVAL_DEFAULT_MS);
    expect(parseFrameIntervalMs('')).toBe(FRAME_INTERVAL_DEFAULT_MS);
  });

  it('parses the three preset values', () => {
    expect(parseFrameIntervalMs('75')).toBe(75);
    expect(parseFrameIntervalMs('150')).toBe(150);
    expect(parseFrameIntervalMs('300')).toBe(300);
  });

  it('accepts hand-edited values inside the clamp range', () => {
    expect(parseFrameIntervalMs('100')).toBe(100);
    expect(parseFrameIntervalMs('500')).toBe(500);
    expect(parseFrameIntervalMs(String(FRAME_INTERVAL_MIN_MS))).toBe(FRAME_INTERVAL_MIN_MS);
    expect(parseFrameIntervalMs(String(FRAME_INTERVAL_MAX_MS))).toBe(FRAME_INTERVAL_MAX_MS);
  });

  it('falls back to default for values outside the clamp range', () => {
    // Below min — flicker risk
    expect(parseFrameIntervalMs('10')).toBe(FRAME_INTERVAL_DEFAULT_MS);
    expect(parseFrameIntervalMs('0')).toBe(FRAME_INTERVAL_DEFAULT_MS);
    expect(parseFrameIntervalMs('-1')).toBe(FRAME_INTERVAL_DEFAULT_MS);
    // Above max — "is this stalled?" risk
    expect(parseFrameIntervalMs('5000')).toBe(FRAME_INTERVAL_DEFAULT_MS);
  });

  it('falls back to default for non-numeric input', () => {
    expect(parseFrameIntervalMs('off')).toBe(FRAME_INTERVAL_DEFAULT_MS);
    expect(parseFrameIntervalMs('nope')).toBe(FRAME_INTERVAL_DEFAULT_MS);
    expect(parseFrameIntervalMs('NaN')).toBe(FRAME_INTERVAL_DEFAULT_MS);
  });

  it('parseInt strips trailing units / whitespace', () => {
    // parseInt('150ms', 10) === 150 — friendly to users who type the unit.
    expect(parseFrameIntervalMs('150ms')).toBe(150);
    expect(parseFrameIntervalMs('  300  ')).toBe(300);
  });
});

describe('failover palettes', () => {
  it('DEFAULT_RGB_PALETTE has five hex entries (parallel to default frames)', () => {
    expect(DEFAULT_RGB_PALETTE).toHaveLength(5);
    for (const hex of DEFAULT_RGB_PALETTE) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('DEFAULT_ANSI_PALETTE has five named entries (parallel to default frames)', () => {
    expect(DEFAULT_ANSI_PALETTE).toHaveLength(5);
    expect(DEFAULT_ANSI_PALETTE).toEqual(['red', 'yellow', 'green', 'cyan', 'blue']);
  });

  it('animator with failover thunks renders the shipped palette when settings are empty', () => {
    const { adapter } = makeAdapter('volume _');
    // Mirror the caller-side ?? pattern used by boot-common / cc / blank-fill.
    const a = new BlankLoadingAnimator({
      adapter,
      mode: () => 'flipper',
      frameIntervalMs: () => 100,
      rgbColors: () => parseRgbColors(undefined) ?? DEFAULT_RGB_PALETTE,
      ansiColors: () => parseAnsiColors('') ?? DEFAULT_ANSI_PALETTE,
    });
    a.start(1);
    expect(a.getActiveColor(1, 'rgb')).toBe(DEFAULT_RGB_PALETTE[0]);
    expect(a.getActiveColor(1, 'ansi')).toBe(DEFAULT_ANSI_PALETTE[0]);
  });

  it('animator with failover thunks renders the shipped palette when input is all-invalid', () => {
    const { adapter } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter,
      mode: () => 'flipper',
      frameIntervalMs: () => 100,
      rgbColors: () => parseRgbColors('notahex,alsonope,##') ?? DEFAULT_RGB_PALETTE,
      ansiColors: () => parseAnsiColors('zzz,500') ?? DEFAULT_ANSI_PALETTE,
    });
    a.start(1);
    expect(a.getActiveColor(1, 'rgb')).toBe(DEFAULT_RGB_PALETTE[0]);
    expect(a.getActiveColor(1, 'ansi')).toBe(DEFAULT_ANSI_PALETTE[0]);
  });

  it('partially-valid input still overrides defaults (failover only on null/empty)', () => {
    const { adapter } = makeAdapter('volume _');
    const a = new BlankLoadingAnimator({
      adapter,
      mode: () => 'flipper',
      frameIntervalMs: () => 100,
      // One valid + one bogus → parser keeps the valid one, no failover.
      rgbColors: () => parseRgbColors('#ff00ff,notahex') ?? DEFAULT_RGB_PALETTE,
    });
    a.start(1);
    expect(a.getActiveColor(1, 'rgb')).toBe('#ff00ff');
    expect(a.getActiveColor(1, 'rgb')).not.toBe(DEFAULT_RGB_PALETTE[0]);
  });
});
