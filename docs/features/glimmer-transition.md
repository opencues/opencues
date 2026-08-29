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

Both modes give the same guarantees:

- Submitting mid-animation submits the **final** text — real-write
  mode explicitly restores the clean final text on cancel (a fast
  re-summon, dispose, or the transition settling), so there's no
  window where a scrambled frame could be submitted.
- Editing mid-animation wins instantly: the moment the landed text is
  no longer verbatim in the buffer, the transition self-cancels.
- No background machinery mistakes the frames for user input: no
  resolver re-dispatch, no AgentRewrite debounce reset, no config
  hot-reload churn — real-write mode's reclassifier marking is what
  extends this guarantee to hosts that actually touch the buffer.

## Host support

| Host | Behaviour |
|---|---|
| Claude Code | animates (render-only) |
| Gemini CLI | animates (render-only) |
| OpenCode | animates (render-only display overlay, runtime 0.37.0 — buffer never holds a scrambled frame; band pin: `adapters/oc/v1.14/boot.test.ts`). Overlay painting NOT yet live-verified — the prior real-write mode was, and its machinery stays until this is. |
| shell | animates (render-only display overlay, runtime 0.37.0 — same contract + pin as OC, `adapters/shell/v1/boot.test.ts`). Overlay painting NOT yet live-verified. |
| chrome | animates (**host-owned** — a third delivery mode): the runtime delegates the whole transition via `GlimmerRenderOptions.playHostAnimation` to a CSS Custom Highlight API engine (`integrations/chrome/src/highlight-glimmer.ts`) that restyles glyphs — displacement swaps behind the same blink + 45/30/15 easing recipe — without ever writing the text DOM. Real-write mode remains hard-disabled there (it froze Gmail tabs — O(field) DOM walking per frame; see `CHANGELOG.md`); the Highlight engine is the structural replacement, not a tuned retry. Un-scrambled churn characters show the real final glyphs, matching the family look; the one irreducible difference is displacement of real glyphs rather than confusable-glyph substitution (the Highlight API cannot change which character renders). |

Error substitutes (`[err] …` fills, missing-key fallbacks) never
animate — feedback shouldn't get an arrival flourish.

Implementation: `packages/opencues-runtime/src/modules/glimmer-render.ts`.
Runtime-only knob — not part of the open standard.
