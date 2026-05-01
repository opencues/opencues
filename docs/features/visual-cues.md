---
last_updated: 2026-04-06
---

# Visual Cues

Visual cues are the styling changes applied to words in the input to indicate whether they are interactive. Every word exists in one of three visual states: normal, dimmed, or highlighted. Dimming tells the user a word has alternatives or is otherwise navigable; highlighting shows which word is currently selected for cycling.

---

## How It Works

1. **Render pass**: On every render, the integration strips existing ANSI codes from the input to get clean text, splits on whitespace to get a word list, then iterates character-by-character to apply styling
2. **Dim pass**: For each word, the system checks whether it should be dimmed (see What Gets Dimmed below). Dimmed words are collected into `_numRanges` — an array of `{start, end}` character ranges
3. **Highlight pass**: The highlight range (`_hlStart`, `_hlEnd`) covers the focused word and any span words (via `spanLength`). Linked words are NOT visually highlighted together — they share cycling behaviour but are rendered independently
4. **Character loop**: Each character in the rendered value is checked against the ranges. If inside a highlight range, highlight styling is applied. If inside a dim range, dim styling is applied. Otherwise, the original styling passes through
5. **External highlights**: Words that have external highlights (e.g., shimmer effects from the host editor) are excluded from both dim and highlight overrides to avoid conflicts

---

## What Gets Dimmed

A word at index `_ni` is added to `_numRanges` (and therefore dimmed) if any of the following conditions are true and it is not the currently highlighted word:

| Condition | Check | Source |
|-----------|-------|--------|
| **Cue-blank keyword** | `blanksByWord.has(_w.toLowerCase())` — word is a registered blank keyword | `writeDynamicRendering` |
| **Tip word** | `globalThis._localCueMap.has(_w.toLowerCase())` — word exists in the local cue map (case-insensitive). Checked directly in the render loop for instant dimming without waiting for the analysis pipeline | `writeDynamicRendering` |
| **Dynamic alternative** | `_dynDef` found where `d.alts.length > 1 && d.alts.indexOf(_w) >= 0` — the LLM returned multiple alternatives and the current word is among them | `writeDynamicRendering` |
| **Cue-blank value** (1-alt exception) | `d.metadata && d.metadata.blankName` — dimmed even when `alts.length` is 0 or 1. The only case where a word with fewer than 2 alternatives gets dimmed | `writeDynamicRendering` |
| **Span member** | `globalThis._dynSpans[_ni]` is set — the word is part of a multi-word span (e.g., "Bezos" in "Jeff Bezos"). Excluded if the span is currently highlighted (`_spanInfo.originalIndex === _hlWordIdx`) | `writeDynamicRendering` |

---

## Rendering

Styling is applied per-character using raw ANSI escape codes. Each code starts with `\x1b[0m` (reset) to clear any prior styling and prevent leaks between adjacent characters.

### Dim

```
\x1b[0m\x1b[90m  +  char  +  \x1b[0m
```

SGR 90 is dark gray foreground. All dimmed words use this single style regardless of their dim reason (tip, blank, span member, etc.).

### Highlight

The highlight color is configurable. Default is bold bright white:

| Color | ANSI sequence | SGR codes |
|-------|---------------|-----------|
| white (default) | `\x1b[0m\x1b[1;97m` | bold + bright white |
| cyan | `\x1b[0m\x1b[1;96m` | bold + bright cyan |
| yellow | `\x1b[0m\x1b[1;93m` | bold + bright yellow |
| inverse | `\x1b[0m\x1b[7m` | reverse video |
| underline | `\x1b[0m\x1b[4m` | underline |

When a highlighted word is part of a multi-word span (`spanLength > 1`), the highlight range extends across all words in the span.

### Precedence

The character loop applies styles in this order:

1. **Inverse mode** (`\x1b[7m` active) — pass through unchanged (cursor styling)
2. **Highlight** — if character is in `[_hlStart, _hlEnd)`, apply highlight color
3. **Dim** — if character is in any `_numRanges` entry, apply dim
4. **Normal** — pass through original styling

---

## Portability

### Standard (opencues-core)

- `WordDef.alts` length determines whether a word is navigable (dimmed vs. normal)
- `metadata.blankName` identifies cue-blank values, which are dimmed even with only 1 alt (the 1-alt exception)
- Linked word indices (`CueResult.linked`) define which words share cycling behaviour (they are not visually highlighted together)
- The three visual states (normal, dimmed, highlighted) are defined by the standard; rendering is not

### Integration responsibilities

- Render the three visual states using platform-appropriate styling (ANSI codes, CSS classes, editor decorations, etc.)
- Apply dimmed state to all words where `alts.length > 1`, plus cue-blank keywords, tip words, cue-blank values, and span members
- Apply highlighted state to the currently focused word and any span words (linked words share cycling but are rendered independently)
- Update visual states in real time as the user navigates and as new analysis results arrive
- Respect external highlight regions (e.g., host editor shimmer) by skipping visual overrides for those words
- Ensure styling does not interfere with the editor's own syntax highlighting or theme
