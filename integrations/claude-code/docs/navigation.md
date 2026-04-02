---
last_updated: 2026-04-02
---

# Navigation — Claude Code

Implements features [1](../../../docs/features/navigation.md), [3](../../../docs/features/visual-states.md), [4](../../../docs/features/cursor-preservation.md), [13](../../../docs/features/cursor-export.md). See those docs for the concepts.

**Patch file:** `patches/wordHighlight.ts`

## Keybindings

**Navigation (Left/Right)** — select which word to focus on:

| Key | Action |
|-----|--------|
| Ctrl+Alt+Left | Move highlight to previous navigable word (or activate at rightmost) |
| Ctrl+Alt+Right | Move highlight to next navigable word (or clear if at rightmost) |
| Escape | Clear highlight |
| Any typing | Clear highlight |

**Cycling (Up/Down)** — change the focused word. See `cycling.md` for details:

| Key | Action |
|-----|--------|
| Ctrl+Alt+Up | Cycle to next alternative / increment number |
| Ctrl+Alt+Down | Cycle to previous alternative / decrement number |

**Raw sequence fallback:** Also handles `\x1B[1;7D/C/A/B` (modifier 7 = Ctrl+Alt) for terminals that don't set meta/option flags.

## Number Pattern

`/^-?\d+(\.\d+)?$/` — matches integers, decimals, negatives (requires digit after decimal)

## ANSI Rendering

| State | Code | Appearance |
|-------|------|------------|
| Normal | (none) | Default |
| Dimmed | `\x1b[0m\x1b[90m` | Dark gray |
| Highlighted | `\x1b[0m\x1b[1;97m` | Bold bright white |

Each code starts with `\x1b[0m` reset to prevent ANSI stacking from cursor inverse mode.

Configurable via `highlightColor`: white (default), cyan (`\x1b[1;96m`), yellow (`\x1b[1;93m`), inverse (`\x1b[7m`), underline (`\x1b[4m`).

## File Exports

**Cursor state** → `/tmp/claude-cursor-state.json` (debounced 100ms):
```json
{"text":"hello world","cursorPosition":6,"currentWord":"world","atEnd":false,"textLength":11,"timestamp":1705500000000}
```

**Highlight state** → `/tmp/claude-highlight-state-{PID}.json` (sync, on every navigation):
```json
{"active":true,"highlightedWord":"agents","cueTip":"Spawn parallel workers...","alts":["agents","swarm","background"],"currentAltIndex":0,"altCueTips":{"agents":"...","swarm":"..."}}
```

PID-based path prevents multi-instance interference.

## Config

| Option | Default | Purpose |
|--------|---------|---------|
| `enableWordHighlight` | — | Master switch (required) |
| `highlightMode` | `'numbers'` | `numbers`, `words`, `gender`, `both` |
| `highlightColor` | `'white'` | `white`, `cyan`, `yellow`, `inverse`, `underline` |
| `numberDimming` | `true` | Dim numbers in dark gray |
| `highlightExportEnabled` | `true` | Write highlight state JSON |
| `enableCursorStateExport` | `true` | Write cursor state JSON |
| `highlightClearOnEscape` | `true` | Clear on Escape |
| `highlightIndexFromLeft` | `false` | Index direction |
| `highlightWrap` | `false` | Wrap at boundaries |
