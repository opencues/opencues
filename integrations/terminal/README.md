# @opencues/terminal

OpenCues as a standalone TUI you invoke as a command. Full feature
surface — cues, blanks, cycling, agent-rewrite, statusline — without
patching any host. Built on Bun + OpenTUI + SolidJS.

## Install

```bash
# Bun is required: https://bun.sh
./patches/setup.sh --link ~/.local/bin
```

Then either:

- **As your editor** — `export EDITOR=oc-edit`; any `git commit` /
  `crontab -e` / `vi`-replacement command now opens OpenCues.
- **From a pipe** — `echo "the attorney filed today" | oc-edit > out.txt`.
- **From a ZLE widget** (zsh):

```zsh
oc-edit-buffer() {
  local tmp="$(mktemp)"
  print -r -- "$BUFFER" | oc-edit --out "$tmp"
  BUFFER="$(<"$tmp")"
  rm -f "$tmp"
  zle redisplay
}
zle -N oc-edit-buffer
bindkey '^E' oc-edit-buffer  # Ctrl+E to edit the current shell buffer
```

## Keys

- Type — cues highlight; `_` triggers blank lookup.
- **Ctrl+Alt+↑/↓** — cycle the active word's alternatives.
- **Ctrl+S** — submit (write buffer to stdout / `--out` path).
- **Ctrl+C** — cancel (exit 130).
- All standard OpenTUI textarea bindings (undo, word-jump, etc.).

## Configuration

Identical to the native hosts. `~/.cues/CUES.md` for cue sources,
`~/.cues/OPENCUES.md` for runtime settings (voice-mode, agent-debounce-ms,
…), `~/.cues/blanks/` for blank packs. The terminal app reads the
same search paths as CC and OC.

## Architecture

See `CLAUDE.md` in this directory.
