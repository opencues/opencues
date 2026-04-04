---
last_updated: 2026-04-04
---

# Cycling — Claude Code

Implements features [2](../../../docs/features/cycling.md), [5](../../../docs/features/linked-words.md), [9](../../../docs/features/multi-word-spans.md), [10](../../../docs/features/per-word-clearing.md). See those docs for the concepts.

**Patch files:** `patches/wordHighlight.ts` (number fallback, rendering), `patches/dynamicHighlight.ts` (all cycling via `_cycleAlt`, cue-controls, LLM alts, spans, clearing)

## CC-Specific: Cycling Priority Implementation

All cycling goes through the shared `_cycleAlt(dir)` function in `dynamicHighlight.ts`, checked in order:

1. **Cue-control (custom)** → spawn `~/.claude/actions/{control}.sh`, return
2. **Cue-control (number)** → increment/decrement with `originalNumbers` map, return
3. **Dynamic alts** → cycle `_dynDefs.words[i].alts`
4. **Tip-lookup fallback** → if word is in `_localCueMap` but not in `_dynDefs`, resolve alts on-the-fly from tips and populate `_dynDefs` (covers cases where eager lookup was skipped, e.g., during pending LLM calls)
5. **Fall through** → no action

`_isCueControl(word)` is the unified check for both types. It's used by the tips lookup and status line export to exclude cue-controls from tips/alts display.

## CC-Specific: State Export on Cycle

The highlight export JSON is written directly inside `_cycleAlt` (not just in the input handler) to ensure `currentAltIndex` is fresh for the status line.

## CC-Specific: Linked Word Sources

- **LLM-detected** links via linked words prompt (stored in `_dynDefs.words[i].linked`)

## CC-Specific: Span Tracking

`_dynSpans` globalThis map tracks multi-word replacements. Updated in `_cycleAlt` after each replacement.

## CC-Specific: Clearing Implementation

Rendering checks `alts.indexOf(word) >= 0` — a word is only dimmed if it matches an entry in its alts array. Navigation uses the same check but with two fallbacks to stay in sync with rendering:

1. **Case-insensitive matching** — if `alts.indexOf(w)` fails (exact match), falls back to `alts.some(a => a.toLowerCase() === w.toLowerCase())`. Handles LLM returning capitalized alts for lowercase words.
2. **Span-aware navigation** — words that are part of a multi-word span (`_isInSpan`) are navigable, matching the render's dim behavior for spans.

This ensures any word that dims is also navigable — no dimmed-but-unreachable words.

## Related

- `navigation.md` — keybindings and rendering
- `alternatives.md` — how alternatives are generated
- `config.md` — all config options
