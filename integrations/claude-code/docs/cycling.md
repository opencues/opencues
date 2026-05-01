---
last_updated: 2026-04-07
---

# Cycling — Claude Code

Implements features [2](../../../docs/features/cycling.md), [5](../../../docs/features/linked-words.md), [9](../../../docs/features/multi-word-spans.md), [10](../../../docs/features/per-word-clearing.md). See those docs for the concepts.

**Patch files:** `patches/wordHighlight.ts` (rendering, delegates Up/Down to `_cycleAlt`), `patches/dynamicHighlight.ts` (all cycling via `_cycleAlt`, cue-blanks, LLM alts, spans, clearing)

## CC-Specific: Cycling Priority Implementation

All cycling goes through the shared `_cycleAlt(dir)` function in `dynamicHighlight.ts`, checked in order:

1. **Cue-blank values** (`metadata.blankName`) → call `blankInvoke({ action: 'up'|'down' })`, then `blankInvoke({ action: 'get' })` for the new value, return (skipped for list blanks with `stepValues` or multi-line output — those go through step 3)
2. **Consume-all alts** → cycle `_consumeAllAlts` (dedicated storage, independent of `_dynDefs`). Used by blanks with `blankConsumeAll: true` that replace entire text with multi-word cycling alternatives. Span-aware replacement, updates `_dynSpans`, `_dynLastAnalyzed`, `_dynPrevWords`, and `_hlState.wordIndex` to prevent re-analysis interference. See `docs/guides/creating-a-cue-type.md`.
3. **Dynamic alts** → cycle `_dynDefs.words[i].alts`
4. **Tip-lookup fallback** → if word is in `_localCueMap` but not in `_dynDefs`, resolve alts on-the-fly from tips and populate `_dynDefs` (covers cases where eager lookup was skipped, e.g., during pending LLM calls)
5. **Fall through** → no action

The cue-blank-keyword check (`blanksByWord` in `ConfigLoader`) is used by tips lookup and status line export to exclude cue-blank keywords from tips/alts display.

## CC-Specific: Dynamic List Blanks

When `BlankSource` (or a hoisted runtime class) returns multi-line output, each line becomes a cycling alternative — same as static `stepValues` but populated from live data (e.g., RSS feed titles from Hacker News). The resulting `WordDef` has `metadata.listBlank: true` and goes through the normal alt cycling path (step 3), not the `blankInvoke up/down` path (step 1).

## CC-Specific: Dismissible Blanks

When a blank has `blankDismissible: true`, `BlankSource` appends `_` as the last alternative in both list blanks (`stepValues`) and dynamic list blanks. In `_cycleAlt`, when the user cycles to `_`:

- `globalThis._dismissedBlanks[wordIndex] = true` is set
- Auto-populate checks `_dismissedBlanks` before firing — dismissed positions are skipped

Dismissed positions are cleared when the input text changes (`wordHighlight.ts` resets `globalThis._dismissedBlanks = null` on text change), so a new sentence re-triggers auto-populate normally.

## CC-Specific: Tips Protection from LLM

Tip-sourced entries (`source: "tips"`) are never overwritten by LLM grammar results during the merge phase. When LLM results arrive and an existing entry has `source: "tips"`, the LLM result is skipped entirely for that index. Tips are curated — mixing in LLM suggestions would pollute the intended alternatives.

## CC-Specific: TTS on Cycling

When cycling (Up/Down) on a word with `speak: true`, the alt-specific tip is spoken via TTS. The `altCueTips[currentAlt]` text is used if available, falling back to `cueTip`. Same 80ms debounce and process cancellation as navigation TTS.

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
