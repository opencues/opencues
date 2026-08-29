# What actually shipped — the production chapter

NOTES.md and PERFORMANCE.md cover the bench arc (the mechanism and its
optimization history). This file covers what happened when the engine
met real pages — the shipped design diverges from the bench in ways a
blog post about "building it" would miss, and the integration bugs are
at least as instructive as the bench findings.

Shipped implementation: `integrations/chrome/src/highlight-glimmer.ts`
(engine) + the `playGlimmer` binding in `src/opencues-bootstrap.ts` +
the `playHostAnimation` seam in
`packages/opencues-runtime/src/modules/glimmer-render.ts`.

## The shipped recipe (vs the bench)

The bench's approved look (80% swap, 60% word re-roll, tail-scrambling
sweep) was ultimately REPLACED by the "family recipe" — the frame
structure every other OpenCues host plays (`glimmer-render.ts _tick`):

1. **140ms blink**: whole span hidden (`color: transparent` in the
   hide bucket), no shadows.
2. **Churn every 70ms**: per-character Bernoulli selection — each char
   independently displaced with probability p; un-selected characters
   show the REAL final text (not darkness — that was a wrong turn, see
   below). Frames selecting <2 chars in a word render it fully real (a
   displacement swap needs a pair; the calm frame is the honest
   analogue of the runtime's single-char in-place substitution).
3. **Ease**: cosine curve from 0.45 → 0 over the window (deliberate
   departure from the family's stepped 45/30/15, which reads as "long
   boil, quick fade" and, amplified by the pair-cliff, as an early
   finish).
4. Decorations: the bench recipe survived — 5 single-line variants
   (underline solid/wavy/dotted, strike solid/wavy) at 30% on
   displaced chars only.

Duration = the shared `glimmer-transition-ms` scalar (default 900),
total wall time 140 + duration, same clock as every host.

## The integration war stories (each cost a real debugging round)

1. **Dead Ranges from editor normalization** — the "text never hides"
   bug. The engine built its per-character Ranges synchronously at
   `glimmer.start`; Gmail then normalizes freshly-written DOM over the
   next frames, replacing the exact nodes the Ranges pointed at. Dead
   Ranges paint NOTHING — no hide, no shadows — while the extension's
   own cue highlight kept painting because the renderer rebuilds ITS
   ranges every pass. Fix: a deferred verified start — retry (50ms, up
   to 600ms) until the buffer's plain text actually carries the landed
   answer, then build against the settled DOM and play the remaining
   budget.
2. **A TreeWalker never visits its own root** — the "still not
   boiling" bug, and the best gotcha of the arc. A Range whose
   endpoints sit inside ONE text node (the normal case for a real
   span) has that text node as its `commonAncestorContainer`; a
   TreeWalker rooted there yields nothing, so the engine animated
   "0 chars / 0 words" — invisibly, with every other stage working.
   The API test had masked it by always passing element-rooted ranges.
   Diagnosed in one shot by an e2e probe reading the extension's debug
   log; pinned forever by `tests/e2e/glimmer.e2e.test.ts`.
3. **The extension's own cue paint showed through** — oc-active's gray
   background sat over the animating span. Fixed twice: glimmer
   highlights carry `Highlight.priority = 100` (overlapping custom
   highlights resolve per-property by priority), AND the renderer
   explicitly withholds oc-dim/oc-active while an animation owns the
   span (`setGlimmerSuppression`) — removed via the pipeline that
   provably paints them, no reliance on priority semantics alone.
4. **Trigger parity needs locate parity.** The runtime's own locate()
   tolerates ±16 chars of offset drift and OpenCode animates through
   drifted landings every time; the chrome binding initially demanded
   an exact-offset match and silently skipped fluid-blank answers.
   Mirror the tolerance or lose parity.
5. **Cancel-on-edit needs an echo exemption.** The animation must die
   on any real text change (its Ranges belong to the old text) — but
   managed editors re-notify the SAME text as late write-echoes, and a
   naive cancel-on-notify kills the animation on its own landing. The
   binding compares against a baseline snapshot: identical text is
   spared, any difference cancels.
6. **`-webkit-text-fill-color` and `-webkit-text-stroke-*` are dead in
   `::highlight()`** (MDN lists them; Chromium ignores them) — use
   plain `color`. And hide with `transparent`, not a matched
   background color: bg-matching paints visible letter shapes on
   gradients/images/dark themes.

## The test story (three layers, each covering the others' blind spot)

- **Runtime unit (vitest)**: the delegation contract — 6 tests on
  `playHostAnimation` (spec, cancel-once, supersede, settled, throwing
  host, scalar-off).
- **Engine unit in REAL Chromium** (`tests/playwright/
  glimmer-engine.pw.test.ts`): jsdom has no Highlight API at all, so
  vitest structurally cannot execute the engine — that gap is exactly
  how bug #2 shipped. Six tests assert directly against
  `CSS.highlights` (same world): the zero-chars regression, multi-node
  word counting, blink/churn visibility semantics, settle + destroy
  cleanliness, cancel-mid-run, and the collapsed-range liveness guard.
- **Extension e2e** (`tests/e2e/glimmer.e2e.test.ts`): the integrated
  path — real extension, real fluid-blank fill, asserts via the debug
  log (isolated-world highlight registrations aren't reliably visible
  to main-world probes) that the host animation delegates AND animates
  exactly the answer's character count.

## Blog-post skeleton this suggests

1. The incident: an animation froze Gmail (cost model, not code).
2. The pivot: styling can fake a scramble (displacement + occlusion).
3. The bench arc: permutation math, offset bucketing, layout-thrashing
   (PERFORMANCE.md has the numbers).
4. Production: the five integration war stories above — the DOM fights
   back.
5. The test pyramid for an API jsdom can't see.
