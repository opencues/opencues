# CSS Custom Highlight API scramble effect — reference notes

Working embodiment + design/API findings for a character-scramble
("glimmer") effect built entirely on the CSS Custom Highlight API
(`::highlight()`), as a chrome-safe alternative to real-write mode
(which froze Gmail tabs — the incident that motivated this exploration;
see the `feat/glimmer-transition` branch history). Zero DOM writes to
the text itself: the effect is pure highlight-registry + stylesheet
manipulation, so it cannot fight a managed editor's reconciler or
touch the undo stack.

The embodiment lives next to this file:

- `glimmer-bench.html` — the full benchmark/demo page (word-count
  slider 10-500, all optimizations, decoration pools, follow-swap).
  Self-contained; open in any Chromium-family browser or serve
  statically. NOTE: written for the claude.ai Artifact wrapper, so the
  file intentionally has no `<!doctype>`/`<html>`/`<body>` wrapper
  tags — browsers parse it fine as-is.
- `glimmer-deco-picker.html` — static picker of every text-decoration
  variant the Highlight API can deliver (same wrapper note applies).

## Core mechanism: permutation-based swap

Each character gets ONE permanent `Range` + ONE permanent `Highlight`,
registered once at setup. A tick never adds/removes Range membership —
it only rewrites a per-character CSS custom property (`--oc-char-N-off`)
that the highlight's `text-shadow` reads. At rest (offset 0) the shadow
lands exactly on the real glyph's own position, so it's visually
indistinguishable from normal text with no extra state needed.

Per tick: pick a random subset of a word's characters, Fisher-Yates
shuffle a permutation of that subset onto itself, set each character's
offset to `targetX - ownX`. Because it's a **bijection** (permutation),
two characters can never be assigned the same landing position —
overlap is impossible by construction, not by a safety margin or
runtime collision check. This replaced an earlier offset-heuristic
approach (continuous offset + boundary checks) that kept finding new
overlap cases (leapfrogging, edge cases, etc.) — the permutation
approach has zero of that class of bug.

## Swap scope MUST be per-word, not per-line

Scrambling a random subset across an entire *line* (many words) reads
as scattered, unrelated noise — swap pairs land in unrelated words, so
nothing reads as "this word is scrambling." Scoping the permutation to
one *word*'s own characters (bounded to ~4-12 letters) is what makes it
read as a cohesive shuffle. This was the actual bug behind an early
"isolated targets, not a shuffle" complaint — not pool architecture,
not performance, purely swap scope.

## Geometry: word-batched, kerning-aware

One `Range.getClientRects()` call per WORD (not per character) gives
the real line/left-edge/width. Intra-word character positions come from
**cumulative** canvas `measureText` differences (`measureText('R')`,
`measureText('Re')`, `measureText('Rey')`, ...), not per-character
isolated `measureText` calls — kerning is a property of adjacent pairs,
and the browser's real shaper runs on each substring, so cumulative
differences capture the shaped result; isolated per-glyph measurement
silently drops kerning. Correct one `getBoundingClientRect()`-equivalent
width against the real rendered word width to reconcile canvas-measured
vs DOM-rendered totals.

Rare case: a word wraps mid-line (`getClientRects().length > 1`) — falls
back to per-character `getBoundingClientRect()` for just that word.

## Two real rendering bugs found (both confirmed via controlled A/B, not assumption)

### 1. `-webkit-text-fill-color` is silently ignored by `::highlight()`

Confirmed on Chromium 148 (headless) via a 3-way test: `color: red` on
a highlight renders/computes correctly; `-webkit-text-fill-color: red`
alone falls back to black (ignored entirely); `color: transparent` +
`-webkit-text-fill-color: red` together — `color` wins outright, fill
color has zero effect either way. MDN lists `-webkit-text-fill-color`
as spec-allowed for `::highlight()`, but it isn't reliably implemented.
**Fix: use plain `color`, not `-webkit-text-fill-color`, to hide the
real glyph.** (Companion finding from earlier in this session:
`-webkit-text-stroke-color`/`-width` are ALSO not honored by custom
`::highlight()` per Chromium source history — legacy-highlight-only.
Between the two, this rules out the whole `-webkit-text-*` family for
this technique; stick to `color` / `background-color` /
`text-decoration-*` / `text-shadow`, which all verified correctly.)

