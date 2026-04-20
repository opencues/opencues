# `.opencues/` — project-level OpenCues config

This dir was scaffolded by `opencues init`. Files here override
user-level (`~/.opencues/`) defaults whenever a session runs from this
project (`cd <project> && claude-cues` or equivalent).

| File | Purpose |
|---|---|
| `cues.md` | LLM cue sources (word alternatives) |
| `blanks.md` | Blank-fill modes (typed `_` triggers a fill) |
| `controls.md` | Cue-control declarations (rare; folders preferred) |
| `opencues.md` | Settings / state (voice-mode, tips-mode, debug-mode, etc.) |
| `cues/<name>/cue.md` | Folder-based cue sources |
| `controls/<name>/cue.md` + `<name>.sh` | Folder-based controls |

Hot-reload picks up changes within ~2s of the next keystroke.

## Adding things

```bash
opencues new cue <name>          # ~/.opencues/cues/<name>/cue.md
opencues new cue <name> --project   # .opencues/cues/<name>/cue.md (here)
opencues new control <name> --project
opencues new blank <name> --project
```

## Importing community packs

```bash
opencues import gist:abc1234              # download into ~/.opencues/
opencues import github:user/repo --project   # download into here
```

## Validating

```bash
opencues validate --project        # lint everything in .opencues/
```

## Commit or ignore?

Project preference. Some teams commit `.opencues/` so all contributors
get the same cues; others `.gitignore .opencues/` to keep it personal.
Both are fine.
