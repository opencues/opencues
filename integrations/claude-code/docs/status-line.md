---
last_updated: 2026-03-31
---

# Status Line Tips — Full Reference

Shows the highlighted word, tip text, and alternative count in Claude Code's status bar.

## Display Format

```
user@host:~/project
word (N/M) - Tip text for this word
```

- **word** — the currently highlighted word
- **N/M** — current alternative position / total alternatives
- **Tip text** — from `~/.claude/claude-code-tips.json` (only for tips words, not LLM alternatives)

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
| 1 | wordHighlight.ts | Writes `/tmp/claude-highlight-state-{PID}.json` |
| 2 | dynamicHighlight.ts | Also writes on Up/Down cycling (fresh `currentAltIndex`) |
| 3 | Both patches | Call `_triggerStatusLineRefresh()` (300ms debounce) |
| 4 | Claude Code | Spawns `highlight-statusline.sh` |
| 5 | Script | Reads JSON, prints word + tip |

## JSON Export Format

```json
{
  "active": true,
  "highlightedWord": "agents",
  "highlightedWordIndex": 2,
  "wordCount": 5,
  "tip": "Spawn parallel workers via Task tool",
  "alts": ["agents", "swarm", "background"],
  "currentAltIndex": 0,
  "altTips": {
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
| `tip` | string | `_dynDefs.words[i].tip` (from tips file) |
| `alts` | string[] | `_dynDefs.words[i].alts` (tips or LLM) |
| `currentAltIndex` | number | Updated by cycling and per-word clearing |
| `altTips` | object | Per-alternative tip text (tips words only) |

## Tips Source

Tips come from `~/.claude/claude-code-tips.json`. Two formats:

**Groups** (synonyms share a tip, alts point to other groups):
```json
{
  "id": "parallel-execution",
  "groups": {
    "0": {
      "synonyms": ["agents", "sub-agents", "spawn"],
      "tip": "Spawn parallel workers via Task tool",
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
      "tip": "Add 'ultrathink' to prompt for max reasoning",
      "alts": ["Tab", "deep thinking", "think harder"]
    }
  }
}
```

Words with tips get instant alternatives (~0ms). Words without tips get LLM alternatives but no tip text in the status line.

## Multi-Instance

Each Claude Code instance uses its PID in the file path: `/tmp/claude-highlight-state-{PID}.json`. The status line script walks up the process tree to find the correct PID.

**Process name gotcha:** Claude Code's cmdline is `claude`, not `node cli.js`. The script greps for `^claude` in `/proc/{PID}/cmdline`.

## Configuration

| Setting | Default | Effect |
|---------|---------|--------|
| `highlightExportEnabled` | `true` | Write JSON state file on navigation |

Set in `~/.tweakcc/config.json` under `misc`.

## Disabling

| What | How |
|------|-----|
| Status line display | Run `/statusline` in Claude Code, clear command |
| State file export | Set `highlightExportEnabled: false` in config |
| Remove script | `rm ~/.claude/highlight-statusline.sh` |

## Script Location

- **Source:** `cues-system/integrations/claude-code/patches/highlight-statusline.sh`
- **Installed to:** `~/.claude/highlight-statusline.sh`
- **Customise:** Edit the installed copy — it's a plain bash script

## Related

- `word-highlight.md` — navigation and rendering
- `dynamic-highlight.md` — LLM alternatives and cycling
- `config.md` — all configuration options
