// Derive OpenCues highlight colours from the host page's computed
// styling, so we don't fight the base system:
//
//   - active = the contenteditable's own computed `color`. When the
//     editor's MutationObserver invalidates our active Range for one
//     frame mid-cycle, the underlying text shows the exact same colour
//     the highlight was painting — no flash.
//   - dim    = host text colour mixed toward the nearest opaque
//     background colour (default 45% toward background). Faded but
//     legible on both white-on-dark and dark-on-white pages, with no
//     hardcoded greys.
//
// Pure functions; no DOM mutation. The caller plumbs the returned
// colours through CSS custom properties on the target element.

export interface DerivedColours {
  active: string;
  dim: string;
  /** Active-pill background — host text colour at low opacity so it
   *  reads as a soft highlighter mark on both dark and light pages.
   *  Painted ON TOP of the page background, not mixed into a flat
   *  colour, so the visible tint adapts naturally to whatever's
   *  behind it. */
  activeBg: string;
}

interface RGBA { r: number; g: number; b: number; a: number; }

/** Parse a CSS rgb()/rgba() string into channels. Returns null on miss. */
export function parseRgb(value: string): RGBA | null {
  const m = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)/i);
  if (!m) return null;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  let a = 1;
  if (m[4] !== undefined) {
    const raw = m[4];
    a = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  }
  if ([r, g, b, a].some(Number.isNaN)) return null;
  return { r, g, b, a };
}

/** Mix two RGB colours; t=0 returns a, t=1 returns b. Alpha forced to 1. */
export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  const k = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(a.r * (1 - k) + b.r * k),
    g: Math.round(a.g * (1 - k) + b.g * k),
    b: Math.round(a.b * (1 - k) + b.b * k),
    a: 1,
  };
}

export function rgbToCss(c: RGBA): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

export function rgbaToCss(c: RGBA, alpha: number): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

/**
 * Walk up the DOM looking for the first ancestor (including el) whose
 * computed background-color is non-transparent. Falls back to white
 * when nothing opaque is found — matches the browser's default canvas
 * paint and gives sensible mixing on bare HTML pages.
 */
export function firstOpaqueBackground(el: Element): RGBA {
  let cur: Element | null = el;
  while (cur) {
    const bg = parseRgb(getComputedStyle(cur).backgroundColor);
    if (bg && bg.a > 0) return { ...bg, a: 1 };
    cur = cur.parentElement;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

/** Active-pill background opacity. Tuned so the tint reads as
 *  "highlighted" without overpowering the text colour:
 *  - 0.20-0.25 looks like a soft highlighter mark on light pages.
 *  - The same alpha on dark pages produces a softer brighter tint
 *    that still reads as selected. Adjust via popup if you want a
 *    more / less prominent pill.
 *  Higher alpha → more saturated pill (stronger "selected" feel).
 *  Lower alpha → subtler. */
const DEFAULT_ACTIVE_BG_ALPHA = 0.22;

/**
 * Derive OpenCues colours for a given target. `dimMix` controls how
 * far dim is pulled toward the background (0 = no fade, 1 = invisible).
 * 0.45 is the default — visibly faded but still legible on every
 * theme we've tested.
 */
export function deriveOpenCuesColours(
  target: Element,
  dimMix = 0.45,
  activeBgAlpha = DEFAULT_ACTIVE_BG_ALPHA,
): DerivedColours {
  const computed = getComputedStyle(target);
  const text = parseRgb(computed.color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const bg = firstOpaqueBackground(target);
  const dim = mix({ ...text, a: 1 }, bg, dimMix);
  return {
    active: rgbToCss({ ...text, a: 1 }),
    dim: rgbToCss(dim),
    activeBg: rgbaToCss({ ...text, a: 1 }, activeBgAlpha),
  };
}
