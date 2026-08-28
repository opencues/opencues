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

## Two delivery modes

**Render-only** (Claude Code, Gemini CLI): the buffer commits
**instantly**, exactly as before this feature — the animation lives
entirely in the render pipeline (`RenderDirectives.textOverride`
frames driven by `forceRender()` kicks; never `setText`).

**Real-write** (OpenCode, shell, chrome — hosts whose renderer never
consumed `textOverride`): every frame is committed via a real
`adapter.setText` call, marked through the host's own
source-reclassifier so it's classified `'runtime'` — the same
mechanism `blank-loading.ts`'s per-tick spinner writes already use.
Same scramble/blink/splice logic underneath; the buffer genuinely
holds the scrambled text for the ~440ms (default) transition window
before settling on the clean final text. See
[`docs/architecture/glimmer-realwrite-extension-plan.md`](../architecture/glimmer-realwrite-extension-plan.md)
for the full design + per-host side effects.

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
| OpenCode | animates (real-write) — live-verified via the agentic test harness |
| shell | wired identically to OpenCode (same OpenTUI write path); not yet live-launched in this environment due to an unrelated pre-existing build issue |
| chrome | wired, but **unverified** — chrome's write path is empirically fragile per its own integration docs (`integrations/chrome/CLAUDE.md` § "The biggest issue: writing into managed contenteditables"); needs the real-browser e2e suite + manual multi-site check before this row can say "animates" |

Error substitutes (`[err] …` fills, missing-key fallbacks) never
animate — feedback shouldn't get an arrival flourish.

Implementation: `packages/opencues-runtime/src/modules/glimmer-render.ts`.
Runtime-only knob — not part of the open standard.
