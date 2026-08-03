# Inline AskUserQuestion UI — rendering notes

How the tool-prompt cue (`ask-cues-mode`, `ToolPromptCueSource`) renders its
question + options. Two phases: **single-line (shipped)** and **multi-line
(designed, not built)**.

## Phase 1 — single line (SHIPPED)

The whole AQT result rides in ONE tip line via the existing inline-note /
statusline channel — **no render-contract change, no painter change**. Built in
`renderSingleLineTip()` (`packages/opencues-core/src/sources/tool-prompt-source.ts`):

```
❓ Evidence — Do you want to substantiate the speed claim wi…  ▸ Add data · Qualify · Keep as is°
```

- `❓ <header> — <question>` then `▸ <opt> · <opt> · <opt>`.
- **Options are kept in full; the question is truncated** to the remaining
  budget (`SINGLE_LINE_TIP_MAX = 96`) — the options are the actionable part.
- A trailing `°` marks an **advisory** option (no `apply`; cycling to it leaves
  the sentence unchanged). Options with an `apply` rewrite the sentence.
- Cycling (Ctrl+Alt+↑/↓) walks `alternatives = [original, ...applies]`; the
  buffer shows the current rewrite, the statusline shows the `(i/N)` position.

Limitation: the single tip line is **static** — it shows the question + all
labels, but not which option is currently selected (that's conveyed by the
buffer content + the `(i/N)` counter, since `WordDef` carries only a static
`cueTip`, not per-alternative tips wired onto the def).

## Phase 2 — multiple lines (DESIGNED, NOT BUILT)

Goal: show the question + **all option rows at once**, with the current row
marked — a real "card" where the host can paint one, a stacked list where it
can't. The structured `toolQuestion` is already stashed on the cue's
`metadata.toolQuestion` for exactly this.

### Align with the real tool's `preview` field

The genuine AskUserQuestion tool (Agent SDK docs) already has the concept we
want for the card: an optional per-option **`preview`** — a visual mockup shown
alongside the label — set via `toolConfig.askUserQuestion.previewFormat`
(`"markdown"` = ASCII art / fenced code, `"html"` = a styled `<div>`), included
only on options where a visual comparison helps. Phase 2 should mirror that:
each option carries an optional `preview`, rendered in the card body (Chrome can
paint the `html` form directly in its overlay div; CC/OpenTUI render the
`markdown`/plain form as stacked lines). Our `apply` (the concrete rewrite text)
is a separate OpenCues extension — it's what a pick DOES, whereas `preview` is
what a pick would LOOK like.

### The one shared change: widen the note contract

Today `InlineNote` (`packages/opencues-runtime/src/adapter.ts:95-99`) carries a
single `text` string, and `inlineNoteText(def)`
(`packages/opencues-runtime/src/state/dyn-defs.ts:67`) returns only
`def.cueTip`. The minimal widening:

1. Add optional structured fields to `InlineNote`:
   `question?: string` + `options?: { label: string; description?: string; preview?: string; current?: boolean }[]`
   (mirroring the real tool's `{ label, description, preview }`).
2. Carry the structured question on the `WordDef` (from
   `CueResult.metadata.toolQuestion` at registration in `resolver.ts`), and in
   `dim-render.ts` (~line 374) populate the new `InlineNote` fields from it +
   the def's `currentIndex` (to flag the `current` row).
3. Every host already advertises the `inline-note` capability and gates on
   `inline-cues-mode: inline`, so **no capability plumbing changes** — only the
   payload + the per-host painters.

### Per-host painters (they differ a lot)

| Host | Surface | Multi-line render |
|---|---|---|
| **Chrome** | real span-anchored overlay `<div>` (`integrations/chrome/src/runtime-renderer.ts` — `ensureNoteEl`, `renderInlineNote` ~L436, already does push-down `PushMode`) | **Faithful card**: replace the single `textContent` with option `<div>` rows (label + dim description), the `current` row marked. This is the only host that gets a real boxed card. Contenteditable only; plain `<input>`/`<textarea>` has no paint surface → secondary. |
| **CC** | ANSI only: buffer highlight + ONE line spliced under the span (`packages/opencues-runtime/src/render-directives.ts:210-239`) + one-line statusline | **Stacked gray lines**: join `options` into a multi-line `text` AND teach the terminal painter to pad EVERY line to the span column — today only line 1 is padded (`render-directives.ts:236-238`). No box, no colour rows; gray stacked list. |
| **Shell / OpenCode** | OpenTUI: float a single absolute overlay line below the span (`integrations/shell/src/bootstrap.ts:739-755`; `adapters/oc/v1.14/boot.ts:359`) | Either float N lines (reserve N blank buffer lines instead of 1) or host an OpenTUI box renderable. Closer to CC than Chrome. |

### Interaction

- Keep the current cycling (Ctrl+Alt+↑/↓) to move the `current` row; Enter/→
  applies (splices `apply`). Advisory rows are selectable but no-op the buffer.
- The card is passive: ignore it and keep typing — never a blocking modal.

### Why deferred

The single-line version reuses the note channel with zero cross-host risk; the
multi-line version touches the render contract + 3 painters and can't be
visually verified without each live host. Ship + feel the single line first;
promote to multi-line (Chrome card first — smallest real payoff) when the
interaction is proven worth it.
