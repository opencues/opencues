// LoadingAnimationBlank — inline definition of the blank-loading
// animation. Deterministic parser + scalar upserts; these tests pin
// the grammar (parse), the write path (which scalars land, exact CSV
// values), the named-never-silent floors, and the show summary.

import { describe, it, expect } from 'vitest';
import { LoadingAnimationBlank, parse } from './loading-animation';
import {
  CUSTOM_FRAMES_MAX,
  FRAME_INTERVAL_MAX_MS,
  FRAME_INTERVAL_MIN_MS,
} from '../modules/blank-loading';

const BASE_MD = `---
voice-mode: active
blank-loading-animation: bounce
blank-loading-interval-ms: 150
---

body prose
`;

function makeBlank(initial: string = BASE_MD) {
  let content = initial;
  const writes: string[] = [];
  const blank = new LoadingAnimationBlank({
    readFile: async () => content,
    writeFile: async (c) => { writes.push(c); content = c; },
  });
  const scalar = (name: string): string | undefined => {
    const m = content.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'));
    return m ? m[1].trim() : undefined;
  };
  return { blank, writes, scalar, get content() { return content; } };
}

describe('parse — grammar classification', () => {
  it('frames CSV alone', () => {
    expect(parse(['_,-,‾,-'])).toEqual({
      preset: undefined, frames: ['_', '-', '‾', '-'], framesTruncated: undefined,
      colors: undefined, intervalMs: undefined, intervalClamped: undefined,
    });
  });

  it('single glyph without a comma is a one-frame list', () => {
    expect(parse(['★']).frames).toEqual(['★']);
  });

  it('colour CSV alone (names, indices, hex — mixed)', () => {
    expect(parse(['red,196,#22d3ee']).colors).toEqual(['red', '196', '#22d3ee']);
  });

  it('bare number is the interval, clamped and flagged', () => {
    expect(parse(['300'])).toMatchObject({ intervalMs: 300, intervalClamped: false });
    expect(parse(['5'])).toMatchObject({ intervalMs: FRAME_INTERVAL_MIN_MS, intervalClamped: true });
    expect(parse(['99999'])).toMatchObject({ intervalMs: FRAME_INTERVAL_MAX_MS, intervalClamped: true });
    expect(parse(['75ms'])).toMatchObject({ intervalMs: 75 });
  });

  it('frames + colours + interval, order-free', () => {
    const a = parse(['_,-,‾,-', 'red,orange', '75']);
    const b = parse(['75', 'red,orange', '_,-,‾,-']);
    expect(a).toEqual(b);
    expect(a.frames).toEqual(['_', '-', '‾', '-']);
    expect(a.colors).toEqual(['red', 'orange']);
    expect(a.intervalMs).toBe(75);
  });

  it('presets, incl. combined with interval/colours but never frames', () => {
    expect(parse(['bounce']).preset).toBe('bounce');
    expect(parse(['bounce', '75'])).toMatchObject({ preset: 'bounce', intervalMs: 75 });
    expect(parse(['flipper', 'red,blue']).colors).toEqual(['red', 'blue']);
    expect(parse(['bounce', '_,-']).error).toContain("can't be combined with a frame list");
  });

  it('show/status verdict; show mixed with tokens is an error', () => {
    expect(parse(['show'])).toEqual({ show: true });
    expect(parse(['status'])).toEqual({ show: true });
    expect(parse(['show', '75']).error).toContain("can't be combined");
  });

  it('frames beyond CUSTOM_FRAMES_MAX are truncated and counted', () => {
    const p = parse(['a,b,c,d,e,f,g,h']);
    expect(p.frames).toHaveLength(CUSTOM_FRAMES_MAX);
    expect(p.framesTruncated).toBe(8);
  });

  it('named errors: empty input, doubled lists, non-glyph token', () => {
    expect(parse([]).error).toContain('expected frames');
    expect(parse(['_,-', '‾,-']).error).toContain('two frame lists');
    expect(parse(['red,blue', 'green,cyan']).error).toContain('two colour lists');
    expect(parse(['300', '75']).error).toContain('two intervals');
    expect(parse(['definitely-not-a-frame']).error).toContain("doesn't look like a frame glyph");
  });

  it('everyday names (orange/purple/…) classify as colours — "red,orange,yellow" is the first thing anyone types', () => {
    expect(parse(['red,orange,yellow']).colors).toEqual(['red', 'orange', 'yellow']);
    // But a word outside every colour vocabulary still errs by name.
    expect(parse(['red,crimsonish']).error).toContain('"crimsonish"');
  });
});

