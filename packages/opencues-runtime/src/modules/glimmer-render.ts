// GlimmerRender — scramble-settle transition when a substituted answer
// lands (fluid-blank, transform-blank, keyword blank fills).
//
// TWO delivery modes, same scramble/blink/splice logic underneath:
//
// RENDER-ONLY (Claude Code, Gemini CLI): the buffer commits INSTANTLY;
// only the PAINTED string animates, via `RenderDirectives.textOverride`
// from a render handler, driven by bare `adapter.forceRender()` calls that
// no band routes back into onTextChange. Nothing here can poison the
// Resolver's dispatch, BlankFill's span invalidation, AgentRewrite's
// debounce, or ConfigLoader.maybeReload, because nothing writes.
//
// REAL-WRITE (OpenCode, shell, chrome — hosts whose renderer never reads
// `textOverride`): pass `realWrite: { markRuntimeWrite }` and every frame
// is committed via `adapter.setText()` instead, marked through the host's
// source-reclassifier FIRST so it's classified 'runtime' — the same
// mechanism `blank-loading.ts` already uses for its per-tick spinner
// writes. That reclassification is what keeps a real-write glimmer from
// poisoning BlankFill (which gates its whole onTextChange handler on
// `e.source === 'user'`); AgentRewrite and ConfigLoader gate the same way
// as of the fix alongside this mode (see
// docs/architecture/glimmer-realwrite-extension-plan.md for the full
// trace of what does and doesn't need that gate, and the per-host side
// effects — OpenTUI's extmark-wipe-on-setText, chrome's MutationObserver-
// fighting rich-text editors — that a real write inherits per host).
// Both modes reuse `getTextOverride()`'s span-location + splice logic —
// write mode just also commits what it locates instead of only painting
// it, and explicitly restores the clean final text on settle (render-only
// mode never needs that: the buffer was always already final).
//
// Claude Code applies overrides whole-string; Gemini slices a whole-buffer
// override per line — both safe because the override/write is ALWAYS the
// same length as the ctx text (blink and scramble are 1:1 char
// substitutions, newlines preserved) — which is also what keeps a
// real-write frame length-stable across every host.
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
  /**
   * Write mode only: the text CURRENTLY sitting in the buffer at this
   * span — whatever `_writeFrame` last actually wrote, or `finalText`
   * itself before the first write. Render-only mode never reads this;
   * its buffer always literally contains `finalText` (nothing writes
   * there), so `locate()` anchors on `finalText` directly. Write mode's
   * buffer holds the PREVIOUS frame once any write has happened, so
   * each subsequent `locate()` call has to search for THAT, not the
   * long-gone original landed text.
   */
  bufferedText: string;
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
   * Real-write mode — REQUIRED on hosts whose renderer doesn't consume
   * `RenderDirectives.textOverride` (OpenCode, shell, chrome today).
   * Omit to keep the render-only path (Claude Code, Gemini CLI).
   *
   * `markRuntimeWrite` MUST be the same source-reclassifier instance the
   * host's own `setText`/`pushText` wrapper uses — every frame calls it
   * with the frame's full post-write text BEFORE calling
   * `adapter.setText`, exactly mirroring `blank-loading.ts`'s pattern.
   */
  realWrite?: {
    markRuntimeWrite: (text: string) => void;
  };
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
 * substitutions are user-paced, overlap is a re-summon). Render-only unless
 * `realWrite` is configured (see GlimmerRenderOptions.realWrite) — this
 * class never calls setText/pushText on its own initiative otherwise.
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
      bufferedText: finalText, // buffer still holds the real landed text — nothing written yet
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
    const wasActive = this._active;
    if (wasActive === null) return;
    this._active = null;
    // Write mode: restore a dirtied buffer UNCONDITIONALLY — regardless
    // of `repaint`. Render-only mode never touches the buffer, so an
    // abandoned animation (e.g. `start()`'s own `cancel(false)` when a
    // second substitution re-summons before the first settles) is
    // harmless there: the buffer already held the correct text the whole
    // time. In write mode the SAME abandon would otherwise leave
    // whatever scrambled frame was last written permanently sitting in
    // the user's buffer — worse than one extra restore write. Wrapped in
    // try/catch: cancel() can fire during host teardown (dispose()),
    // when the adapter may already be gone.
    if (this.opts.realWrite && wasActive.bufferedText !== wasActive.finalText) {
      try { this._writeFrame(wasActive, wasActive.finalText); } catch { /* host mid-teardown */ }
      return;
    }
    if (repaint) this._repaint();
  }

  /**
   * Locate `anchorText` in `ctxText` and splice `glyphs` in its place.
   * Exact position first; tolerates small offset drift (ZWS strips, host
   * indent) by searching near the expected spot. Pure — takes `active`
   * explicitly rather than reading `this._active`, so it works the same
   * whether the transition is still active (every normal tick) or has
   * just been cleared (write mode's settle call, after `cancel()` has
   * already nulled `_active`).
   *
   * `anchorText` is NOT always `active.finalText`: render-only mode never
   * touches the buffer, so it's always there verbatim and callers pass
   * `finalText`. Write mode's OWN previous frame is what's actually
   * sitting in the buffer once any write has happened, so its callers
   * pass `active.bufferedText` instead — searching for `finalText` there
   * would fail every tick after the first (the buffer no longer contains
   * it) and read as "span gone" when nothing is actually wrong.
   *
   * Returns null when `anchorText` isn't found — callers decide what
   * "not found" means for their case.
   */
  private locate(active: ActiveGlimmer, ctxText: string, anchorText: string, glyphs: string): string | null {
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
    // Render-only: the buffer is never written, so it always literally
    // contains `finalText` — that's the anchor.
    const spliced = this.locate(a, ctxText, a.finalText, a.frameText);
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
    if (this.opts.realWrite) {
      const a = this._active;
      if (a === null) return;
      try {
        // Not the settle path (that calls _writeFrame directly, after
        // `_active` is already null) — this is a normal in-flight tick,
        // so a "span gone" result means the user edited it: self-cancel,
        // same documented guarantee the render-only path gives via
        // getTextOverride's cancel(false).
        if (!this._writeFrame(a, a.frameText)) this.cancel(false);
      } catch { /* host mid-teardown */ }
      return;
    }
    try { this.opts.adapter.forceRender?.(); } catch { /* host mid-teardown */ }
  }

  /**
   * Write-mode only: splice `glyphs` into the LIVE buffer at the landed
   * span (via `locate()` — the same span-location + drift-tolerance the
   * render-only path uses), mark it via the host's reclassifier BEFORE
   * writing so BlankFill/AgentRewrite/ConfigLoader treat it as a runtime
   * write, then restore the adapter's cursor (setText implementations
   * vary in whether they preserve cursor position on their own).
   * `active` is passed explicitly (not read from `this._active`) so this
   * also works for the settle call, made AFTER `cancel()` has already
   * cleared `_active` — using the live field there would silently no-op.
   * Returns false when the span wasn't found (nothing written) so
   * callers on the normal-tick path can self-cancel, same guarantee the
   * render-only path gives via getTextOverride's cancel(false).
   */
  private _writeFrame(active: ActiveGlimmer, glyphs: string): boolean {
    const ctxText = this.opts.adapter.getText();
    // Anchor on whatever's ACTUALLY in the buffer right now (the
    // previous frame, or finalText before the first write) — see
    // locate()'s doc comment for why this differs from the render-only
    // path.
    const spliced = this.locate(active, ctxText, active.bufferedText, glyphs);
    // Span gone — the user edited it or another module rewrote the
    // buffer. The buffer is the truth, never fight it.
    if (spliced === null) return false;
    const cursor = this.opts.adapter.getCursorOffset();
    this.opts.realWrite!.markRuntimeWrite(spliced);
    this.opts.adapter.setText(spliced);
    this.opts.adapter.setCursorOffset(cursor);
    active.bufferedText = glyphs; // this is what the NEXT tick will find in the buffer
    return true;
  }

  dispose(): void {
    this.cancel(false);
  }
}
