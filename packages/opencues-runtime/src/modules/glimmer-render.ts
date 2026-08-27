// GlimmerRender — display-only scramble-settle transition when a substituted
// answer lands (fluid-blank, transform-blank, keyword blank fills).
//
// The buffer commits INSTANTLY, exactly as before this module existed; only
// the PAINTED string animates. On `start()` the landed span first blinks
// (painted as blanks for GLIMMER_BLINK_MS), then churns through confusable
// glyphs at decreasing density over the configured window until it settles
// clean. The animation is delivered through `RenderDirectives.textOverride`
// from a render handler — the ONE directive channel that can change glyphs
// without touching the buffer — and each frame is driven by a bare
// `adapter.forceRender()`, which no band routes back into onTextChange. That
// keeps the frame loop invisible to the Resolver's dispatch, BlankFill's
// span invalidation, AgentRewrite's debounce, and ConfigLoader.maybeReload
// (all of which a setText-per-frame loop would poison — see the render-only
// analysis in docs/features/glimmer-transition.md).
//
// Hosts that don't consume `textOverride` in their paint path (opencode /
// shell extmark renderers, chrome's CSS-highlight renderer) degrade to the
// pre-feature instant swap: the handler's override is simply never painted,
// and the buffer already holds the final text. Claude Code applies overrides
// whole-string; Gemini slices a whole-buffer override per line — both safe
// because the override is ALWAYS the same length as the ctx text (blink and
// scramble are 1:1 char substitutions, newlines preserved).
//
// The scramble table + recipe are ported from the Glimmer extension
// prototype (experiments/roi-debug/lib/scramble.js), itself extracted from
// the artifact kit's wordmark scramble: a character only ever swaps within
// its own confusable group, so the churn reads as the text "decoding" rather
// than random noise.

import type { HostAdapter } from '../adapter';

/* The confusable groups — a letter only ever swaps within its own group;
 * the ART groups take precedence for symbols so `_` boils through `?#&_`,
 * not letters. Verbatim from the kit's one scramble table. */
const GROUPS = [",li.:|';jI`!", '[]()tf', 'r/\\{}"*1', '-szJkvxy7',
  'aLF?hnuec4T32o<>EP#869bdgpq0+^', 'ZY=$SBX~KR&VUAHD_', 'NwGCOQm', '@M%W'];
const ART = ['!', '?#&_', '@%'];
const POOL: Record<string, string> = {};
for (const g of ART.concat(GROUPS)) {
  for (const ch of g) if (!(ch in POOL)) POOL[ch] = g;
}
for (const g of GROUPS) {
  for (const ch of g) {
    if (POOL[ch].length < g.length && ART.indexOf(POOL[ch]) < 0) POOL[ch] = g;
  }
}

/** One scrambled variant of `text` — pure, length-preserving. Characters
 *  outside every group (whitespace, newlines, CJK, emoji) pass through
 *  untouched, which is what keeps the override safe to splice 1:1 over
 *  multi-line spans. */
export function scrambleText(text: string, density: number, rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const g = POOL[c];
    if (g && g.length > 1 && rand() < density) {
      let r = c;
      do { r = g[Math.floor(rand() * g.length)]; } while (r === c);
      out += r;
    } else out += c;
  }
  return out;
}

