# `.opencues/` — project-level OpenCues config

This dir was scaffolded by `opencues init`. Files here override
user-level (`~/.opencues/`) defaults whenever a session runs from this
project (`cd <project> && claude-cues` or equivalent).

| File | Purpose |
|---|---|
| `cues.md` | LLM cue sources (word alternatives) |
| `blanks.md` | Blank declarations (typed `_` triggers a fill, scripted blanks, etc.) |
| `cues/<name>/cue.md` | Folder-based cue sources |
| `blanks/<name>/cue.md` + `<name>.sh` | Folder-based blanks (with optional colocated script) |

Note: `opencues.md` is NOT a project file. Settings (voice-mode,
tips-mode, debug-mode, cursor-navigate) are system-wide and live only
at `~/.opencues/opencues.md`, managed by the runtime.

Hot-reload picks up changes within ~2s of the next keystroke.

## Adding things

```bash
opencues new cue <name>             # ~/.opencues/cues/<name>/cue.md
opencues new cue <name> --project   # .opencues/cues/<name>/cue.md (here)
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
