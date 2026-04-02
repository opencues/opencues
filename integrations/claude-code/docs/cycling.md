---
last_updated: 2026-04-02
---

# Cycling — Claude Code

Implements features [2](../../../docs/features/cycling.md), [5](../../../docs/features/linked-words.md), [9](../../../docs/features/multi-word-spans.md), [10](../../../docs/features/per-word-clearing.md). See those docs for the concepts.

**Patch files:** `patches/wordHighlight.ts` (numbers, gender), `patches/dynamicHighlight.ts` (LLM alts, action words, spans, clearing)

## CC-Specific: Cycling Priority Implementation

All cycling goes through the shared `_cycleAlt(dir)` function in `dynamicHighlight.ts`, checked in order:

1. **Action word** → spawn `~/.claude/actions/{action}.sh`, return
2. **Dynamic alts** → cycle `_dynDefs.words[i].alts`
3. **Number** → increment/decrement with `originalNumbers` map
4. **Fall through** → no action

## CC-Specific: State Export on Cycle

The highlight export JSON is written directly inside `_cycleAlt` (not just in the input handler) to ensure `currentAltIndex` is fresh for the status line.

## CC-Specific: Linked Word Sources

- **Hardcoded** gender groups in `wordHighlight.ts` (always available)
- **LLM-detected** links via linked words prompt (stored in `_dynDefs.words[i].linked`)

## CC-Specific: Span Tracking

`_dynSpans` globalThis map tracks multi-word replacements. Updated in `_cycleAlt` after each replacement.

## CC-Specific: Clearing Implementation

Navigation and rendering check `alts.indexOf(word) >= 0` — a word is only navigable/dimmed if it currently matches an entry in its alts array. This enables typing recovery without special logic.

## Related

- `navigation.md` — keybindings and rendering
- `alternatives.md` — how alternatives are generated
- `config.md` — all config options
