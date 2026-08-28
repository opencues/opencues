# Glimmer Transition (`glimmer-transition-ms`)

The arrival animation. When a substitution **lands** — a fluid-blank
answer, a transform-blank rewrite, a keyword blank fill — the landed
span blinks, then churns through confusable glyphs into the final text
instead of swapping between two frames. The loading animation
([blank-loading](blank-loading.md)) covers the *wait*; the glimmer
covers the *arrival*.

```
# ~/.cues/OPENCUES.md
glimmer-transition-ms: 300   # default — a subtle flicker as the answer settles
glimmer-transition-ms: 600   # a clear scramble-and-settle decode
glimmer-transition-ms: 900   # the full slow decode
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

## Display-only, by construction

The buffer commits **instantly**, exactly as before this feature —
the animation lives entirely in the render pipeline
(`RenderDirectives.textOverride` frames driven by `forceRender()`
kicks; never `setText`). Consequences you can rely on:

- Submitting mid-animation submits the **final** text — the buffer
  never contains a scrambled frame.
- Editing mid-animation wins instantly: the moment the landed text is
  no longer verbatim in the buffer, the transition self-cancels.
- No background machinery notices the frames: no resolver re-dispatch,
  no AgentRewrite debounce reset, no config hot-reload churn.

## Host support

| Host | Behaviour |
|---|---|
| Claude Code | animates |
| Gemini CLI | animates |
| OpenCode / shell / chrome | instant swap (their renderers don't paint `textOverride` yet; wiring is in place, so a renderer pickup needs no boot change) |

Error substitutes (`[err] …` fills, missing-key fallbacks) never
animate — feedback shouldn't get an arrival flourish.

⚠️ **Extending this to OpenCode/shell/chrome** would mean switching from
render-only `textOverride` to real per-frame `setText` writes (the model
`blank-loading` already proves works) — a materially different design with
real per-host side effects and open risks (AgentRewrite debounce
interaction, editor-reconciler fighting on Chrome). See
[`docs/architecture/glimmer-realwrite-extension-plan.md`](../architecture/glimmer-realwrite-extension-plan.md)
before starting that work.

Implementation: `packages/opencues-runtime/src/modules/glimmer-render.ts`.
Runtime-only knob — not part of the open standard.
