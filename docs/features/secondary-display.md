---
last_updated: 2026-04-06
---

# Secondary Display

The secondary display shows cue-tip text and cycle position for the highlighted word outside the text input. It is separated from the input so that tips do not interfere with editing. Custom cue-controls (word-based) always appear in the status line with a fallback tip (the control name). Control-bound blanks only appear if `blankTip` is set — otherwise the status line shows nothing for the auto-populated value.

---

## How It Works

1. **On every render**, the integration writes a JSON export file (`/tmp/claude-highlight-state-{pid}.json`) containing the current highlight state
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
| `originalNumber` | number \| null | Original value when a step-controlled word was first navigated to |
| `cueTip` | string \| null | Tip text for the highlighted word (from local cues, LLM, or control config) |
| `altCueTips` | object \| null | Map of each alternative to its own tip (for per-alternative tip display during cycling) |
| `alts` | string[] \| null | Alternatives list for the highlighted word |
| `currentAltIndex` | number \| undefined | Position within the alternatives list (0-based). Only set when a word with alternatives is highlighted. `undefined` when inactive or the word has no alts. |
| `cueControl` | true \| undefined | True if the word is a cue-control (custom control or control-bound blank with a tip). Only set to `true` when applicable. `undefined` (not `false`) when the word is not a cue-control. |
| `timestamp` | number | `Date.now()` when the export was written |
| `_debug` | object | Debug info: word, isCA, cueControlTip, overrides keys, cueValues |

**Tip resolution priority:** Control-bound blanks (`metadata.controlName` set) use `cueTip` from the `WordDef`. Custom cue-controls use `tip` from `_cueControlOverrides` (falling back to the control name). All other words use `cueTip` and `altCueTips` from `_dynDefs`.

---

## Status Line

The `highlight-statusline.sh` script is a self-contained bash script that reads the export file and formats it for Claude Code's status line feature.

**Setup:** Configure `~/.claude/settings.json`:
```json
{ "statusLine": { "type": "command", "command": "/full/path/highlight-statusline.sh" } }
```

**PID discovery:** The script walks up the process tree (`/proc/{pid}/stat`) looking for a process whose `cmdline` starts with `claude`, then reads `/tmp/claude-highlight-state-{pid}.json`.

**Display format:**
- **Inactive:** `user@host:dir` (PS1-style prefix, colored with tput — always shown)
- **Regular word:** `word (pos/total) - tip` where pos is `currentAltIndex + 1` and total is the alts array length
- **Cue-control:** `tip` only — the word is already highlighted in the input, so repeating it is redundant
- **No tip:** Output suppressed entirely

The script suppresses output entirely for words that have neither alts nor a cue-control tip, so the status line stays clean.

---

## Portability

### Standard (cues-core)

- `CueResult.cueTip` provides the primary tip text for the focused word
- `CueResult.altCueTips` maps each alternative to its own tip, enabling per-alternative tip display during cycling
- `WordDef.speak` flag indicates whether the tip should be read aloud via TTS
- Custom cue-controls always appear with a fallback tip (the control name); control-bound blanks only appear if `blankTip` is set

### Integration responsibilities

- Choose and implement a display surface: status bar, tooltip, hover panel, sidebar, or other platform UI
- Render the current word name, cycle position (e.g., "2/4"), and cue-tip text
- Switch the displayed tip when cycling to show the per-alternative tip from `altCueTips`
- Execute TTS when `speak` is true, using a platform-appropriate speech engine
- Show custom cue-controls with a fallback tip (the control name); suppress control-bound blanks unless `blankTip` is set
- Isolate control-blank tips so they appear only when the control-blank word is focused
