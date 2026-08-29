# Plan: display-only glimmer for OpenCode + shell (retiring real-write)

Status: IMPLEMENTED + LIVE-VERIFIED on both hosts (2026-08-29,
manual). Sequencing step 3 (deleting glimmer-render.ts's write-mode
machinery + its tests) is now unblocked and remains the one open
follow-up. Original plan below, kept as the design record.

## Why

Glimmer has three delivery tiers today; two are display-only:

| Host | Mechanism | Buffer during animation |
|---|---|---|
| CC / Gemini | `RenderDirectives.textOverride` (patched paint / React render) | final text, always |
| chrome | host-owned CSS Highlight engine | final text, always |
| **OC / shell** | **real-write** — every 70ms frame committed via `adapter.setText` | **genuinely scrambled** |

Real-write works on the TUIs (live-verified), but it is the worse
architecture: every frame is a real buffer mutation that must be
reclassified (`markRuntimeWrite`) so BlankFill / AgentRewrite /
ConfigLoader ignore it; OpenTUI's `editBuffer.setText` nukes every
extmark, forcing the band to repaint them; a submit or crash mid-frame
races the restore; and the chrome incident showed the whole class of
"write echo misclassified" bugs that this mechanism carries wherever
write costs or latencies grow. Retiring it deletes those obligations
rather than managing them.

## The seam already exists: the renderAfter cell overlay

Neither OC nor shell needs OpenTUI's internals patched. Both hosts
already paint display-only CELLS over/around the textarea for the
inline cue note:

- shell: `integrations/shell/src/app.tsx` — `renderAfter` hook, fed by
  `bootstrap.ts`'s directive pass (`bootResult.collectRenderDirectives`
  runs on every repaint and turns directives into extmarks + the note
  anchor).
- OC: `integrations/opencode/patches/opencuesBootstrap.ts` —
  `attachInlineNoteRenderer`'s `renderAfter` (same pattern; the band is
  a near-clone).

That hook draws arbitrary glyphs at arbitrary viewport cells AFTER the
textarea has painted — which is precisely a textOverride, expressed as
an overlay. The runtime side needs zero new concepts: render-only
glimmer already emits whole-string `textOverride` via the existing
`onRender` → `collectRenderDirectives` path and drives repaints with
bare `adapter.forceRender()` kicks (the CC/Gemini contract).

## The design

1. **Runtime: nothing new.** Stop passing `glimmerRealWrite` in the
   OC/shell boots; the shared `buildSharedRuntime` then registers the
   render-only handler (exactly the CC/Gemini branch — the code
   already does this when `glimmerRealWrite` is absent). The bands
   must implement `forceRender` bindings as "kick the directive
   repaint pass" (both already have an equivalent for extmark
   repaints).
2. **Band: consume `textOverride` as an overlay diff.** In the
   directive pass, when `directives.textOverride` is present:
   - Diff override vs the true text (they differ ONLY inside the
     animated span — blink/scramble are 1:1 length-preserving, the
     load-bearing invariant `glimmer-render.ts` already documents).
   - Map the differing char range to viewport cells (wrap- and
     scroll-aware). The math exists: the note anchor already computes
     visual row + cell column (`inlineNoteBoxColumn`, `visualCursor`);
     wide glyphs (CJK = 2 cells) must reuse the same width accounting.
   - Paint the override glyphs at those cells in `renderAfter`, in the
     textarea's own fg/bg so it reads as the text itself, not a badge.
3. **Cursor**: leave it alone. The buffer never changes, so the caret
   sits at its true position; if the caret cell falls inside the
   overlay, paint the override glyph and let OpenTUI's cursor layer
   composite as it does over the note today (verify — see risks).
4. **Cancel/settle**: unchanged runtime semantics. `getTextOverride`
   returns null once settled/cancelled → the band paints no overlay →
   the true (final) text shows. The restore write, the reclassifier
   marking, and the extmark-wipe handling for glimmer frames are all
   simply deleted.
5. **Keep real-write code for blank-loading.** The loading spinner on
   OC/shell also real-writes today; it can migrate to the same overlay
   LATER but is out of scope — glimmer first, one mechanism per PR.

## Risks / verify-first list

- **Cell math at wraps**: an animated span crossing a soft-wrap
  boundary spans two visual rows; the diff region must be split per
  row. The note only ever draws one row — this is the main new code.
- **Scrolled viewports**: span partially above/below the visible
  window → clip the overlay to the viewport (note math already knows
  the visual row; clamp).
- **Cursor compositing**: confirm OpenTUI paints its cursor after
  `renderAfter` (else the caret vanishes inside the overlay for the
  animation's duration — cosmetic, but check).
- **NBSP/ZWS tricks**: shell's auto-select highlight uses an NBSP
  sentinel (`bootstrap.ts` ~line 259); confirm the diff region can't
  land on it (it sits outside substituted spans, but verify with a
  scenario test).
- **forceRender cost**: 14 kicks/sec of full extmark-diff repaint —
  measure; if heavy, the kick can repaint ONLY the overlay when the
  only change is a glimmer frame.

## Test plan

- Band scenario tests (the repo's preferred shape): type → summon →
  substitution lands → assert buffer holds FINAL text at every tick
  while `collectRenderDirectives` returns override frames → settle →
  no override. Pin "buffer never contains a scrambled frame" — the
  property real-write could never offer.
- Agentic harness runs on OC and shell (the June 2026 lesson: Bun
  hosts break in ways Node unit tests can't see).
- Delete-side assertions: no `markRuntimeWrite` calls originate from
  glimmer on these hosts anymore (grep-level or spy-level pin).

## Sequencing

1. shell first — we own the whole host, fastest iteration, and its
   band is the template OC's clone follows.
2. OC second — port the band diff; the fork patch gains the overlay
   consumption in `opencuesBootstrap.ts`.
3. Only after both are live-verified: delete `glimmerRealWrite` from
   `BuildSharedRuntimeOptions` + the write-mode branch in
   `glimmer-render.ts` (and its tests), and update
   `docs/features/glimmer-transition.md`'s host table. Until then the
   write mode stays as the fallback.