`getComputedStyle(el, '::highlight(name)')` is a reliable way to probe
this — it correctly reflects `color`, `text-decoration-*`, and
`text-shadow`, and just as reliably reflects that `-webkit-text-fill-color`
never took hold (both cases returned black, not two different "wrong"
values) — so this was a real rendering gap, not a computed-style query
quirk.

### 2. `color: var(--bg)` painted the wrong color to hide text

Even after switching off `-webkit-text-fill-color`, using `color:
var(--bg)` (the page background) was wrong because the actual container
(`.prose`) paints with `background: var(--surface)` — a *different*
design token/color. The "hidden" text rendered as a visible bg-colored
patch against the surface-colored card, read as unwanted styling.

**Fix: use `color: transparent` instead of chasing the right background
token.** Verified independent of `text-shadow`'s own explicitly-set
color (shadow still paints at rgb(255,0,0) etc. even when `color:
transparent`) — sidesteps the whole "which container background is
actually behind this text" problem permanently, since transparent works
regardless of what's behind it.

Working rule shape:
```css
::highlight(oc-char-N) { color: transparent; text-shadow: var(--oc-char-N-off) 0 0 var(--text); }
```

## Decoration pool (separate, additive mechanism)

Independent of the swap: pre-register a fixed pool of decoration
highlights (`text-decoration-line/-style/-color` combos — underline
solid/wavy/dotted/double, strike solid/wavy, overline solid/dashed).
Per tick, each character independently gets assigned to zero-or-one
bucket via `Highlight.add()`/`delete()` at some probability ("density").
Purely additive — decoration draws on top of the normal glyph, no
fill/color hiding needed, composes cleanly with the swap running at the
same time on the same characters.

## Tick-loop micro-optimizations (verified, ~2x tick time)

Once correctness was settled, three low-risk changes to the hot per-tick
write path — no architecture change, same swap/decoration mechanisms:

1. **Precompute the CSS custom-property name strings.** The tick loop
   was rebuilding `'--oc-char-' + i + '-off'` via string concatenation
   on every single write, every tick. Built once into a `propNames[i]`
   array at registration time instead; the tick loop just indexes into
   it.
