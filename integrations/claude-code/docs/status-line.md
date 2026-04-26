---
last_updated: 2026-04-07
---

# Status Line — Claude Code

Implements feature [14](../../../docs/features/secondary-display.md). See that doc for the concept.

**Patch files:** `patches/highlight-statusline.sh` (status line script), `patches/wordHighlight.ts` (export JSON)

Shows the highlighted word, tip text, and alternative count in Claude Code's status bar. Cue-controls show their tip text only. Alt-cycling words show word, position, and tip.

## Display Format

```
user@host:~/project
word (N/M) - Tip text for this word
```

- **word** — the currently highlighted word
- **N/M** — current alternative position / total alternatives
- **Tip text** — from `~/claude-code-cues/.opencues/tips.json` (only for tips words, not LLM alternatives)

Words without alts or a cue-control tip produce no status line output.

## Setup

1. `setup.sh` copies `highlight-statusline.sh` to `~/.claude/`
2. Run `/statusline` in Claude Code
3. Set command to full path: `/home/YOUR_USER/.claude/highlight-statusline.sh`
4. Restart Claude Code

## Data Flow

```
Ctrl+Alt+Arrow → wordHighlight.ts writes JSON → status line script reads it → display
```

| Step | Component | Action |
|------|-----------|--------|
| 1 | wordHighlight.ts | Writes `/tmp/opencues-highlight-state-{PID}.json` |
| 2 | dynamicHighlight.ts | Also writes on Up/Down cycling (fresh `currentAltIndex`) |
| 3 | Both patches | Call `_triggerStatusLineRefresh()` (300ms debounce) |
| 4 | Claude Code | Spawns `highlight-statusline.sh` |
| 5 | Script | Reads JSON, formats display (see Display Format below) |

## JSON Export Format

```json
{
  "active": true,
  "highlightedWord": "agents",
  "highlightedWordIndex": 2,
  "wordCount": 5,
  "cueTip": "Spawn parallel workers via Task tool",
  "alts": ["agents", "swarm", "background"],
  "currentAltIndex": 0,
  "altCueTips": {
    "agents": "Spawn parallel workers via Task tool",
    "swarm": "Multiple coordinated agents working on related tasks",
    "background": "Press Ctrl+B to send running agent to background"
  },
  "timestamp": 1234567890
}
```

| Field | Type | Source |
|-------|------|--------|
| `active` | boolean | `_hlState.active` |
| `highlightedWord` | string | Current word text |
| `cueControl` | boolean | `true` if word is a cue-control (step control or custom). When set, `tip`/`alts`/`altCueTips` are null. |
| `tip` | string | `_dynDefs.words[i].tip` (from local cues, null for cue-controls) |
| `alts` | string[] | `_dynDefs.words[i].alts` (local or remote cues, null for cue-controls) |
| `currentAltIndex` | number | Updated by cycling and per-word clearing |
| `altCueTips` | object | Per-alternative tip text (tips words only, null for cue-controls) |

## Display Format

The status line script formats the display based on control type:

| Condition | Format | Example |
|-----------|--------|---------|
| `cueControl: true` | `{cueTip}` | `system volume control` |
| Alt-cycling word | `{word} ({N}/{total}) - {cueTip}` | `agents (1/3) - Spawn parallel workers` |
| No tip | `{word} ({N}/{total})` | `happy (2/4)` |

Cue-controls (custom controls, control-bound blanks, step controls, list controls, dynamic list controls, read-only controls) all show just the `cueTip` text — the word is already highlighted in the input so repeating it in the status line is redundant.

## Tips Source

Tips come from `~/claude-code-cues/.opencues/tips.json`. Two formats:

**Groups** (synonyms share a tip, alts point to other groups):
```json
{
  "id": "parallel-execution",
  "groups": {
    "0": {
      "synonyms": ["agents", "sub-agents", "spawn"],
      "cueTip": "Spawn parallel workers via Task tool",
      "alts": ["swarm", "background"]
    }
  }
}
```

**Words** (individual entries):
```json
{
  "id": "extended-thinking",
  "words": {
    "ultrathink": {
      "cueTip": "Add 'ultrathink' to prompt for max reasoning",
      "alts": ["Tab", "deep thinking", "think harder"]
    }
  }
}
```

Words with tips get instant alternatives (~0ms). Words without tips get LLM alternatives but no tip text in the status line.

## Multi-Instance

Each Claude Code instance uses its PID in the file path: `/tmp/opencues-highlight-state-{PID}.json`. The status line script walks up the process tree to find the correct PID.

**Process name gotcha:** Claude Code's cmdline is `claude`, not `node cli.js`. The script greps for `^claude` in `/proc/{PID}/cmdline`.

## Configuration

| Setting | Default | Effect |
|---------|---------|--------|
| `highlightExportEnabled` | `true` | Write JSON state file on navigation |

Set in `~/claude-code-cues/.opencues/patch-state/config.json` under `misc`.

## Disabling

| What | How |
|------|-----|
| Status line display | Run `/statusline` in Claude Code, clear command |
| State file export | Set `highlightExportEnabled: false` in config |
| Remove script | `rm ~/claude-code-cues/.opencues/statusline.sh` |

## Script Location

- **Source:** `opencues/integrations/claude-code/patches/highlight-statusline.sh`
- **Installed to:** `~/claude-code-cues/.opencues/statusline.sh`
- **Customise:** Edit the installed copy — it's a plain bash script.

## Related

- `navigation.md` — keys, modes, visual states
- `alternatives.md` — tips, LLM sources, auto-submit
- `config.md` — all configuration options
