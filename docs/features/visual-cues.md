---
last_updated: 2026-07-04
---

# Visual Cues

Visual cues are the styling changes applied to words in the input to indicate whether they are interactive. Every word exists in one of three visual states: normal, dimmed, or highlighted. Dimming tells the user a word has alternatives or is otherwise navigable; highlighting shows which word is currently selected for cycling.

---

## How It Works

Implemented by the `DimRender` module (`packages/opencues-runtime/src/modules/dim-render.ts`), which computes a set of dim ranges plus (at most) one highlight range, expressed as a `RenderDirectives` object the host applies over its own already-rendered text.

1. **Compute dim ranges**: for every word that's navigable (same cueMap/DynDef rule Navigation uses) and isn't the currently-highlighted word or inside an active span/selector/satellite block, add its character range to `dimRanges`. Multi-word spans emit one range covering the whole span, not one per word.
2. **Compute the highlight range**: if a word is highlighted (`HighlightState.active`), its range — extended across the whole span if it's part of one, or across both halves if it's an active selector/satellite pair — becomes the single highlight range.
3. **Host applies directives**: `packages/opencues-runtime/src/render-directives.ts`'s `applyRenderDirectives` walks the host's already-ANSI-rendered string character-by-character, distinguishing visible chars from existing escape sequences, and inserts the dim/highlight ANSI codes at the directive boundaries. Existing ANSI codes (the host's own syntax highlighting) are preserved.

---

## What Gets Dimmed

A word is dimmed if it's navigable per the same rule `Navigation.computeTargets()` uses (cueMap match, or a `DynDef` entry — LLM alternatives, blank-fill value, span member), it isn't the highlighted word, and it isn't inside the currently-active span/selector/satellite block (those get one whole-region highlight instead of per-word dim, so they don't look like random word-fading). A few refinements on top:

- **Multi-word spans** — each span's *origin* emits one dim range covering the whole span; inner positions don't get their own range.
- **CJK / spaceless substitutes** — when a def carries a live-matching character span (`spanStart`/`spanEnd`), that's used instead of the word-derived range, so a spaceless CJK substitute (fewer whitespace-tokens than characters) dims completely rather than partially. A stale span (buffer edited, def not yet cleared) is skipped rather than painted over new text.
- **Bare blank keywords are gated** — a word that's ONLY a blank keyword (not also a word-cue match or `## Tips` entry) doesn't dim until `_` is nearby. Otherwise every prose mention of "volume" or "bitcoin" would falsely suggest it's interactive when no `_` is in play.

---

## Rendering

Two ANSI attribute pairs (`packages/opencues-runtime/src/render-directives.ts`), not per-color escape codes:

### Dim

```
\x1b[2m  (dim attribute ON)  ...  \x1b[22m  (normal intensity, OFF)
```

This dims via the terminal's own "faint" SGR attribute, not a specific gray foreground color — so it composes with whatever foreground color the host's own syntax highlighting already applied.

### Highlight

```
\x1b[97m  (bright white foreground ON)  ...  \x1b[39m  (default foreground, OFF)
```

Deliberately a foreground-color change, not inverse video (`\x1b[7m`) — inverse washed out the dim layer underneath on some terminals; bright-white-on-dim reads better. There is no user-configurable highlight color today (no scalar for it in `feature-registry.ts` — the closest related knob, `dim-mix`, is a chrome-only CSS blend-strength setting for the browser integration, not an ANSI color choice).

Markdown-styled ranges (bold/italic/code-span/strikethrough/headings, emitted by TransformBlank's markdown-aware substitution) use their own separate ANSI pairs layered independently of the dim/highlight logic above.

---

## Portability

### Standard (opencues-core)

- `CueResult.alternatives` length and `metadata.blankName` together determine whether a word is navigable/dimmable (same signal `Navigation` and `DimRender` both key off)
- The three visual states (normal, dimmed, highlighted) are a runtime-layer concept — opencues-core classifies words, it doesn't decide how they're painted

### Integration responsibilities

- Implement `applyRenderDirectives`-equivalent logic, or supply the primitives (`onRender` hook applying dim/highlight ranges) the shared runtime's `DimRender` calls into
- Render the three visual states using platform-appropriate styling (ANSI codes, CSS classes, editor decorations, etc.)
- Update visual states in real time as the user navigates and as new analysis results arrive
- Ensure styling does not interfere with the editor's own syntax highlighting or theme — the shared runtime's approach (dim = brightness attribute, highlight = foreground color swap) is designed to compose with existing colors rather than reset them
