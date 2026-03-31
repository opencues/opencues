---
last_updated: 2026-03-31
---

# Status Line Integration

Shows the currently highlighted word, its tip text, and available alternatives in Claude Code's status bar.

## What it looks like

```
user@host:~/project
agents (1/3) - Spawn parallel workers via Task tool - faster for multi-file ops
```

When you cycle with Ctrl+Alt+Up/Down:
```
swarm (2/3) - Multiple coordinated agents working on related tasks
```

## Setup

### 1. Install the script

`setup.sh` copies `highlight-statusline.sh` to `~/.claude/` automatically. To install manually:

```bash
cp ~/cues-system/integrations/claude-code/patches/highlight-statusline.sh ~/.claude/
chmod +x ~/.claude/highlight-statusline.sh
```

### 2. Enable in Claude Code

Run `/statusline` inside Claude Code, then set the command to:

```
/home/YOUR_USER/.claude/highlight-statusline.sh
```

Use the full absolute path — `~` is not supported here.

### 3. Restart Claude Code

The status line appears at the bottom of the terminal.

## How it works

```
Keystroke → wordHighlight.ts exports state → JSON file → status line script reads it
```

1. You highlight a word with Ctrl+Alt+Left/Right
2. The patch writes highlight state to `/tmp/claude-highlight-state-{PID}.json`
3. The patch triggers a status line refresh
4. Claude Code runs `highlight-statusline.sh` which reads the JSON and displays word + tip

The JSON contains:
```json
{
  "active": true,
  "highlightedWord": "agents",
  "tip": "Spawn parallel workers via Task tool",
  "alts": ["agents", "swarm", "background"],
  "currentAltIndex": 0,
  "altTips": {
    "agents": "Spawn parallel workers via Task tool",
    "swarm": "Multiple coordinated agents working on related tasks",
    "background": "Press Ctrl+B to send running agent to background"
  }
}
```

### Tips source

Tips come from `~/.claude/claude-code-tips.json`. Words matching the tips file get instant alternatives (~0ms, no LLM call). The tip text shows in the status line when the word is highlighted.

Words without tips get LLM-generated alternatives (synonym, opposite, creative) but no tip text.

### Multi-instance support

Each Claude Code instance writes to `/tmp/claude-highlight-state-{PID}.json` using its process ID. The status line script walks up the process tree to find the correct PID, so multiple instances don't interfere.

## Disabling

### Turn off the status line display

Run `/statusline` in Claude Code and clear the command. Or set it to a different script.

### Remove the script

```bash
rm ~/.claude/highlight-statusline.sh
```

### Disable state export entirely

In `~/.tweakcc/config.json`, set:

```json
{
  "misc": {
    "highlightExportEnabled": false
  }
}
```

This stops writing the JSON file on each navigation event.

## Customising the script

The script is a plain bash file at `~/.claude/highlight-statusline.sh`. Edit it to change the display format, add colours, or show different fields from the JSON.

Available fields: `highlightedWord`, `tip`, `alts`, `currentAltIndex`, `altTips`, `wordCount`, `active`.
