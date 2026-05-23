# Test-when-merged checklist — Terminal integration

Pre-merge automated tests already pass:
- `pnpm --filter @opencues/runtime test` → 1262/1262
- `pnpm --filter @opencues/core build && node --test packages/opencues-core/dist/host-compat.test.js` → 31/31
- `opencues install/run/uninstall/update/version/completion/doctor --help` all surface `terminal`

This file is the **reviewer's manual pass** — boxes to tick after pulling the PR onto a clean machine. Estimated 15 minutes.

## Prerequisites
- [ ] Bun installed (`curl -fsSL https://bun.sh/install | bash`)
- [ ] `GROQ_API_KEY` exported (or any of the other supported provider keys)
- [ ] Fresh clone, `pnpm install` at the repo root

## 1. Install (1 min)
- [ ] `opencues install terminal` runs to completion in under a minute
- [ ] Final line is `✓ Terminal integration ready.`
- [ ] `ls integrations/terminal/node_modules/@opencues/{core,runtime}` shows both staged
- [ ] `ls integrations/terminal/node_modules/@opencues/core/node-http-adapter.js` exists at the package root (NOT inside `dist/`) — this is the LF-7 trap repeat point

## 2. Doctor sanity (10 s)
- [ ] `opencues doctor` shows a `Terminal (oc-edit)` section with all four ticks green
- [ ] No `WARN: bun not on PATH` finding

## 3. Boot + minimal cue (1 min)
- [ ] `bun integrations/terminal/bin/oc-edit` opens a full-screen TUI with a single textarea + statusline at the bottom
- [ ] `tail -f /tmp/opencues.log | grep '\[term\]'` (in another shell) shows:
  - `OpenCues runtime starting (Terminal v1)` with `host: terminal`
  - `ConfigLoader: USER.md → N fields`
  - `Resolver: built with 5 sources [sentence-cue:more-formal, word-cues, config-intent, fluid-blank, transform-blank]`
- [ ] Type `the attorney filed today` — at least one word (e.g. `attorney`) gets a dim underline within ~1 second
- [ ] Cursor onto a dimmed word and press **Ctrl+Alt+↑** — the word changes to an alternative; statusline shows `word (1/N) - tip`
- [ ] Ctrl+Alt+↑ again — cycles to the next alt
- [ ] Ctrl+S — TUI exits, the final buffer content is printed to stdout

## 4. Blanks (2 min)
- [ ] Re-launch `oc-edit`, type `volume _` (assuming `defaults/blanks/volume/` is in your `~/.cues/`)
- [ ] The `_` resolves to a number (e.g. current system volume) within a second
- [ ] Ctrl+Alt+↑ steps the value up; the OS volume changes
- [ ] Backspace fully wipes the blank — buffer ends `volume ` again
- [ ] Type `the lawyer is _` and wait — `_` is replaced with a fluid-blank suggestion in italics

## 5. Agent rewrite (1 min)
- [ ] Append `agentically rewrite this more formally` to a sentence
- [ ] Within ~2s, the buffer is rewritten by the agent; statusline shows `[task: ...]` while it works
- [ ] Down-arrow reverts the rewrite

## 6. ZLE widget (zsh users only, optional — 2 min)
- [ ] Drop into `~/.zshrc`:
  ```zsh
  oc-edit-buffer() {
    local tmp="$(mktemp)"
    print -r -- "$BUFFER" | oc-edit --out "$tmp"
    BUFFER="$(<"$tmp")"; rm -f "$tmp"
    zle redisplay
  }
  zle -N oc-edit-buffer
  bindkey '^E' oc-edit-buffer
  ```
- [ ] Open a new shell, type a partial command (`git commit -m "the attorney"`), hit **Ctrl+E**
- [ ] oc-edit opens with the current $BUFFER; edit + Ctrl+S returns to the prompt with the edited text in $BUFFER
- [ ] Pressing Enter at the shell runs the edited command

## 7. $EDITOR mode (1 min)
- [ ] `EDITOR="$PWD/integrations/terminal/bin/oc-edit" git commit --allow-empty` in any git repo
- [ ] oc-edit opens with the standard `# Please enter the commit message...` template
- [ ] Cycling works on words in the prefilled commit-template body
- [ ] Ctrl+S writes the edited file; `git log -1` shows the message

## 8. Cross-terminal key handling (5 min — long tail)
Verify Ctrl+Alt+↑/↓ actually cycles on each terminal you care about:
- [ ] WSL/Linux: Alacritty
- [ ] WSL/Linux: Windows Terminal
- [ ] WSL/Linux: tmux pane (Alt forwarding can swallow keys)
- [ ] macOS Terminal.app (Alt is the macOS menu key — may need `Option ↑` instead of `Alt ↑`)
- [ ] macOS iTerm2 (Profiles → Keys → Left/Right Option = Esc+ if no response)
- [ ] macOS Ghostty / Kitty

This list mirrors the long-tail the OC + Gemini integrations already document in their REPAIR.md files. Failures here aren't blockers for merge — they're reasons to add a `KEY-COMPAT.md` for the terminal app.

## 9. Uninstall (10 s)
- [ ] `opencues uninstall terminal` removes `integrations/terminal/node_modules/@opencues/*/`
- [ ] `opencues install terminal --dry-run` shows the plan; **no files modified**

## Known not-yet-shipped (won't be in this PR)
- A published `oc-edit` npm bin (today: install from clone only — same as opencode + gemini-cli)
- The agentic-harness drive for `oc-edit` (the private tests/agentic/ repo will need a `terminal` profile added)
- A REPAIR.md for the terminal band (will accrete its first quirk only when one shows up)

## If anything fails
- Logs: `/tmp/opencues.log` (look for `[term]` lines)
- Trace: `OPENCUES_TRACE_CURSOR=1` env var enables `/tmp/opencues-cursor-trace.log` (parity with OC)
- Bridge: `OPENCUES_BRIDGE=1` opens the JSONL event bridge for off-process inspection

File issues against `integrations/terminal/` with the relevant /tmp log attached.
