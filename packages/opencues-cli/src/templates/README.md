# `.cues/` — project-level OpenCues config

This dir was scaffolded by `opencues init`. Files here override
user-level (`~/.cues/`) defaults whenever a session runs from this
project (`cd <project> && claude-cues` or equivalent).

| File | Purpose |
|---|---|
| `CUES.md` | LLM cue sources (word alternatives) |
| `BLANKS.md` | Blank declarations (typed `_` triggers a fill, scripted blanks, etc.) |
| `cues/<name>/CUE.md` | Folder-based cue sources |
| `blanks/<name>/BLANK.md` + `<name>.sh` | Folder-based blanks (with optional colocated script) |

Note: `OPENCUES.md` is NOT a project file. Settings (voice-mode,
tips-mode, debug-mode, cursor-navigate) are system-wide and live only
at `~/.cues/OPENCUES.md`, managed by the runtime.

Hot-reload picks up changes within ~2s of the next keystroke.

## Adding things

```bash
opencues new cue <name>             # ~/.cues/cues/<name>/CUE.md
opencues new cue <name> --project   # .cues/cues/<name>/CUE.md (here)
opencues new blank <name> --project
```

## Importing community packs

```bash
opencues import gist:abc1234              # download into ~/.cues/
opencues import github:user/repo --project   # download into here
```

## Validating

```bash
opencues validate --project        # lint everything in .cues/
```

## Commit or ignore?

Project preference. Some teams commit `.cues/` so all contributors
get the same cues; others `.gitignore .cues/` to keep it personal.
Both are fine.
