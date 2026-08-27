# CLAUDE.md — Glimmer (reading-side cues experiment)

Working context for `experiments/roi-debug/` — the **Glimmer** prototype.
What it is and the module API: [README.md](README.md). This file is the part
that was expensive to learn: every rule below is a bug a user actually hit
in this build, with the mechanism that fixes it. When behaviour in similar
territory feels off, re-read the matching rule before writing code.

**Name:** Glimmer. The effect is the identity: an attention band (ROI) over
the page, LLM insight analysis of prose passing through it, a scramble
"glimmer" on the last visible prose word, hover-to-reveal boiling the
paragraph down to the insight. The directory keeps its `roi-debug` name
until graduation (the Chrome mirror path and load-order are wired to it).

## The learnings — each one is a fixed bug

### DOM you don't own

- **Never destroy the page's nodes. Only ever write text-node VALUES.**
  `el.textContent = ''` + `innerHTML = snapshot` round trips looked correct
  and silently broke LinkedIn's "…more" button: the restored button is a
  clone with no click listener, and the framework (Ember) keeps references
  to nodes that no longer exist. The whole reveal pipeline writes
  `nodeValue` into existing nodes (`shapeOf` → `paintShape`/`paintText` →
  `restoreShape`), and a node the page replaced mid-animation is SKIPPED on
  restore — never stomp DOM the page re-rendered.
- **Snapshots go stale; capture at use time, from a clean state.** A
  pristine snapshot taken at request time re-collapsed a post the user had
  expanded since. Capture at reveal start, after cancelling every running
  boil inside the element (a snapshot taken mid-churn bakes scrambled text
  into the "original" — the not-returning-to-original bug).
- **Interactive text is out of the animation entirely.** Words inside
  `a/button/code/pre/[role=link|button]` are never scrambled, overwritten,
  or restored. An `a[href]` ANCESTOR disqualifies the whole candidate (every
  word navigates); a `role="button"` wrapper does not (LinkedIn wraps whole
  post bodies in one — blanket-rejecting it killed the feature there).
- **Excluding content from the animation means HIDING it during the
  reveal.** The shape excludes interactive text, so inline links (wikipedia
  citations), inline code (github/so/mdn) and X's emoji imgs survived the
  shrink as stray fragments floating inside the settled insight. Reveals
  hide those elements (inline `display`, saved and restored — style-only,
  the non-destructive contract holds) for their lifetime.
- **"Visible" is a three-part test, not a rect check.** (1) The word's own
  rect intersected with EVERY clipping ancestor (LinkedIn's line-clamp
  wrapper clips from ABOVE the paragraph, so hidden tail words still
  intersect the paragraph's own box; 1px a11y containers lay text out at
  natural size). (2) hidden/transparent ancestors reject outright.
  (3) `elementFromPoint` occlusion — the "…more" button PAINTS OVER laid-out
  text that passes every geometric test. `pointer-events:none` overlays fall
  through the hit-test, so they don't false-positive.

### Geometry and animation

- **Box-lock any element whose text you mutate — exact height, pinned
  width, overflow hidden.** Churn glyphs have different widths: the box can
  rewrap (grow OR shrink a line) and, in shrink-to-fit contexts (HN's table
  cells), resize the whole column. Either way the word moves under a
  stationary cursor and hover engages/disengages in a loop. `min-height`
  alone is half a lock — it stops shrinking but not growth. Pin `height` +
  `width` (+ `box-sizing: border-box` so the pinned width means the measured
  rect) and clip; re-pin at natural size when the PAGE mutates a locked
  element (mutation-observer walk for `__ocBoxLock` ancestors), or the
  "…more" expansion gets clipped.
- **A pinned box goes stale on resize.** Window resize re-pins every locked
  glimmering element at its new natural size — except mid-reveal ones,
  whose current content is the short insight (a re-measure would pin the
  wrong box); those keep their lock until unwind.
- **Gate effects on the TARGET's rect, not its container's.** A tall
  paragraph is "in band" the moment its first line touches the box while
  its last word is still far below it — the glimmer flashed outside the ROI
  until the gate moved to the word's own rect.
- **Hysteresis for anything clickable that animates out.** Start only in
  the core band; stay interactable through a buffered zone (`bufferPct` of
  band height each side); unwind only past the buffer's outer edge. Without
  it, users click text that is mid-animation out of reach.
- **Hard-clamp positional easing; don't trust "remaining scroll".** The
  band's bottom-ease assumed little-scroll-left means page end. Infinite
  feeds ALWAYS have little scroll left — the band rode low chronically on
  reddit. A programmatic floor (centre ≤ 62% viewport) ended the class.
