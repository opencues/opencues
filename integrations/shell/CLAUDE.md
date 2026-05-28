# CLAUDE.md — Shell integration

`@opencues/shell` — a standalone Bun + OpenTUI + SolidJS app that
hosts the OpenCues runtime. Unlike CC / OC / Gemini there is no
upstream fork to patch — we own the entire app. The user-facing entry
point is `oc-shell` (a bash script that wraps the user's interactive
shell in a private tmux session); `oc-edit` is the internal Bun host
that `oc-shell` lazy-spawns inside that tmux session when the user
opens the input box.

## Why this exists

Native CLI hosts (CC, OC, Gemini) all already have their own editor
loops, and OpenCues plugs into theirs. A user who isn't running any
of those still has a shell — but a raw bash/zsh prompt can't host the
runtime (no persistent buffer, no `onRender` surface). The shell
integration plugs that gap: `oc-shell` wraps your prompt in a tmux
session and exposes an input box on **Alt+Shift+↑** which lazy-spawns
the Bun/OpenTUI host underneath. On submit the buffer is pasted back
into the shell at the cursor; on cancel the prompt is restored to its
pre-open state.

## Where things live

### User-facing commands (symlinked by `setup.sh --link`)

| File | Role |
|---|---|
| `bin/oc-shell` | Main entry point. Wraps `$SHELL` in a private tmux session (`-L opencues-$$ -f conf/shell.tmux.conf`), starts the daemon, exports the `OPENCUES_*` env vars internal helpers need, then `tmux attach`s. |
| `bin/oc-install-tmux` | Builds tmux 3.4 from source into `~/.opencues/vendor/tmux/`. Required once before `oc-shell` first runs. System tmux is never touched. |
| `bin/oc-install-shell-integration` | One-time setup that writes `~/.opencues/shell-integration.{bash,zsh,fish}` and appends a `source` line to the user's rc. Enables the "capture current readline buffer on Alt+Shift+↑" behaviour. |

### Internal helpers (never symlinked — reached via `oc-shell`'s PATH adjustment)

| File | Role |
|---|---|
| `bin/oc-shell-init` | First pane command inside the new tmux session. Just `exec`s `$SHELL` — there's no eager split anymore (input box is lazy). |
| `bin/oc-open-input` | Resolves the current pane id and runs `tmux split-window` to lazy-spawn `oc-edit` in a 15-row pane below the shell. Tmux's M-C-s / M-S-Up bindings call this via `run-shell -b`. Exists because tmux doesn't format-expand `#{pane_id}` inside `split-window`'s shell-command argument — resolving in bash works. |
| `bin/oc-edit` | Bun entrypoint for the OpenTUI host. Spawned by `oc-open-input` with `--keep-alive --target-pane <shell pane>`. Reads `$OPENCUES_LINE_BUF` for shell-integration-captured initial text on startup. On submit/cancel calls `tmux send-keys -t <shell>` then `tmux kill-pane` on itself — restoring the idle layout (shell + brand bar only). |
| `bin/oc-popup` | Legacy popup wrapper from the pre-slide-pane design. Unused by the current bindings; kept as a fallback path for `--out tmpfile` invocations and external scripting. |
| `bin/oc-editd` | Pre-load daemon. Reads `~/.cues/` once and serves the config snapshot over a unix socket. `oc-edit`'s bootstrap consults the socket before falling through to direct fs reads. See `DAEMON-PLAN.md`. |

### Config + source