describe('LoadingAnimationBlank — write path', () => {
  it('frames define writes frames CSV verbatim and flips animation to custom, in ONE write', async () => {
    const { blank, writes, scalar } = makeBlank();
    const out = await blank.get('loading animation', ['_,-,‾,-']);
    expect(out).toBe('[loading animation: custom · 4 frames]');
    expect(writes).toHaveLength(1);
    expect(scalar('blank-loading-frames')).toBe('_,-,‾,-');
    expect(scalar('blank-loading-animation')).toBe('custom');
  });

  it('one colour list feeds BOTH scalars: names → ansi + mapped hex; hex → rgb only; index → ansi only', async () => {
    const { blank, scalar } = makeBlank();
    await blank.get('loading animation', ['red,#22d3ee,196']);
    expect(scalar('blank-loading-colors-ansi')).toBe('red,196');
    const rgb = scalar('blank-loading-colors-rgb')!;
    expect(rgb).toContain('#22d3ee');
    expect(rgb.split(',')[0]).toMatch(/^#/); // red mapped to a hex
  });

  it('interval-only write', async () => {
    const { blank, scalar } = makeBlank();
    const out = await blank.get('loading animation', ['300']);
    expect(out).toBe('[loading animation: 300ms]');
    expect(scalar('blank-loading-interval-ms')).toBe('300');
    expect(scalar('blank-loading-animation')).toBe('bounce'); // untouched
  });

  it('preset write leaves frames/colours untouched', async () => {
    const { blank, scalar } = makeBlank(BASE_MD.replace('---\n\nbody', 'blank-loading-frames: a,b\n---\n\nbody'));
    await blank.get('loading animation', ['flipper']);
    expect(scalar('blank-loading-animation')).toBe('flipper');
    expect(scalar('blank-loading-frames')).toBe('a,b');
  });

  it('floors are named in the confirmation, never silent', async () => {
    const { blank } = makeBlank();
    const truncated = await blank.get('loading animation', ['a,b,c,d,e,f,g,h']);
    expect(truncated).toContain(`truncated to ${CUSTOM_FRAMES_MAX} frames (got 8)`);
    const clamped = await blank.get('loading animation', ['5']);
    expect(clamped).toContain('interval clamped');
    const extraColors = await blank.get('loading animation', ['_,-', 'red,green,blue']);
    expect(extraColors).toContain('1 colour(s) beyond the frame count are unused');
    const hexOnly = await blank.get('loading animation', ['#abc,#def']);
    expect(hexOnly).toContain('no ansi-capable colours');
  });

  it('errors are [err] feedback and write NOTHING', async () => {
    const { blank, writes } = makeBlank();
    const out = await blank.get('loading animation', ['definitely-not-a-frame']);
    expect(out).toMatch(/^\[err\] loading animation: /);
    expect(writes).toHaveLength(0);
  });

  it('missing OPENCUES.md is a named error, not a crash', async () => {
    const blank = new LoadingAnimationBlank({
      readFile: async () => null,
      writeFile: async () => { throw new Error('unreachable'); },
    });
    const out = await blank.get('loading animation', ['_,-']);
    expect(out).toContain('no OPENCUES.md found');
  });

  it('show summarises the live scalars', async () => {
    const { blank } = makeBlank(`---
blank-loading-animation: custom
blank-loading-frames: _,-,‾,-
blank-loading-colors-rgb: #ef4444,#f59e0b
blank-loading-interval-ms: 75
---
`);
    const out = await blank.get('loading animation', ['show']);
    expect(out).toBe('custom · frames _,-,‾,- · rgb #ef4444,#f59e0b · 75ms');
  });

  it('round-trip: what the blank writes, the animator parsers read back identically', async () => {
    const { blank, scalar } = makeBlank();
    await blank.get('loading animation', ['_,-,‾,-', 'red,yellow', '75']);
    const { parseCustomFrames, parseAnsiColors, parseRgbColors, parseFrameIntervalMs } =
      await import('../modules/blank-loading');
    expect(parseCustomFrames(scalar('blank-loading-frames'))).toEqual(['_', '-', '‾', '-']);
    expect(parseAnsiColors(scalar('blank-loading-colors-ansi'))).toEqual(['red', 'yellow']);
    expect(parseRgbColors(scalar('blank-loading-colors-rgb'))).toHaveLength(2);
    expect(parseFrameIntervalMs(scalar('blank-loading-interval-ms'))).toBe(75);
  });
});
