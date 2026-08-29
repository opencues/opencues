# Glimmer scramble: performance history, DOM real-write to the final Highlight API embodiment

Source material for a blog post. Every number below was measured in this
repo's sessions; the caveats section at the bottom says exactly how, and
which comparisons were matched A/Bs versus cross-generation readings.

## The problem

Glimmer is a brief character-scramble animation played over a word or
sentence while a substitution is pending. It ticks every 70ms, roughly
6-15 frames per transition. The question the whole arc answers: what is
the cheapest way to repaint a handful of characters, at 14Hz, inside a
page you do not control?

## Generation 0: DOM real-write (the incident)

The original chrome integration reused the real edit pathway for every
animation frame. One tick did:

1. `readCursorOffset()` (a DOM walk over the field)
2. `walkPlainText()` inside `applyTextDiff` (a full-field DOM walk)
3. the text splice itself
4. `writeCursorOffset()` (another walk)
5. `reapplyCursor()` scheduling the same walk twice more (microtask + RAF)

Per-tick cost was O(field length), not O(animated word length). On the
40-character e2e test page this was invisible. On a real Gmail reply
chain (multi-thousand characters of quoted thread), 13 ticks per second
of full-field DOM walking froze the tab. This was not a benchmark
finding, it was a production incident: real-write mode was disabled on
chrome and the animation was lost.

On a small test field the DOM approach measured roughly 1-2ms per tick.
The number was never the problem; the O(field length) scaling was.
A second structural problem: real writes fight managed editors
(Lexical, ProseMirror, Quill own their DOM and revert foreign
mutations) and every write risks landing on the undo stack.

## The pivot: CSS Custom Highlight API

The replacement renders the scramble with zero writes to the text DOM.
Per-character `Range` objects are built once; visual changes happen by
moving Ranges between registered `Highlight` sets and flipping CSS
values. The text node bytes never change, so there is nothing for a
managed editor's reconciler to revert and nothing lands on the undo
stack. Cost is decoupled from field length by construction.

Two rendering traps cost real debugging time and are worth a blog
paragraph each:

- `-webkit-text-fill-color` is on the MDN allow-list for
  `::highlight()` but is silently ignored by Chromium 148 (verified by
  controlled A/B: `color: red` works, `-webkit-text-fill-color: red`
  computes but paints nothing different). `-webkit-text-stroke-*` is
  likewise custom-highlight-dead per Chromium source history. Plain
  `color: transparent` plus `text-shadow` is the working combination.
- Hiding the real glyph with `color: var(--bg)` painted the wrong
  color because the text sat on a `var(--surface)` card, not the page
  background. `color: transparent` sidesteps token matching entirely.

## Generation 1: naive scale-up (per-character everything)

First multi-paragraph version, benchmarked at 500 words / 2616
characters:

| Phase | Cost | Why |
|---|---|---|
| Geometry setup | **766ms** | one `getBoundingClientRect()` per character (2616 layout reads) |
| Highlight registration | **~694ms** | one `Highlight` + one CSS rule + one custom property per character, O(N) CSSOM churn |
| Tick | **~11-12ms** | O(N) loops, per-write string concatenation, `:root`-scoped custom-property writes |

Both setup phases scale linearly with document length. The tick was
within the 70ms budget but wasteful.

## Generation 2: measurement batching and micro-optimizations

**Word-batched, kerning-aware geometry.** One `getClientRects()` call
per word instead of one rect per character; intra-word positions come
from cumulative canvas `measureText` differences (cumulative because
kerning is a property of adjacent pairs; per-glyph measurement drops
it). Setup: **766ms to 14ms, a 54x reduction**, verified on a fresh
page load.

**Three tick micro-optimizations** (matched pass on the same page):
precomputed CSS property-name strings instead of per-write
concatenation, parallel `Float32Array`s instead of an array of `{x,y}`
objects, and custom-property writes scoped to the animated container
instead of `:root` (smaller style-invalidation surface). Tick:
**~11-12ms to ~5ms**.

What did not help, tried and measured:

- **Web Workers / WASM.** Sharding tick compute across a worker pool
  was a net loss: the postMessage plus structured-clone round-trip cost
  more than the ~1-2ms of compute it replaced, and the actual expensive
  parts (`Range`, `Highlight`, CSSOM, paint) have no Worker-side
  equivalent at all. WASM has the same problem: the bottleneck was
  never JS compute.
- **A hash map for the hot lookups.** The hot arrays are keyed by
  dense integers 0..N-1, which plain arrays already serve at raw
  memory-offset speed. Hashing would have added cost. (The hash
  *instinct* was right, it just pointed at the wrong key: see
  Generation 3.)

## Generation 3: offset bucketing (the structural win)

The registration cost existed because the design assumed every
character might need its own offset, so every character got its own
highlight. But offsets are intra-word deltas: words are at most ~12
characters and ~100px wide, so after quantizing to 0.5px bins only
about **300 distinct offset values** occur in the entire document,
independent of its length.

So the registry was inverted: one highlight per offset VALUE, with a
static rule carrying a literal px shadow. A character needing +12.5px
gets its Range added to the 12.5px bucket; at rest it belongs to no
bucket at all. Per-tick work becomes `Set.add()`/`Set.delete()` calls,
the same mechanism the decoration layer had used all along at ~0.07ms
per pass. No custom properties remain in the hot path.