2. **Parallel typed arrays for geometry, not an array of `{x,y}`
   objects.** `charPos[i].x` is a hidden-class property lookup;
   `charPosX[i]` on a `Float32Array` is a raw indexed memory read —
   faster and more cache-local when hundreds of characters are touched
   per tick. Built as plain arrays during measurement (final count
   isn't known until that loop finishes), converted to `Float32Array`
   once right after.
3. **Scope custom-property writes to `.prose`, not
   `document.documentElement`.** A `:root`-scoped custom-property write
   has the whole document tree as its invalidation surface; `.prose` is
   a much smaller subtree and is the only place these properties are
   ever read from (every `::highlight()` rule referencing them lives
   inside it).

**What did NOT help, and why:** using a `Map`/hash for `offsets` or
`charPos` lookups — both are keyed by dense integers `0..N-1`, which
arrays already serve optimally (direct memory offset, no hash
computation). A hash would have added overhead here, not removed it —
worth knowing before reaching for one reflexively. `activeNow` staying
a `Set` is correct, by contrast: it's genuine membership testing over a
shifting subset, the case hashes are actually for.

Measured on `glimmer-bench.html`, 500 words / 2616 characters,
decoration on: tick time settled to ~5.1-5.3ms at steady state
(after a few seconds of JIT warmup), down from ~11-12ms before this
pass — roughly 2x. Registration cost (~650-694ms at 500 words) was
untouched by this pass — that was fixed structurally by offset
bucketing, next section. (The custom-property machinery this section
describes was later REMOVED entirely by bucketing; the lessons stand,
the code doesn't.)

## Offset bucketing — the O(N) → O(B) registration fix (verified, matched A/B)

The structural win. Key the highlight registry by OFFSET VALUE, not by
character index. Offsets are intra-word deltas: words ≤ ~12 chars and
~100px wide, so after quantizing to 0.5px bins only B ≈ 300 distinct
values ever occur — a property of the font/word lengths, NOT of
document size. One bucket = one `Highlight` + one static rule with a
literal px value (`::highlight(oc-off-12p5) { color: transparent;
text-shadow: 12.5px 0 0 var(--text); }`), created lazily on first use.
A character needing +12.5px gets its Range `add()`'d to that bucket; at
rest it's in no bucket at all (real glyph shows, zero involvement). No
per-character highlights, rules, or custom properties exist anymore.

- Registration (matched A/B, 500 words): **694ms → 0.2ms**. B settled
  at ~300-317.
- Tick (re-roll pinned 100% for like-for-like): 4.8-5.6ms → 2.27ms.
- A bucket key is a DISPLACEMENT, not a destination — chars sharing a
  bucket land at `ownX + offset` each, so bucketing collapses styling,
  never geometry. Quantization (≤0.25px error) can't merge two distinct
  landings: they're ≥ a glyph width (~7px) apart.
- Overlap-freedom needs NO runtime check: each word's assignment is a
  permutation of its active subset (bijection → distinct landings),
  words don't share boxes. The old per-tick collision counter verified
  a proven property at O(k) cost and was deleted.
- Shipped alongside: staggered word re-roll (each word re-rolls at a
  slider rate, ~30%/tick; held words cost zero — O(touched) per tick)
  and geometric-skip decoration sampling
  (`skip = 1 + floor(log(1-rand)/log(1-p))` — O(k) not O(N)).

## Tier 1+2 — lazy geometry, viewport culling, frame-aligned ticks

Goal: make even SETUP independent of document size, and per-tick cost
track the viewport rather than the document.

- **Lazy per-word geometry.** rebuild() measures NOTHING (3.9ms at 500
  words — string-scan + Range creation only; Range creation is not a
  layout op). A word's measurement (one `getClientRects()` + cumulative
  measureText) runs on the first tick that re-rolls it. Words that
  never animate never measure — sub-2-char words stay unmeasured
  forever.
- **⚠ THE LAYOUT-THRASHING TRAP (the day's most reusable lesson).**
  The first lazy version called ensureGeometry (layout READ) inline in
  the same loop as bucket churn (style WRITES): every newly-measured
  word forced a synchronous reflow of a just-invalidated layout.
  Measured: **534ms for one tick** that built 136 words' geometry — vs
  ~20ms for the same measurements as an uninterrupted read pass. Fix:
  phase-separate every tick — phase 1 decides the re-roll set and does
  ALL measurement (reads only), phase 2 does ALL bucket churn (writes
  only). Same tick dropped to ~11ms; steady state 1.64ms. Any future
  lazy-measure design MUST keep reads and writes in separate phases.
- **Viewport culling.** IntersectionObserver per `<p>` (100px margin);
  words in off-screen paragraphs don't re-roll and never measure.
  Granularity is per-paragraph because IO observes elements only —
  words aren't elements (the whole point of the technique).
- **Frame-aligned ticking.** Cadence from `setTimeout(70)`; each tick's
  mutations are OFFERED to the next real frame via rAF with a 24ms
  unaligned fallback; hidden tabs skip work (`document.hidden`) but
  keep the loop armed.
- **⚠ Degraded-open fallbacks are mandatory, verified necessary:** this
  sandbox's headless Chromium produces ZERO frames (rAF fired 0 times
  in 800ms; IntersectionObserver never delivers) while reporting
  `visibilityState: 'visible'`. A pure rAF loop never ticks there, and
  paragraphs defaulting to not-visible would freeze the effect
  entirely. So: paragraphs default VISIBLE (culling fails to "no
  culling", never "no animation") and the tick loop falls back to
  unaligned setTimeout (exactly the old setInterval behavior). The
  headless tests exercise ONLY the fallback paths; the rAF-aligned path
  and real culling behavior were never verifiable in this sandbox and
  need a real browser (scroll and watch "Visible paras" / "Words
  re-rolled" drop).
- Scroll safety: a word that scrolls out keeps its frozen scramble
  until it returns and re-rolls; X-offsets survive vertical scroll
  because only intra-word deltas are used. Reflow/resize invalidation
  is NOT handled (same as every prior version).

## Decoration pools + follow-swap mode (final embodiment state)

The decoration layer ended up with three selectable pools (dropdown,
switchable mid-run — takes effect next tick since the deco pass clears
and re-samples every tick):

- **solid-combos** (default): underline / strike / overline /
  underline+overline / underline+strike / all-three, all solid.
- **dotted-combos**: the same six line shapes, all dotted.
- **mixed8**: the original demo3 pool (underline solid/wavy/dotted/
  double, strike solid/wavy, overline solid/dashed).

All 20 buckets across every pool are registered up front (a constant,
independent of document length); the dropdown only changes which list
the tick samples from. One `::highlight()` bucket can carry MULTIPLE
`text-decoration-line` values (`underline overline line-through`) —
that's what makes the combined variants one bucket each, not stacked
memberships.

**Follow-swap toggle** ("Deco on swapped chars only"): decoration
candidates become exclusively the currently-swap-active characters
(verified containment: every decorated Range ∈ swap buckets, exactly),
with density then meaning "fraction of swapped chars marked". ⚠ The
mark paints over the character's ORIGINAL box — the Range doesn't move,
only the glyph's shadow does — so follow-swap marks sit on the vacated
slots, not on the displaced ink. Making the mark travel with the ink =
assign the decoration to the TARGET character's range instead
(one-line change, deliberately not done).

A static picker page (every text-decoration variant as plain text,
shipped-pool variants marked) was published separately for choosing
pool contents: **glimmer-deco-picker.html**.

## Verification method used throughout

Screenshots hang indefinitely in this sandbox (even a plain `<div>`,
unrelated to any custom code) — no pixel-level check available headless.
Relied on: `getComputedStyle(el, '::highlight(name)')` for CSS-level
truth, controlled A/B comparisons (literal vs var(), property X vs
property Y, isolated single-variable changes) rather than one-off
checks, and direct user visual reports as ground truth when computed
style couldn't settle a question on its own.

## Published artifacts (this session)

- **glimmer-cuts.html** — single-word permutation swap + decoration/
  contingency scramble, cutting-mat design system.
- **glimmer-demo4.html** — verbatim copy of the original approved
  single-word demo (`demo4-permutation.html`), only wrapper tags
  stripped for the Artifact tool's contract. Still has the
  `-webkit-text-fill-color` bug latent, unfixed on purpose (kept
  byte-for-byte verbatim per request).
- **glimmer-bench.html** — the current reference: word-count slider
  (10-500), word-scoped swap + optional decoration pool, both rendering
  bugs fixed (`color: transparent`), offset bucketing, staggered
  re-roll, lazy geometry, viewport culling, frame-aligned ticks with
  degraded-open fallbacks. This is the one to build on next. Final
  numbers at 500 words / 2616 chars: setup 3.9ms, registration ~0,
  steady-state tick 1.6ms, geometry amortized lazily (~11ms ticks while
  building).

## Open / unverified

- Whether a `blob:` Worker URL survives the Artifact tool's CSP
  (relevant if tick-compute parallelism is revisited) — never confirmed
  either way, the check got interrupted mid-session.
- Worker-pool tick compute was tried and measured as a net loss (~1-2ms
  compute replaced by ~10ms+ postMessage/structured-clone round-trip) —
  not worth it at these character counts; the actual setup-time cost
  (registering N persistent highlights) can't move off-thread at all,
  since `Range`/`Highlight`/CSSOM have no Worker-side equivalent.