/** mulberry32 — deterministic PRNG for tests / repeatable runs. */
export function glimmerStream(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Frame cadence — the kit's churn rhythm. */
export const GLIMMER_FRAME_MS = 70;
/** Blink lead-in: the landed span paints as blanks for this long before the
 *  scramble starts — the "blinker blinks, then the transition happens". */
export const GLIMMER_BLINK_MS = 140;

/** Parse the `glimmer-transition-ms` scalar. Registry default (`300`) when
 *  absent or unrecognised; `off` (or `0`) disables — 0 means no animation. */
export function parseGlimmerTransitionMs(raw: string | undefined): number {
  if (raw === undefined) return 300;
  const t = raw.trim().toLowerCase();
  if (t === 'off' || t === '0') return 0;
  if (t === '300' || t === '600' || t === '900') return parseInt(t, 10);
  return 300;
}

/** The blink frame: every glyph blanked, newlines preserved (length 1:1). */
function blankOut(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += text[i] === '\n' ? '\n' : ' ';
  return out;
}

interface ActiveGlimmer {
  /** Logical offset where `finalText` landed in the committed buffer. */
  start: number;
  finalText: string;
  /** The cached per-tick display slice — recomputed by the timer, spliced
   *  by getTextOverride. Caching per tick (not per render) keeps extra
   *  host repaints between ticks from churning faster than the cadence. */
  frameText: string;
  startedAt: number;
  durationMs: number;
}

export interface GlimmerRenderOptions {
  adapter: HostAdapter;
  /** Lazy thunk over the `glimmer-transition-ms` scalar — re-read on every
   *  start() so OPENCUES.md edits hot-reload without a restart. <= 0 = off. */
  durationMs: () => number;
  /** Test seam / determinism hook: PRNG used for every scramble frame. */
  rand?: () => number;
  log?: (msg: string) => void;
}

/**
 * One active transition at a time (a second `start()` replaces the first —
 * substitutions are user-paced, overlap is a re-summon). Render-only by
 * construction: this class never calls setText/pushText.
 */
export class GlimmerRender {
  private _active: ActiveGlimmer | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: GlimmerRenderOptions) {}

  /** Begin the transition over `finalText`, which the caller just committed
   *  at `startOffset`. No-op when the scalar is off or the span is blank. */
  start(startOffset: number, finalText: string): void {
    const durationMs = this.opts.durationMs();
    if (durationMs <= 0) return;
    if (!finalText || finalText.trim().length === 0) return;
    this.cancel(false);
    this._active = {
      start: Math.max(0, startOffset),
      finalText,
      frameText: blankOut(finalText),
      startedAt: Date.now(),
      durationMs,
    };
    this._timer = setInterval(() => this._tick(), GLIMMER_FRAME_MS);
    this.opts.log?.(`glimmer: start (len=${finalText.length}, ms=${durationMs})`);
    this._repaint();
  }

  /** True while a transition is painting. */
  get active(): boolean {
    return this._active !== null;
  }

  cancel(repaint: boolean): void {
    if (this._timer !== null) { clearInterval(this._timer); this._timer = null; }
    if (this._active === null) return;
    this._active = null;
    if (repaint) this._repaint();
  }

  /**
   * Render-handler hook: the full display string for this frame, or null
   * when idle / settled / the buffer has moved on. `ctxText` is the host's
   * plain visible text — the override returned is ALWAYS the same length.
   */
  getTextOverride(ctxText: string): string | null {
    const a = this._active;
    if (a === null) return null;
    // Locate the landed span. Exact position first; tolerate small offset
    // drift (ZWS strips, host indent) by searching near the expected spot.
    let at = ctxText.startsWith(a.finalText, a.start)
      ? a.start
      : ctxText.indexOf(a.finalText, Math.max(0, a.start - 16));
    if (at < 0) at = ctxText.indexOf(a.finalText);
    if (at < 0) {
      // The span is gone — the user edited it or another module rewrote the
      // buffer. Stop silently: the buffer is the truth, never fight it.
      this.cancel(false);
      return null;
    }
    if (a.frameText === a.finalText) return null;
    return ctxText.slice(0, at) + a.frameText + ctxText.slice(at + a.finalText.length);
  }

  private _tick(): void {
    const a = this._active;
    if (a === null) { this.cancel(false); return; }
    const elapsed = Date.now() - a.startedAt;
    if (elapsed >= GLIMMER_BLINK_MS + a.durationMs) {
      // Settled — clear state, then one last repaint so the clean final
      // text lands on screen without waiting for the next host render.
      this.cancel(true);
      return;
    }
    if (elapsed < GLIMMER_BLINK_MS) {
      a.frameText = blankOut(a.finalText);
    } else {
      // Churn → ease: full density for the first 55% of the window, then
      // two easing steps — the kit's settle recipe compressed to fit any
      // of the three configurable durations.
      const p = (elapsed - GLIMMER_BLINK_MS) / a.durationMs;
      const density = p < 0.55 ? 0.45 : p < 0.75 ? 0.3 : 0.15;
      a.frameText = scrambleText(a.finalText, density, this.opts.rand ?? Math.random);
    }
    this._repaint();
  }

  private _repaint(): void {
    try { this.opts.adapter.forceRender?.(); } catch { /* host mid-teardown */ }
  }

  dispose(): void {
    this.cancel(false);
  }
}
