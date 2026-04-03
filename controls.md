---
name: claude-code-controls
domain: claude-code
version: 1
---

# controls.md

OpenCues controls configuration. Defines cue-controls — words that trigger
system-level controls (volume, brightness, etc.) when cycled with arrow keys.

## Controls

```json
{
  "volume": {
    "control": "volume",
    "tip": "system volume control",
    "script": "~/.claude/actions/volume.sh",
    "upArgs": ["up", "6"],
    "downArgs": ["down", "6"]
  },
  "brightness": {
    "control": "brightness",
    "tip": "screen brightness",
    "script": "~/.claude/actions/brightness.sh",
    "upArgs": ["up", "10"],
    "downArgs": ["down", "10"]
  }
}
```