| File | Role |
|---|---|
| `pin.json` | OpenTUI version pin (no upstream fork — what's pinned is the renderer stack). |
| `compat.json` | Declared compatibility (`host-kind: self`). |
| `patches/setup.sh` | One-command installer (Bun, build runtime, optional symlink). |
| `conf/shell.tmux.conf` | Private tmux config loaded by `bin/oc-shell` (doesn't touch `~/.tmux.conf`). Holds all Alt+Shift+arrow + Ctrl+Alt+\* bindings, status-bar format, pane styling. |
| `src/app.tsx` | The Solid app — `<textarea>` (full-pane in keep-alive mode; with statusline below in legacy popup mode). |
| `src/bootstrap.ts` | OpenCues wiring (analog of `integrations/opencode/patches/opencuesBootstrap.ts`, but without the holder/publish dance). |
| `src/daemon.ts` | The `oc-editd` source. |
| `src/daemon-client.ts` | Snapshot-fetch client used by `bootstrap.ts`. |
| `../../packages/opencues-runtime/adapters/shell/v1/` | Adapter band. |

## Keybinding map (defined in `conf/shell.tmux.conf`)

All advertised chords are **Alt+Shift+arrow** so the user's hand
stays on one modifier group. Other chords work as silent aliases.

| Chord (advertised) | From shell pane | From input pane | Implementation |
|---|---|---|---|
| **Alt+Shift+↑** | Open input box (capture current line if shell-integration installed) | no-op | `send-keys M-m` (fires shell capture binding) + `run-shell -b $OPENCUES_OC_OPEN_INPUT` |
| **Alt+Shift+↓** | no-op | Cancel + restore captured line | `send-keys Escape C-q` → `oc-edit`'s `finish('', 130)` runs `restoreOnCancel` logic |
| **Alt+Shift+→** | no-op | Submit (paste textarea into shell) | `send-keys Escape C-s` → `oc-edit`'s `finish(text, 0)` |
| **Alt+Shift+←** | Exit `oc-shell` (kill-session) | no-op | `kill-session` |

Silent aliases (handled in `useKeyboard` inside `app.tsx`):

- **Ctrl+S / Ctrl+Alt+S** → submit
- **Esc / Ctrl+Q / Ctrl+Alt+Q** → cancel
- **F2** → same as Alt+Shift+↑ / Ctrl+Alt+S (open / submit)
- **Ctrl+Alt+X** → exit (same as Alt+Shift+←)

## Shell-integration (capture-current-line)

When the user runs `oc-install-shell-integration`, a snippet is
installed into `~/.opencues/shell-integration.{bash,zsh,fish}` and a
source line is appended to the appropriate rc. The snippet binds the
internal key `\em` (Alt+m) to a function that:

1. Reads the current readline buffer (`$READLINE_LINE` in bash,
   `$BUFFER` in zsh, `commandline` in fish).
2. Clears the line.
3. Writes the captured text to `$OPENCUES_LINE_BUF` (a per-session
   tempfile exported by `bin/oc-shell`).

The user never presses `Alt+m` directly. Tmux's `M-S-Up` binding
sends `M-m` to the shell pane *first*, then runs `oc-open-input`. By
the time `oc-edit` starts up (~1s for Bun module load), the file has
been written. `oc-edit`'s `main()` reads it, uses it as initial
textarea text, and stashes it as `restoreOnCancel` so cancel paths
re-paste it back into the shell.

Why a separate `\em` chord rather than binding `\e[1;4A` (the actual
escape sequence for Alt+Shift+↑) in the shell directly: tmux's
root-level `M-S-Up` binding intercepts the chord *before* the shell's
readline gets it. The shell never sees `Alt+Shift+↑` — we have to
re-inject a key the shell *can* see, hence the `M-m` indirection.

## Differences vs the OC band

OpenTUI is identical between OC and terminal, so the adapter band is
a near-clone of `adapters/oc/v1.14/` with:

- `hostName: 'shell'`, `hostVersion: '0.1.0'`
- No SolidJS reactive holder (`__ocPromptHolder`) — app.tsx hands the
  textarea + syntax refs straight to `startOpenCues()` on mount.
- No CC/OC-fork plugin lifecycle hooks (`promptAccess.write`, etc.).
- No statusline-to-footer SolidJS signal — the statusline tip lands
  in a plain Solid signal owned by `App` and rendered in `<text>`.

Everything else (extmark applier, spawn sandbox, audit log, user
blanks loader, multi-provider key bag, agent-rewrite wiring) is a
direct port.

## OpenTUI extmark contract (read before touching `triggerOpenCuesRender`)

Same trap as OC. `editBuffer.setText` / `replaceText` / `clear`
nuke every extmark; insert/delete/newline/undo only adjust. Our
runtime-driven writes (cycling, agent edits, BlankFill substitute)
funnel through `textarea.setText` → all extmarks gone → next render
must rebuild from scratch. `setText`/`pushText` in `bootstrap.ts`
reset `ownedExtmarks = new Map()` to force the rebuild. See
`packages/opencues-runtime/adapters/oc/REPAIR.md` § "OpenTUI extmark
contract" for the full ADJUSTS-vs-CLEARS table — same applies here.

## Repair guide

Shell-specific quirks (separate from the OpenTUI-shared OC ones)
are catalogued in `packages/opencues-runtime/adapters/shell/REPAIR.md`
— LT-1 through LT-4 today. Check both REPAIR files after any version
bump of `@opentui/core` or `@opentui/solid`: the OC catalogue is
authoritative for OpenTUI bugs that bite both bands; the terminal
catalogue covers the install-boundary quirks unique to a self-owned
host (bunfig discovery, JSX preload, etc.).

## Iteration loop

```bash
bun --cwd integrations/shell install
# run the host directly (no shell wrapper) for fast iteration:
bun --cwd integrations/shell src/app.tsx
# or after a runtime change:
pnpm --filter @opencues/runtime build && bun --cwd integrations/shell src/app.tsx
```

## Debugging

- **`tail -f /tmp/opencues.log | grep '\[term\]'`** — runtime logs.
- **`tail -f /tmp/oc-editd.log`** — daemon logs.
- **`tail -f /tmp/oc-shell-init.log`** — shell-init diagnostics
  (env-var availability at session start).
- Set `DEBUG_OPENCUES=1` for verbose user-blank load tracing.
- Set `OPENCUES_BRIDGE=1` to enable the event-bridge for off-process
  inspection (same protocol as OC).

## Per-buffer state reset

Shell's `oc-edit --keep-alive` keeps a single bun process alive
across multiple slide-pane sessions. Each Alt+Shift+↑ is
logically a fresh session but physically the SAME runtime
instance — so we MUST clear per-buffer state at the session
boundary or state from session N leaks into N+1 (DynDefs with
`blankName` set silently block the next blank substitute via the
resolver's existing-def guard).

| Trigger | Call site | What clears |
|---|---|---|
| Submit (Alt+Shift+→ / Ctrl+Alt+S) | `app.tsx:finish()` → `resetOpenCuesBufferState()` | DynDefs, HighlightState, SpanFill, SelectorSatellite |
| Cancel (Alt+Shift+↓ / Esc / Ctrl+Alt+Q) | same path (finish with exitCode 130) | same |
| In-session buffer wipe (Ctrl+C) | `app.tsx:useKeyboard` Ctrl+C branch — `textarea.setText('')` + `resetOpenCuesBufferState()` | same |
| Pane killed by tmux directly | n/a (process exits, fresh boot on next open) | n/a |

Bug history (2026-05-28): this wasn't wired on launch. Symptom
was a prompt-improver in session N would silently block ALL
blanks in session N+1 — bare `_`, `translate to french _`,
`improve prompt _`, etc. — with no log line. The resolver's
`if (existing && existing.blankName) continue` guard at the
DynDef collision check was the culprit. See
`docs/architecture/universal-integration.md` § "When to call
`resetBufferState()` — the full trigger list" for the cross-host
contract.

`AgentTaskState` and `dismissedBlanks` deliberately persist
across sessions per the chrome contract (an armed agent task
should outlive a panel close + reopen).
