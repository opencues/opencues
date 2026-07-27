# Inline cues — design + implications

> **Status: exploration spike (branch `feat/inline-cues`).** Built to test the
> UX feel on the cleanest surface first. Not shipped; not spec-affecting.

## The idea

A passive cue's advisory (`def.cueTip` — a sentence-cue's calendar-conflict
heads-up, a contradiction cue's weekday-date mismatch) reveals **inline** —
gray text next to the flagged span — the moment the text caret enters that
span, and vanishes when it leaves or the text is edited. The always-dimmed
span is the persistent "there's more here" indicator; the reveal is the
content. This is the "Error Lens" interaction.

## One mechanism, not per-surface alternatives

The design constraint (from the design discussion): **one universal
mechanism + the single existing secondary display as fallback; graceful
degradation, not a menu of per-surface implementations.**

- **Indicator (always on):** the flagged span is dimmed. Pure styling of
  buffer characters via the existing `RenderDirectives.dimRanges` channel —
  works on every host that can paint dim, no new concept.
- **Reveal (cursor-gated):** the advisory text is shown inline. This needs a
  surface that can render *text that isn't in the buffer*.

The reveal degrades — it does not fork into alternatives:

| Surface | Reveal path |
|---|---|
| Terminal (CC/OC/shell/gemini) | Splice gray text into the RENDERED string (display-only; never the submit buffer). **Reference implementation.** |
| Chrome contenteditable | Dim works; inline text reveal is reconciler-sensitive — design follow-up. |
| Chrome normal `<input>` / no paint surface | Degrade to the secondary display (status line) — the pre-existing behaviour. |

The per-host *painting* difference (ANSI vs CSS) is the same split every
existing directive already has (`dimRanges`, `highlight`); it is not a new UX
alternative.

## Why the render-directive channel, not the substitute channel

The inspiration was the `[notification]` inline-error, which is a **buffer
substitute** (`alternatives: ['_', text]`) — real buffer text, and therefore
submit-exposed. The whole point of inline cues is to move that class of
ephemeral inline text **out of the buffer** into a decoration that is:

- **display-only** — the note lives in what the host paints, alongside the
  ANSI/CSS the render channel already inserts, never in `iz.text` (the submit
  buffer). Proven by the fact that ANSI codes ride the same return value and
  are never submitted.
- **cursor-gated** — appears only while the caret is in the span, so it can't
  be present at submit time.

## The load-bearing constraint

`RenderDirectives.dimRanges` / `highlight` can only **style existing buffer
characters** — they cannot *inject* text. Injecting text-not-in-the-buffer is:

- **easy on terminals** — the runtime owns the painted string, so we append a
  gray line (`InlineNote`). This is why the terminal is the honest reference
  surface.
- **hard in chrome managed editors** — CSS Custom Highlight styles ranges but
  can't add text; injecting a decoration node gets reverted by the
  Lexical/PM/Quill reconciler. The realistic chrome reveal is a floating
  overlay (new UI — needs sign-off) or degrade-to-secondary.

## Implementation (terminal reference)

- **`RenderDirectives.inlineNote?: InlineNote`** (`adapter.ts`) — `{ spanStart,
  spanEnd, text }`, spans in the host's painted (`ctx.text`) coordinate space.
- **`DimRender.compute`** (`dim-render.ts`) — after computing dim/highlight,
  when `inline-cues-mode: inline`, the host has `dim-ranges` capability, and
  `ctx.cursor` sits inside a live passive-cue def's span (a def with
  `cueTip`, passing the `defSpanLive` staleness guard), emits `inlineNote`.
  The span is mapped logical→painted before the containment test so soft-wrap
  hosts (CC) test the caret in the right space.
- **`applyDirectives`** (`render-directives.ts`) — appends the note as a dim
  line (`\n\x1b[2m…\x1b[22m`) after the painted body. Display-only.
- **`Statusline.buildPayload`** (`statusline.ts`) — suppresses the redundant
  status-line copy of `def.cueTip` when inline mode is active AND the host can
  paint (dim-ranges cap). On a non-painting host it keeps the status-line copy
  — automatic degradation to secondary.
- **`inline-cues-mode`** — FEATURES registry entry + typed `OpenCuesState`
  field (`inlineCuesMode: 'inline' | 'secondary'`, default `inline`).

## Open questions (before hardening)

1. **Placement.** ✅ The note renders on the line directly BELOW the span,
   indented to the span's column (computed in painted coords in
   `applyDirectives`). Below-the-whole-buffer was rejected — it drifts far from
   the span in a long doc. Remaining nuance: a subsequent render handler's
   ranges could shift because the note adds visible chars mid-string (only
   DimRender emits the note today, so its own ranges are safe — see the comment
   in `applyDirectives`).
2. **Reveal trigger fidelity.** Terminal hosts re-render on caret-only moves
   (arrow keys) via the key-dispatch → `applyRender` path, so `ctx.cursor` is
   fresh. Confirm no host paints a stale cursor.
3. **Chrome reveal.** Overlay vs degrade-to-secondary — overlay is new UI and
   needs explicit sign-off.
4. **Multiple overlapping advisories.** v1 reveals the first def whose span
   contains the caret; passive cues rarely overlap, but define precedence
   (priority?) if they do.
