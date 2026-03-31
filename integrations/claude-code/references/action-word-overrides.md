---
last_updated: 2026-03-31
---

# Action Word Overrides — Quick Reference

Words that trigger external scripts on Up/Down instead of normal cycling.

## Priority Order

Action words are checked **first**, before all other Up/Down logic:

1. **Action word** → spawn script, return
2. Dynamic highlight cycling → LLM alternatives
3. Gender mode → flip boy/girl
4. Number mode → increment/decrement

## Config

In `~/.tweakcc/config.json` → `settings.misc`:

```json
"actionWordOverrides": {
  "volume": {
    "action": "volume",
    "upArgs": ["up", "5"],
    "downArgs": ["down", "5"]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | Script name (resolves to `~/.claude/actions/{action}.sh`) |
| `scriptPath` | string? | Custom script path (overrides default) |
| `upArgs` | string[] | Args passed on Ctrl+Alt+Up |
| `downArgs` | string[] | Args passed on Ctrl+Alt+Down |

## Visual

- **Dimmed** (dark gray) when not highlighted — same as numbers
- **Bold white** when highlighted
- Word is **not modified** — it triggers an external action instead
- Navigable in all highlight modes

## Scripts

Location: `~/.claude/actions/{action}.sh`

Scripts receive args as configured:
```bash
~/.claude/actions/volume.sh up 5    # Ctrl+Alt+Up
~/.claude/actions/volume.sh down 5  # Ctrl+Alt+Down
```

Scripts run detached in background — Claude Code stays responsive.

## Adding New Action Words

1. Add to config (`~/.tweakcc/config.json`)
2. Create `~/.claude/actions/{action}.sh`
3. `chmod +x ~/.claude/actions/{action}.sh`
4. Re-apply patches, restart Claude Code

## Performance (WSL volume example)

| Method | Latency | Notes |
|--------|---------|-------|
| nircmd | ~5ms | Best — no focus needed |
| VBScript | ~120ms | Needs Windows app focused |
| PowerShell | ~1300ms | Avoid |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Script not running | Check `ls -la ~/.claude/actions/volume.sh`, test manually |
| Windows line endings | `sed -i 's/\r$//' ~/.claude/actions/volume.sh` |
| VBS "cannot find script" | Create helpers — see `docs/action-word-overrides.md` |
| Word not navigable | Check word is in config (case-insensitive), re-apply patches |

## Future Extensions

Potential action words:
- `brightness` — screen brightness control
- `speed` — playback speed (media)
- `zoom` — zoom level
- `mute` — toggle mute
- `play` / `pause` — media control

Any word can become an action word — just add config + script.

## Related

- `docs/action-word-overrides.md` — full guide with WSL setup, nircmd install, volume script
