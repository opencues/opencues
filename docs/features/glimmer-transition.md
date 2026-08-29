# Glimmer Transition (`glimmer-transition-ms`)

The arrival animation. When a substitution **lands** — a fluid-blank
answer, a transform-blank rewrite, a keyword blank fill — the landed
span blinks, then churns through confusable glyphs into the final text
instead of swapping between two frames. The loading animation
([blank-loading](blank-loading.md)) covers the *wait*; the glimmer
covers the *arrival*.

```
# ~/.cues/OPENCUES.md
glimmer-transition-ms: 900   # default — the full slow decode
glimmer-transition-ms: 600   # a clear scramble-and-settle decode
glimmer-transition-ms: 300   # a subtle flicker as the answer settles
glimmer-transition-ms: 1500  # extended — a long, deliberate decode
glimmer-transition-ms: off   # instant swap (pre-feature behaviour)
```

One shared setting — all three landing sites (fluid-blank,
transform-blank, keyword blank fills) read the same scalar. Cyclable
from the settings menu (Appearance group); hot-reloads on file edit.

## What it looks like

```
capital of france _        ← you summon
capital of france ⠈        ← blank-loading animates the wait
                           ← answer lands (buffer now holds "Paris")
_____                      ← blink: the span pulses blank for ~140ms
Pcr1s → Par!s → Paris      ← churn: glyphs settle over the window
```

A character only ever swaps within its own *confusable group*
(`l i . : |` together, `Z Y $ S B X` together, …) so the churn reads as
the text **decoding** into place, not random noise. The scramble table
is ported from the Glimmer extension prototype
(`experiments/roi-debug/lib/scramble.js`).

For transform-blank's whole-buffer rewrites, only the **changed
region** glimmers — a prefix/suffix diff of what you saw against what
landed keeps every untouched word rock-steady.

## Two delivery modes

**Render-only** (Claude Code, Gemini CLI): the buffer commits
**instantly**, exactly as before this feature — the animation lives
entirely in the render pipeline (`RenderDirectives.textOverride`
frames driven by `forceRender()` kicks; never `setText`).

**Render-only via display overlay** (OpenCode, shell — as of runtime
0.37.0): the same `textOverride` frames flow out through
`collectRenderDirectives`, and the host bootstrap diffs each frame
against the true text and floats the scrambled slice as an
absolute-positioned overlay box over the textarea (the inline-note
overlay pattern generalized). The buffer NEVER holds a scrambled
frame. Overlay geometry is cursor-anchored (OpenTUI exposes no
offset→visual API), so a span that wraps, sits on another line than
the caret, or whose line exceeds the pane width simply doesn't paint —
the real final text shows, the same graceful give-up chrome's engine
uses. The earlier real-write mode (every frame committed via
`adapter.setText`, reclassifier-marked) is retired on both bands but
its runtime machinery remains until this ships live-verified; design +
sequencing: [`docs/architecture/glimmer-opentui-overlay-plan.md`](../architecture/glimmer-opentui-overlay-plan.md).

All delivery modes give the same guarantees, resting on one invariant:
**the buffer holds the final landed text for the entire animation** —
the scramble is pure display (a painted override on CC/Gemini, an
overlay box on OC/shell, a Highlight-API restyle on chrome). Nothing
ever needs restoring, because nothing was ever dirty.

- **Interrupting the animation (typing into it) yields the final text
  plus your edit, instantly.** Your keystroke lands in the real buffer
  — which already contains the full answer — exactly where you typed
  it, and the transition self-cancels the moment the landed text is no
  longer verbatim present. What you see after the very next frame is
  the finished answer with your edit applied: no scrambled residue, no
  lost keystroke, no waiting out the animation. (Chrome pins the
  cancel-releases-everything half in `glimmer-engine.pw.test.ts`; the
  runtime pins self-cancel in `glimmer-render.test.ts`.)
- Submitting mid-animation submits the **final** text — same invariant;
  there is no window in which a scrambled frame exists anywhere a
  submit could read from.
- No background machinery mistakes animation frames for user input: no
  resolver re-dispatch, no AgentRewrite debounce reset, no config
  hot-reload churn — trivially true now that no mode writes the buffer.
  (The retired real-write mode achieved this via reclassifier marking;
  that machinery lives on only as unreferenced code pending deletion.)

## Host support

| Host | Behaviour |
|---|---|
| Claude Code | animates (render-only) |
| Gemini CLI | animates (render-only) |
| OpenCode | animates (render-only display overlay, runtime 0.37.0 — buffer never holds a scrambled frame; band pin: `adapters/oc/v1.14/boot.test.ts`). Live-verified 2026-08-29 (manual, real fork). |
| shell | animates (render-only display overlay, runtime 0.37.0 — same contract + pin as OC, `adapters/shell/v1/boot.test.ts`). Live-verified 2026-08-29 (manual, oc-shell). |
| chrome | animates (**host-owned** — a third delivery mode): the runtime delegates the whole transition via `GlimmerRenderOptions.playHostAnimation` to a CSS Custom Highlight API engine (`integrations/chrome/src/highlight-glimmer.ts`) that restyles glyphs — displacement swaps behind the same blink + 45/30/15 easing recipe — without ever writing the text DOM. Real-write mode remains hard-disabled there (it froze Gmail tabs — O(field) DOM walking per frame; see `CHANGELOG.md`); the Highlight engine is the structural replacement, not a tuned retry. Un-scrambled churn characters show the real final glyphs, matching the family look; the one irreducible difference is displacement of real glyphs rather than confusable-glyph substitution (the Highlight API cannot change which character renders). |

Error substitutes (`[err] …` fills, missing-key fallbacks) never
animate — feedback shouldn't get an arrival flourish.

Implementation: `packages/opencues-runtime/src/modules/glimmer-render.ts`.
Runtime-only knob — not part of the open standard.