- **Find the active scroller deterministically, never from scroll-event
  targets.** Reddit fires scroll on both window and inner containers; the
  event-target heuristic flip-flopped per event and the band jumped. Walk up
  from a candidate to the nearest viewport-sized scrollable at scan time;
  the larger scroll range (window vs inner) owns the easing.

### Performance (the 1k-comment page is the test)

- **Membership is push-based: IntersectionObserver, not per-frame
  measurement.** IO computes intersections on the compositor and reports
  deltas — far elements cost ZERO main-thread work, and there is no index
  to go stale when images load. Per-frame work is O(near elements): precise
  rects and class writes touch only the IO-maintained `nearSet`. **Never
  add a per-frame loop over `candidates`.**
- **Caching a string is not caching the parse.** The minimap cached its
  marks SVG string but still assigned the whole `svg.innerHTML` per frame —
  Chrome re-parsed ~1k `<rect>`s every frame. Persistent `<g>` layers:
  marks re-parse only on their throttled (~11fps) rebuild, the 4-node
  chrome layer per frame. Marks are also BUCKETED (2px rows, merged runs)
  so the layer is bounded regardless of page size.
- **All reads before all writes inside a frame.** The old tick wrote band
  styles, then read membership rects — one forced synchronous relayout per
  frame, guaranteed. Reads (membership, span rects) now precede writes
  (classes, band layout, minimap). Same class of fix: per-frame
  `clientWidth` / `getComputedStyle` reads moved into throttled paths with
  cached values.
- **Don't let an animation's write cadence interleave frame reads.** The
  boil writes nodeValues every 70ms on its own timer; between our frame
  reads that forced relayout every frame while anything churned during
  scroll. Entering a scroll settles running churns instantly and exits snap
  clean — BUT mark the cut (`burstCut`) and re-fire the burst at settle,
  or the word stays "lit" in state and never visibly glimmers again.
- **Expensive failures need backoff.** A candidate whose target selection
  keeps failing re-ran the tree walk + computed styles + layout-forcing
  hit-tests every frame, forever. Failed walks back off (800ms; 5s for the
  permanent a[href] case); positional deferrals (off-screen) don't.
- **`textContent`, not `innerText`, in loops** — `innerText` forces layout
  per call. `innerText` is right exactly once: extracting the passage for
  the LLM (it excludes hidden text, which `textContent` would leak in).
- **Cheap-state early-outs on hot listeners**: the page-wide `mouseover`
  handler exits before its `closest()` walk when no glimmer is live;
  `updateStats` writes the DOM only when its string changed.

### Product feel

- Glimmer starts are held until scroll settles (`settleOnly`) — the sparkle
  greets the reader when they stop, instead of strobing past. Reverts are
  never held.
- Final-product mode is the default: `debugUi: false` hides every visual
  the extension adds (band, boxes, minimap — native scrollbar returns);
  the debug minimap's full-page index is rebuilt ONLY while debug UI shows.
- LLM output only ever lands via `nodeValue`/`textContent` — no innerHTML,
  no side-effect channel. Same invariant as ambient-context in the main
  repo: worst-case prompt injection is visible text.
- One LLM call in flight (serialised in `insight-client.js`), one call per
  element per session, 3 prefetched below the band so the glimmer is primed
  before the reader arrives. Token counts from the API's `usage` field;
  cost rates are marked estimates.

## Do these learnings apply elsewhere?

Candidates for a later audit pass in the MAIN repo (do not fold in blind —
different surfaces, different constraints; each needs its own verification):

- `integrations/chrome` + `adapters/chrome/v1`: grep hot paths for
  `innerText`, per-keystroke `innerHTML` assignment, and read/write
  interleaving; the clip-chain + occlusion visibility test may strengthen
  field detection; IO-based gating applies if resolution work is ever
  viewport-gated. Chrome's overlay rendering (CSS Custom Highlight API)
  already avoids DOM mutation — the non-destructive rule is for anything
  that DOES touch page DOM (dsh's composer band shares that boundary).
- `OcScramble` came FROM the website artifact kit — the boil recipe is
  already shared; this repo's copy adds the DOM `boil(el)` runner.

## Dev loop

Source of truth: this directory. Chrome loads the mirror at
`/mnt/c/Users/wilfred/AppData/Local/roi-debug/`. After edits:
`node --check <file> && cp -r manifest.json key.js lib content popup icons /mnt/c/.../roi-debug/`, reload at
`chrome://extensions`, **and refresh the page** — an already-open tab's
content script is orphaned by an extension reload and every LLM call from
it fails. `key.js` is gitignored and never committed; the panel can
override the key via `chrome.storage.local`.
