---
last_updated: 2026-04-07
---

# Navigation — Claude Code

Implements features [1](../../../docs/features/navigation.md), [3](../../../docs/features/visual-cues.md), [4](../../../docs/features/cursor-preservation.md), [13](../../../docs/features/cursor-export.md). See those docs for the concepts.

**Patch files:** `patches/wordHighlight.ts` (navigation, rendering, key handlers)

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
| Ctrl+Alt+Up | Cue-control (custom script / step control increment) or cycle to next alternative |
| Ctrl+Alt+Down | Cue-control (custom script / step control decrement) or cycle to previous alternative |

**Raw sequence fallback:** Also handles `\x1B[1;7D/C/A/B` (modifier 7 = Ctrl+Alt) for terminals that don't set meta/option flags.

## Navigation Filter

Navigation targets are determined by `_isCueControl(word)` which checks:
1. `_cueBlankOverrides[word]` — named control words (e.g., `volume`, `brightness`)
2. `_stepPatterns` — step control regex patterns (auto-generated from `stepSuffixes` or explicit `stepPattern`)

No hardcoded number pattern — all navigable values are config-driven via `controls/` folder `cue.md` files.

## ANSI Rendering

| State | Code | Appearance |
|-------|------|------------|
| Normal | (none) | Default |
| Dimmed | `\x1b[0m\x1b[90m` | Dark gray |
| Highlighted | `\x1b[0m\x1b[1;97m` | Bold bright white |

Each code starts with `\x1b[0m` reset to prevent ANSI stacking from cursor inverse mode.

Configurable via `highlightColor`: white (default), cyan (`\x1b[1;96m`), yellow (`\x1b[1;93m`), inverse (`\x1b[7m`), underline (`\x1b[4m`).

## File Exports

**Cursor state** → `/tmp/opencues-cursor-state.json` (debounced 100ms):
```json
{"text":"hello world","cursorPosition":6,"currentWord":"world","atEnd":false,"textLength":11,"timestamp":1705500000000}
```

**Highlight state** → `/tmp/opencues-highlight-state-{PID}.json` (sync, on every navigation):
```json
{"active":true,"highlightedWord":"agents","cueTip":"Spawn parallel workers...","alts":["agents","swarm","background"],"currentAltIndex":0,"altCueTips":{"agents":"...","swarm":"..."}}
```

PID-based path prevents multi-instance interference.

## Config

| Option | Default | Purpose |
|--------|---------|---------|
| `enableWordHighlight` | — | Master switch (required) |
| `highlightMode` | `'words'` | `numbers`, `words` |
| `highlightColor` | `'white'` | `white`, `cyan`, `yellow`, `inverse`, `underline` |
| `numberDimming` | `true` | Dim step-pattern matches in dark gray |
| `highlightExportEnabled` | `true` | Write highlight state JSON |
| `enableCursorStateExport` | `true` | Write cursor state JSON |
| `highlightClearOnEscape` | `true` | Clear on Escape |
| `highlightIndexFromLeft` | `false` | Index direction |
| `highlightWrap` | `false` | Wrap at boundaries |
| `ttsSpeed` | `2` | SAPI speech rate for TTS (-10 to 10) |
| `ttsScript` | `''` | Custom TTS script path |
