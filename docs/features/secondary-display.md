---
last_updated: 2026-04-09
---

# Secondary Display

The secondary display shows cue-tip text and cycle position for the highlighted word outside the text input. It is separated from the input so that tips do not interfere with editing.

Tips come from several sources depending on the word type:

| Word type | Tip source | Example |
|---|---|---|
| **Selector word** | `cues.md` `settings:` block (setting-level line) | `voice-mode` → "Gates TTS globally" |
| **Satellite word** | `cues.md` `settings:` block (per-value line, falls back to setting-level) | `active` → "TTS reads tips aloud on navigation" |
| **Cue-blank value** | `blankTip` in the blank's `cue.md` | `72` → "System volume" |
| **Cue-blank keyword** | Live `blankInvoke get` output, falls back to `tip` in `cue.md` | `volume` → "85" |
| **Local cue (folder-based)** | `cues/<name>/cue.md` body JSON via instant `cueMap` lookup | `ultrathink` → "Add 'ultrathink' to prompt for max reasoning" |
| **LLM-analyzed word** | LLM response via opencues-core resolver | `happy` → "glad, joyful, content" |

See [Tip Priority](tip-priority.md) for the full resolution order and how the branches interact.

---

## How It Works

1. **On every render**, the integration writes a JSON export file (`/tmp/opencues-highlight-state-{pid}.json`) containing the current highlight state
2. **A status line script** reads this file and formats it for display below the input
3. **When a word is highlighted**, the export includes the word name, its alternatives, the current cycle position, and cue-tip text
4. **When navigation is inactive** (`active: false`), the status line shows the shell-style prompt (user@host:dir). When a word is active, the word info is appended after the PS1-style prefix on a new line

The export runs synchronously inside the render loop using `fs.writeFileSync`, so the file is always current when the status line reads it.

---

## Export Format

The JSON file (`_hlExport`) contains these fields:

| Field | Type | Description |
|-------|------|-------------|
| `active` | boolean | Whether a word is currently highlighted |
| `highlightedWordIndex` | number \| null | Index into the whitespace-split word array |
| `highlightedWord` | string \| null | The highlighted word's text |
| `wordCount` | number | Total number of words in the input |
| `originalNumber` | number \| null | Reserved (unused). |
| `cueTip` | string \| null | Tip text for the highlighted word (source depends on word type — see table above) |
| `altCueTips` | object \| null | Map of each alternative to its own tip (for per-alternative tip display during cycling) |
| `alts` | string[] \| null | Alternatives list for the highlighted word |
| `currentAltIndex` | number \| undefined | Position within the alternatives list (0-based). Only set when a word with alternatives is highlighted. `undefined` when inactive or the word has no alts. |
| `cueBlank` | true \| undefined | True if the word is a blank (auto-populated value or keyword with a tip). Only set to `true` when applicable. `undefined` (not `false`) otherwise. |
| `timestamp` | number | `Date.now()` when the export was written |
| `_debug` | object | Debug info: word, isCA, blankTip, registered blank keys, cueValues |

**Tip resolution priority:** See [Tip Priority](tip-priority.md) for the full resolution order across all word types (selector/satellite, cue-blank values, cue-blank keywords, local cues, LLM).

---

## Status Line

The `highlight-statusline.sh` script is a self-contained bash script that reads the export file and formats it for Claude Code's status line feature.

**Setup:** Configure `~/.claude/settings.json`:
```json
{ "statusLine": { "type": "command", "command": "/full/path/highlight-statusline.sh" } }
```

**PID discovery:** The script walks up the process tree (`/proc/{pid}/stat`) looking for a process whose `cmdline` starts with `claude`, then reads `/tmp/opencues-highlight-state-{pid}.json`.

**Display format:**
- **Inactive:** `user@host:dir` (PS1-style prefix, colored with tput — always shown)
- **Regular word:** `word (pos/total) - tip` where pos is `currentAltIndex + 1` and total is the alts array length
- **Selector word:** `tip` only — shows the setting-level tip from `cues.md` `settings:` block (displayed as cue-blank)
- **Satellite word:** `tip` only — shows the per-value tip from `cues.md` `settings:` block, falls back to setting-level (displayed as cue-blank)
- **Cue-blank keyword:** `tip` only — the word is already highlighted in the input, so repeating it is redundant
- **Cue-blank value:** `tip` only — only shown if `blankTip` is set in the blank's config
- **No tip:** Output suppressed entirely

The script suppresses output entirely for words that have neither alts nor a tip, so the status line stays clean.

---

## Portability

### Standard (opencues-core)

- `CueResult.cueTip` provides the primary tip text for the focused word
- `CueResult.altCueTips` maps each alternative to its own tip, enabling per-alternative tip display during cycling
- `WordDef.speak` flag indicates whether the tip should be read aloud via TTS
- Cue-blank values use `blankTip` from the blank's config; suppressed if unset
- Cue-blank keywords use live `blankInvoke get` output with fallback to `tip` from config
- Selector/satellite tips are read from the backing config file (`cues.md` `settings:` block), not from static metadata

### Integration responsibilities

- Choose and implement a display surface: status bar, tooltip, hover panel, sidebar, or other platform UI
- Render the current word name, cycle position (e.g., "2/4"), and cue-tip text
- Switch the displayed tip when cycling to show the per-alternative tip from `altCueTips`
- Execute TTS when `speak` is true, using a platform-appropriate speech engine
- Implement the tip resolution branches: blank-bound words (selector/satellite, then regular cue-blank values), cue-blank keywords, then general words (local cues, LLM) — see [Tip Priority](tip-priority.md)
- For selector/satellite words, read tips from the backing config's `settings:` block and hot-reload them
- Suppress the display when no tip resolves for a word