Matched A/B, 500 words, same session, re-roll pinned to 100% for
like-for-like:

| Phase | Before | After |
|---|---|---|
| Registration | 694ms | **0.2ms** (3000x; O(N) to O(B)) |
| Tick | 4.8-5.6ms | **2.27ms** |

Correctness became cheaper too: the per-tick collision check was
deleted outright, because a per-word permutation is a bijection
(two sources cannot map to one landing slot) and words do not share
boxes. The counter had verified a mathematically guaranteed property
on every tick and had read zero forever.

Shipped alongside: staggered word re-roll (each word re-rolls its
permutation at ~30% per tick and otherwise holds, so a held word costs
literally zero work) and geometric-skip sampling for the decoration
layer (jump between hits with `skip ~ Geometric(p)` instead of rolling
a random per character). Tick at the default re-roll rate: **1.9ms**.

## Generation 4: lazy geometry, viewport culling, frame alignment

The last O(N) phase was geometry setup. Final generation:

- **Lazy per-word measurement.** Setup measures nothing (3.9ms at 500
  words: string scan plus Range creation, no layout reads). A word is
  measured on the first tick that actually re-rolls it; words that
  never animate are never measured.
- **Viewport culling.** IntersectionObserver per paragraph (100px
  margin); off-screen paragraphs neither re-roll nor measure. Per-tick
  cost tracks the viewport, not the document, so a 100,000-word page
  costs the same as a 300-word one.
- **Frame-aligned ticking.** Cadence from `setTimeout(70)`, with each
  tick's mutations offered to the next real frame via
  `requestAnimationFrame` (24ms fallback when frames are starved);
  hidden tabs skip the work entirely.

This generation contained the best bug of the arc. The first lazy
version interleaved measurement (a layout read) with bucket mutations
(style writes) in the same loop, forcing a synchronous reflow per
newly-measured word: **534ms for one tick** that measured 136 words.
Phase-separating each tick (all reads, then all writes) dropped the
same tick to **~11ms**, a 48x difference for reordering the same work.
Layout thrashing is well documented; watching it turn a lazy-loading
"optimization" into a 534ms frame is still a lesson worth publishing.

Steady-state tick after geometry is built: **1.6ms**.

## The scoreboard (500 words / 2616 characters unless noted)

| | Setup (geometry) | Registration | Tick | Scaling |
|---|---|---|---|---|
| Gen 0: DOM real-write | n/a | n/a | froze Gmail (O(field) per tick) | O(field length) every tick |
| Gen 1: naive Highlight API | 766ms | ~694ms | ~11-12ms | O(N) setup, O(N) tick |
| Gen 2: batching + micro-opts | 14ms | ~694ms | ~5ms | O(W) setup, O(N) registration |
| Gen 3: offset bucketing | 14ms | 0.2ms | 1.9ms | O(B) registration, O(touched) tick |
| Gen 4: lazy + culled + aligned | 3.9ms upfront (amortized ~11ms ticks while building) | 0.2ms | 1.6ms | independent of document length; tracks viewport |

Net: setup roughly 370x cheaper, registration roughly 3000x cheaper,
tick roughly 7x cheaper than the first Highlight API version, and the
whole thing exists because the Gen 0 approach could not be made safe on
long fields at any constant factor: its cost model was wrong, not its
implementation.

## The honest caveats

- All numbers are from headless Chromium 148 on one WSL2/Linux machine,
  measured with `performance.now()` around the JS tick. **Browser-side
  style recalc and paint after each tick is not captured** by any tick
  number here; it applies to every generation equally but means the
  absolute tick figures understate total frame cost.
- Gen 3's registration and tick A/Bs were matched (same session, same
  page, saved before-copy). The Gen 1 to Gen 2 setup comparison
  (766 to 14ms) was measured across page variants of the same demo, and
  the Gen 2 tick improvement (~11-12 to ~5ms) had no saved before-copy,
  so treat those as directional rather than exact.
- The Gen 0 "froze Gmail" result is an incident report, not a
  benchmark; the 1-2ms DOM tick figure is from a small synthetic field.
- The headless environment produces zero frames (rAF fired 0 times in
  800ms while reporting `visibilityState: visible`), so Gen 4's
  frame-aligned path and real culling behavior were verified only via
  their degraded-open fallbacks; the happy paths need a real browser.
- The Highlight API approach renders a scramble of the EXISTING
  characters via displacement and occlusion. It cannot show characters
  that are not in the text (the DOM approach could write arbitrary
  glyphs). The confusable-glyph substitution look from the original
  effect is approximated, not reproduced byte-for-byte.

## One-line takeaways for the post

1. If per-frame cost scales with anything other than what is animating,
   no constant-factor optimization will save you (Gen 0).
2. The browser gives you a styling multicast primitive (`Highlight` =
   one style, N ranges); keying it by style value instead of by element
   turned O(N) registration into O(300) (Gen 3).
3. A bijection is cheaper than a collision detector: choose assignments
   so conflicts are impossible instead of checking for them (Gen 3).
4. Lazy loading that interleaves layout reads with style writes is
   slower than not being lazy at all; phase-separate or do not bother
   (Gen 4, 534ms to 11ms).
5. Workers cannot help when the bottleneck is DOM/CSSOM/paint; measure
   the round-trip before sharding (Gen 2).
