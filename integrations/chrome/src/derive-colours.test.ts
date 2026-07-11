// Tests for derive-colours.ts — pure colour-derivation math + the
// computed-style-driven deriveOpenCuesColours/firstOpaqueBackground pair.

import { describe, it, expect } from 'vitest';
import {
  parseRgb,
  mix,
  rgbToCss,
  rgbaToCss,
  firstOpaqueBackground,
  deriveOpenCuesColours,
} from './derive-colours';

describe('parseRgb — happy path', () => {
  it('parses rgb() with spaces', () => {
    expect(parseRgb('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });

  it('parses rgba() with a decimal alpha', () => {
    expect(parseRgb('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  });

  it('parses rgba() with a percentage alpha', () => {
    expect(parseRgb('rgba(10, 20, 30, 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  });

  it('parses rgb() with slash-separated alpha (modern CSS syntax)', () => {
    expect(parseRgb('rgb(10 20 30 / 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  });
});

describe('parseRgb — edge cases', () => {
  it('parses pure black', () => {
    expect(parseRgb('rgb(0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('parses pure white', () => {
    expect(parseRgb('rgb(255, 255, 255)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('parses fully transparent', () => {
    expect(parseRgb('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('parses decimal channel values (browsers can emit these for filters/blends)', () => {
    expect(parseRgb('rgb(10.5, 20.2, 30.9)')).toEqual({ r: 10.5, g: 20.2, b: 30.9, a: 1 });
  });

  it('is case-insensitive on the RGB/RGBA function name', () => {
    expect(parseRgb('RGB(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseRgb('RGBA(1, 2, 3, 1)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  });
});

describe('parseRgb — invalid input', () => {
  it('returns null for an empty string', () => {
    expect(parseRgb('')).toBeNull();
  });

  it('returns null for a non-color string', () => {
    expect(parseRgb('transparent')).toBeNull();
  });

  it('returns null for a hex color (not rgb/rgba syntax)', () => {
    expect(parseRgb('#ff0000')).toBeNull();
  });

  it('returns null for hsl() syntax', () => {
    expect(parseRgb('hsl(0, 100%, 50%)')).toBeNull();
  });

  it('returns null for malformed rgb() missing a channel', () => {
    expect(parseRgb('rgb(10, 20)')).toBeNull();
  });

  it('returns null when a channel is non-numeric garbage', () => {
    expect(parseRgb('rgb(a, b, c)')).toBeNull();
  });
});

describe('mix', () => {
  it('t=0 returns the first colour unchanged (alpha forced to 1)', () => {
    expect(mix({ r: 10, g: 20, b: 30, a: 0.4 }, { r: 100, g: 100, b: 100, a: 1 }, 0))
      .toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });

  it('t=1 returns the second colour', () => {
    expect(mix({ r: 10, g: 20, b: 30, a: 1 }, { r: 100, g: 200, b: 250, a: 1 }, 1))
      .toEqual({ r: 100, g: 200, b: 250, a: 1 });
  });

  it('t=0.5 averages the two colours (rounded)', () => {
    expect(mix({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }, 0.5))
      .toEqual({ r: 128, g: 128, b: 128, a: 1 });
  });

  it('clamps t below 0 to 0', () => {
    expect(mix({ r: 10, g: 10, b: 10, a: 1 }, { r: 200, g: 200, b: 200, a: 1 }, -5))
      .toEqual({ r: 10, g: 10, b: 10, a: 1 });
  });

  it('clamps t above 1 to 1', () => {
    expect(mix({ r: 10, g: 10, b: 10, a: 1 }, { r: 200, g: 200, b: 200, a: 1 }, 5))
      .toEqual({ r: 200, g: 200, b: 200, a: 1 });
  });
});

describe('rgbToCss / rgbaToCss', () => {
  it('rgbToCss formats an rgb() string', () => {
    expect(rgbToCss({ r: 1, g: 2, b: 3, a: 1 })).toBe('rgb(1, 2, 3)');
  });

  it('rgbaToCss formats an rgba() string with the given alpha, ignoring the input a field', () => {
    expect(rgbaToCss({ r: 1, g: 2, b: 3, a: 0.9 }, 0.22)).toBe('rgba(1, 2, 3, 0.22)');
  });
});

describe('firstOpaqueBackground', () => {
  it('finds an opaque background on the element itself', () => {
    const el = document.createElement('div');
    el.style.backgroundColor = 'rgb(50, 60, 70)';
    document.body.appendChild(el);
    expect(firstOpaqueBackground(el)).toEqual({ r: 50, g: 60, b: 70, a: 1 });
    el.remove();
  });

  it('walks up to the parent when the element itself is transparent', () => {
    const parent = document.createElement('div');
    parent.style.backgroundColor = 'rgb(9, 9, 9)';
    const child = document.createElement('span');
    parent.appendChild(child);
    document.body.appendChild(parent);
    expect(firstOpaqueBackground(child)).toEqual({ r: 9, g: 9, b: 9, a: 1 });
    parent.remove();
  });

  it('falls back to white when no ancestor has an opaque background', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(firstOpaqueBackground(el)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    el.remove();
  });
});

describe('deriveOpenCuesColours — happy path', () => {
  it('derives active/dim/activeBg from a black-text-on-white-bg target', () => {
    const el = document.createElement('div');
    el.style.color = 'rgb(0, 0, 0)';
    el.style.backgroundColor = 'rgb(255, 255, 255)';
    document.body.appendChild(el);

    const colours = deriveOpenCuesColours(el);
    expect(colours.active).toBe('rgb(0, 0, 0)');
    // dim = black mixed 45% toward white = rgb(115, 115, 115) rounded
    expect(colours.dim).toBe('rgb(115, 115, 115)');
    expect(colours.activeBg).toBe('rgba(0, 0, 0, 0.22)');
    el.remove();
  });
});

describe('deriveOpenCuesColours — edge cases', () => {
  it('pure black text on pure black background: dim === active (no visible fade)', () => {
    const el = document.createElement('div');
    el.style.color = 'rgb(0, 0, 0)';
    el.style.backgroundColor = 'rgb(0, 0, 0)';
    document.body.appendChild(el);

    const colours = deriveOpenCuesColours(el);
    expect(colours.active).toBe('rgb(0, 0, 0)');
    expect(colours.dim).toBe('rgb(0, 0, 0)');
    el.remove();
  });

  it('pure white text on pure white background: dim === active', () => {
    const el = document.createElement('div');
    el.style.color = 'rgb(255, 255, 255)';
    el.style.backgroundColor = 'rgb(255, 255, 255)';
    document.body.appendChild(el);

    const colours = deriveOpenCuesColours(el);
    expect(colours.dim).toBe('rgb(255, 255, 255)');
    el.remove();
  });

  it('dimMix=0 returns dim identical to active (no fade requested)', () => {
    const el = document.createElement('div');
    el.style.color = 'rgb(10, 20, 30)';
    el.style.backgroundColor = 'rgb(200, 200, 200)';
    document.body.appendChild(el);

    const colours = deriveOpenCuesColours(el, 0);
    expect(colours.dim).toBe(colours.active);
    el.remove();
  });

  it('dimMix=1 returns dim identical to the background colour', () => {
    const el = document.createElement('div');
    el.style.color = 'rgb(10, 20, 30)';
    el.style.backgroundColor = 'rgb(200, 200, 200)';
    document.body.appendChild(el);

    const colours = deriveOpenCuesColours(el, 1);
    expect(colours.dim).toBe('rgb(200, 200, 200)');
    el.remove();
  });

  it('out-of-range dimMix (negative / >1) is clamped by mix()', () => {
    const el = document.createElement('div');
    el.style.color = 'rgb(10, 20, 30)';
    el.style.backgroundColor = 'rgb(200, 200, 200)';
    document.body.appendChild(el);

    const negative = deriveOpenCuesColours(el, -5);
    const over = deriveOpenCuesColours(el, 5);
    expect(negative.dim).toBe(negative.active);
    expect(over.dim).toBe('rgb(200, 200, 200)');
    el.remove();
  });

  it('custom activeBgAlpha is reflected verbatim in activeBg', () => {
    const el = document.createElement('div');
    el.style.color = 'rgb(1, 2, 3)';
    document.body.appendChild(el);

    const colours = deriveOpenCuesColours(el, 0.45, 0.9);
    expect(colours.activeBg).toBe('rgba(1, 2, 3, 0.9)');
    el.remove();
  });
});

describe('deriveOpenCuesColours — invalid input', () => {
  it('falls back to black text when computed color is unparsable', () => {
    const el = document.createElement('div');
    // jsdom's getComputedStyle returns '' for unset color on a detached
    // style — force an invalid value to exercise the ?? fallback path.
    Object.defineProperty(el.style, 'color', { value: 'not-a-color', writable: true });
    document.body.appendChild(el);

    const colours = deriveOpenCuesColours(el);
    // Falls back to { r:0, g:0, b:0, a:1 } per the `?? { r: 0, g: 0, b: 0, a: 1 }` guard.
    expect(colours.active).toBe('rgb(0, 0, 0)');
    el.remove();
  });
});
