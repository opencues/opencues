// GlimmerRender — scramble-settle transition when a substituted answer
// lands (fluid-blank, transform-blank, keyword blank fills).
//
// TWO delivery modes; in BOTH the buffer commits INSTANTLY and never
// holds a scrambled frame — the animation is pure display:
//
// RENDER-ONLY (Claude Code, Gemini CLI, OpenCode, shell): only the
// PAINTED string animates, via `RenderDirectives.textOverride` from a
// render handler, driven by bare `adapter.forceRender()` calls that no
// band routes back into onTextChange. CC applies the override
// whole-string; Gemini slices it per line; the OpenTUI hosts diff it
// against the true text and float the changed slice as an overlay box
// (see docs/architecture/glimmer-opentui-overlay-plan.md). Nothing
// here can poison the Resolver's dispatch, BlankFill's span
// invalidation, AgentRewrite's debounce, or ConfigLoader.maybeReload,
// because nothing writes.
//
// HOST-OWNED (chrome): `playHostAnimation` delegates the ENTIRE
// transition to the host (a CSS Custom Highlight API engine that
// restyles glyphs); the runtime generates no frames at all.
//
// The override is ALWAYS the same length as the ctx text (blink and
// scramble are 1:1 char substitutions, newlines preserved) — the
// load-bearing invariant every consumer's splice/diff relies on.
//
// A third mode — REAL-WRITE, which committed every 70ms frame via
// `adapter.setText` with source-reclassifier marking — shipped for the
// OpenTUI hosts and was retired 2026-08-29 once their overlay
// consumption landed (and was never safe on chrome, where it froze
// Gmail). If you're re-introducing anything like it, read
// docs/architecture/glimmer-realwrite-extension-plan.md and the
// overlay plan's "Why" first.
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

/** Parse the `glimmer-transition-ms` scalar. Registry default (`900`) when
 *  absent or unrecognised; `off` (or `0`) disables — 0 means no animation. */
export function parseGlimmerTransitionMs(raw: string | undefined): number {
  if (raw === undefined) return 900;
  const t = raw.trim().toLowerCase();
  if (t === 'off' || t === '0') return 0;
  if (t === '300' || t === '600' || t === '900' || t === '1500') return parseInt(t, 10);
  return 900;
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
  /**
   * Host-owned animation — the host plays the ENTIRE transition itself
   * and the runtime skips frame generation completely (no timer, no
   * scramble text, no writes, no textOverride). Takes priority over
   * both other modes when provided. Chrome is the motivating host: its
   * real-write mode froze Gmail (O(field) DOM walking per frame), so
   * its band delegates to a CSS Custom Highlight API engine that
   * restyles glyphs without touching the text DOM at all.
   *
   * Contract: `cancel()` must synchronously jump the animation to its
   * settled end state — it is called whenever a second transition
   * starts, the buffer changes, or the runtime tears down. `settled`
   * (optional) resolves when the animation completes on its own, so
   * `active` stops over-reporting after a natural finish.
   */
  playHostAnimation?: (spec: {
    startOffset: number;
    finalText: string;
    durationMs: number;
  }) => { cancel(): void; settled?: Promise<void> };
}

/**
 * One active transition at a time (a second `start()` replaces the first —
 * substitutions are user-paced, overlap is a re-summon). Display-only:
 * this class NEVER calls setText/pushText — the buffer holds the final
 * landed text for the whole animation on every host.
 */
export class GlimmerRender {
  private _active: ActiveGlimmer | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _hostAnim: { cancel(): void } | null = null;

  constructor(private opts: GlimmerRenderOptions) {}

  /** Begin the transition over `finalText`, which the caller just committed
   *  at `startOffset`. No-op when the scalar is off or the span is blank. */
  start(startOffset: number, finalText: string): void {
    const durationMs = this.opts.durationMs();
    if (durationMs <= 0) return;
    if (!finalText || finalText.trim().length === 0) return;
    this.cancel(false);
    // Host-owned mode: delegate and stop — no ActiveGlimmer, no timer,
    // no repaint. The buffer already holds the final text (the caller
    // committed it before starting the transition), so there is nothing
    // for the runtime to restore on cancel either.
    if (this.opts.playHostAnimation) {
      try {
        const h = this.opts.playHostAnimation({
          startOffset: Math.max(0, startOffset), finalText, durationMs,
        });
        this._hostAnim = h;
        h.settled?.then(() => { if (this._hostAnim === h) this._hostAnim = null; });
        this.opts.log?.(`glimmer: host animation start (len=${finalText.length}, ms=${durationMs})`);
      } catch (err) {
        // A failed host animation is a lost cosmetic, never a lost
        // substitution — the text is already final. Log and move on.
        this.opts.log?.(`glimmer: host animation failed to start: ${err}`);
      }
      return;
    }
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
    return this._active !== null || this._hostAnim !== null;
  }

  cancel(repaint: boolean): void {
    if (this._hostAnim !== null) {
      const h = this._hostAnim;
      this._hostAnim = null;
      try { h.cancel(); } catch { /* host mid-teardown */ }
    }
    if (this._timer !== null) { clearInterval(this._timer); this._timer = null; }
    if (this._active === null) return;
    this._active = null;
    // Nothing to restore — the buffer was never written; an abandoned
    // animation (e.g. `start()`'s own `cancel(false)` when a second
    // substitution re-summons before the first settles) is harmless.
    if (repaint) this._repaint();
  }

  /**
   * Locate `active.finalText` in `ctxText` and splice `glyphs` in its
   * place. Exact position first; tolerates small offset drift (ZWS
   * strips, host indent) by searching near the expected spot. The
   * buffer is never written during an animation, so the landed text is
   * always the anchor. Returns null when it isn't found — the span is
   * gone (user edit / another module's rewrite) and the caller cancels.
   */
  private locate(active: ActiveGlimmer, ctxText: string, glyphs: string): string | null {
    const anchorText = active.finalText;
    let at = ctxText.startsWith(anchorText, active.start)
      ? active.start
      : ctxText.indexOf(anchorText, Math.max(0, active.start - 16));
    if (at < 0) at = ctxText.indexOf(anchorText);
    if (at < 0) return null;
    return ctxText.slice(0, at) + glyphs + ctxText.slice(at + anchorText.length);
  }

  /**
   * Render-handler hook: the full display string for this frame, or null
   * when idle / settled / the buffer has moved on. `ctxText` is the host's
   * plain visible text — the override returned is ALWAYS the same length.
   */
  getTextOverride(ctxText: string): string | null {
    const a = this._active;
    if (a === null) return null;
    if (a.frameText === a.finalText) return null;
    const spliced = this.locate(a, ctxText, a.frameText);
    if (spliced === null) {
      // The span is gone — the user edited it or another module rewrote the
      // buffer. Stop silently: the buffer is the truth, never fight it.
      this.cancel(false);
    }
    return spliced;
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
