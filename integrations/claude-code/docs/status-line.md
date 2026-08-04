---
last_updated: 2026-04-07
---

# Status Line — Claude Code

Implements feature [14](../../../docs/features/secondary-display.md). See that doc for the concept.

**Patch files:** `patches/highlight-statusline.sh` (status line script). Highlight state is exported by @opencues/runtime Statusline module.

Shows the highlighted word, tip text, and alternative count in Claude Code's status bar. Cue-blanks show their tip text only. Alt-cycling words show word, position, and tip.

## Display Format

```
user@host:~/project
word (N/M) - Tip text for this word
```

- **word** — the currently highlighted word
- **N/M** — current alternative position / total alternatives
- **Tip text** — from `~/.opencues/forks/claude-code/.cues/tips.json` (only for tips words, not LLM alternatives)

Words without alts or a cue-blank tip produce no status line output.

## Setup

Two steps — install first, then opt in via a dedicated command:

```bash
opencues install claude-code             # stages statusline.sh into <CC_FORK>/.cues/
opencues statusline enable               # writes ~/.claude/settings.json — explicit consent
```

Why two steps: `~/.claude/` is Claude Code's directory, not OpenCues's. Touching it on every install would surprise users (especially anyone running a custom statusline like starship). The opt-in command makes the file modification explicit + reversible.

The `opencues statusline` command supports:

- `enable [--project] [--force]` — write our `statusLine.command` to user (default) or `<cwd>/.claude/settings.json`. `--force` overrides a non-opencues custom command.
- `disable [--project]` — clear our `statusLine.command`. Refuses to clear a non-opencues command.
- `status` — read-only inspection of both user- and project-level settings.

Behaviour rules baked into the command (and pinned by tests in `packages/opencues-cli/src/lib/cc-statusline.test.cjs`):

- Back up `settings.json.bak.cues-statusline` before any write.
- Refuse to overwrite a user-custom `statusLine.command` (your starship.sh, etc.) without `--force`.
- Refuse to clear a non-opencues `statusLine.command` (never touch what's not ours).
- Auto-rewrite stale opencues paths (e.g. legacy `~/.claude/opencues/statusline.sh`) to the current install root on `enable`.
- Project-level (`<cwd>/.claude/settings.json`) wins over user-level when CC reads it. `opencues doctor` flags the shadow case prominently when project-level suppresses user-level.

## Data Flow

```
Ctrl+Alt+Arrow → @opencues/runtime Statusline module writes JSON → status line script reads it → display
```

| Step | Component | Action |
|------|-----------|--------|
| 1 | `@opencues/runtime` Statusline | Writes `/tmp/opencues-status-{PID}.json` on every highlight state change |
| 2 | Same module | Calls `host.refreshStatusline()` (CC: triggers the captured useCallback at the S6 seam, 300ms debounce) |
| 3 | Claude Code | Spawns `highlight-statusline.sh` |
| 4 | Script | Reads JSON, formats display (see Display Format below) |

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
| `cueBlank` | boolean | `true` if word is a cue-blank (auto-populated value or registered keyword). When set, `tip`/`alts`/`altCueTips` are null. |
| `tip` | string | `_dynDefs.words[i].tip` (from local cues, null for cue-blanks) |
| `alts` | string[] | `_dynDefs.words[i].alts` (local or remote cues, null for cue-blanks) |
| `currentAltIndex` | number | Updated by cycling and per-word clearing |
| `altCueTips` | object | Per-alternative tip text (tips words only, null for cue-blanks) |

## Display Format

The status line script formats the display based on word type:

| Condition | Format | Example |
|-----------|--------|---------|
| `cueBlank: true` | `{cueTip}` | `system volume` |
| Alt-cycling word | `{word} ({N}/{total}) - {cueTip}` | `agents (1/3) - Spawn parallel workers` |
| No tip | `{word} ({N}/{total})` | `happy (2/4)` |

Cue-blanks (auto-populated values, list blanks, dynamic list blanks, read-only blanks) all show just the `cueTip` text — the word is already highlighted in the input so repeating it in the status line is redundant.

## Tips Source

Tips come from `~/.opencues/forks/claude-code/.cues/tips.json`. Two formats:

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

Each Claude Code instance uses its PID in the file path: `/tmp/opencues-status-{PID}.json`. The status line script walks up the process tree to find the correct PID.

**Process name gotcha:** Claude Code's cmdline is `claude`, not `node cli.js`. The script greps for `^claude` in `/proc/{PID}/cmdline`.

## Configuration

| Setting | Default | Effect |
|---------|---------|--------|
| `highlightExportEnabled` | `true` | Write JSON state file on navigation |

Set in `~/.opencues/forks/claude-code/.cues/patch-state/config.json` under `misc`.

## Disabling

| What | How |
|------|-----|
| Status line display | Run `/statusline` in Claude Code, clear command |
| State file export | Set `highlightExportEnabled: false` in config |
| Remove script | `rm ~/.opencues/forks/claude-code/.cues/statusline.sh` |

## Script Location

- **Source:** `opencues/integrations/claude-code/patches/highlight-statusline.sh`
- **Installed to:** `~/.opencues/forks/claude-code/.cues/statusline.sh`
- **Customise:** Edit the installed copy — it's a plain bash script.

## Related

- `navigation.md` — keys, modes, visual states
- `alternatives.md` — tips, LLM sources, auto-submit
- `config.md` — all configuration options
