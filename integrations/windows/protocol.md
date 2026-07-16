# OpenCues Windows bridge — wire protocol

Newline-delimited JSON over a TCP socket. The **WSL daemon**
(`src/hostd.cjs`) is the server; the **Windows shim**
(`native/OpenCuesWindows.cs`) is the client. WSL2 forwards a Linux
`127.0.0.1:<port>` listener to the Windows host's `127.0.0.1`, so the
shim just dials localhost.

`protocol` version: **1**. One JSON object per line, UTF-8, `\n`
terminated. Unknown message types are ignored (forward-compat).

The design mirrors the runtime's existing `event-bridge` (text /
cursor / key inject + observe) — the shim is essentially a live driver
of that same surface, one socket hop away.

## Shim → Daemon (Windows → WSL)

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `version`, `os` | First message on connect. |
| `focus` | `app`, `text`, `cursor`, `ctrlName`?, `help`?, `winTitle`? | An **attachable** field gained focus (already passed the shim's editable + non-sensitive + not-deny-listed checks). Carries the field's current contents. The daemon treats this as a hard buffer boundary → `resetBufferState()` then seeds the mirror. The optional `ctrlName` (UIA control `Name`), `help` (UIA `HelpText`), and `winTitle` (foreground window title) are the field's OWN ambient metadata — the daemon maps them to `AmbientContext` (label / placeholder / pageTitle; `app` → app) for fluid-blank disambiguation + app-aware output steering when `ambient-context-mode: on`. **Field-only: never a sibling control's value.** Absent on an older shim → the daemon degrades to no ambient context. |
| `blur` | `app` | Focus moved to something we don't touch (browser, terminal, password box, non-editable). Daemon detaches + resets. |
| `text` | `text`, `cursor` | The focused field's text changed (user typed / pasted). Daemon updates its mirror; if `_` count increased it synthesises a `_` keystroke first (explicit-`_` gate) then fires `notifyTextChange`. |
| `cursor` | `cursor` | Caret moved without a text change. (Phase 1 sends caret = text length; real caret tracking is phase 2.) |
| `key` | `id`, `key`, `mods{ctrl,alt,shift,meta}` | A chord the shim intercepted (phase 2 — needs the keyboard hook). Daemon replies `key-result`. |
| `ping` | — | Liveness. Daemon replies `pong`. |

## Daemon → Shim (WSL → Windows)

| `t` | Fields | Meaning |
|---|---|---|
| `welcome` | `host`, `hostVersion`, `protocol`, `cuesHome`, `cuesHomeWin`, `logFile`, `logFileWin` | Reply to `hello`. The `*Win` variants are Windows-openable paths (a `\\wsl.localhost\...` UNC path when the daemon runs in WSL) so the tray's "Open config folder" / "View log" resolve to the right place. |
| `set-text` | `text`, `cursor` | Replace the focused field's whole value (an LLM substitution, blank fill, or a loading-spinner frame). Shim applies via UIA `ValuePattern.SetValue` and suppresses the resulting echo. |
| `set-cursor` | `cursor` | Move the caret. (Phase 1: no-op — caret assumed at end.) |
| `key-result` | `id`, `consumed` | Whether the runtime consumed a `key` (phase 2). If `false`, the shim lets the chord through. |
| `pong` | — | Reply to `ping`. |

## Echo suppression

`set-text` → the shim writes the value → UIA fires a value-change →
the shim would read it back and send a `text` for the value it just
wrote, creating a loop. Both sides guard:

- **Shim**: records the value it wrote (`_expectedEcho`); skips the
  next `text` whose value equals it.
- **Daemon**: records the value it pushed (`expectedEcho`); swallows a
  matching inbound `text` as a no-op.

Belt-and-braces: either guard alone closes the loop, but a
race (user edits in the same tick as the write) is only safe with both.

## Attachability (decided on the shim side)

The shim only sends `focus` for fields where **all** hold:

1. Foreground process not in the deny-list (browsers + terminals).
2. `ControlType` is `Edit` or `Document`.
3. Not a password field (`IsPassword`) and no sensitive token in
   `Name`/`AutomationId` (password / otp / cc-number / cvv / …).
4. A writable `ValuePattern` is present (phase-1 write path). Fields
   with only `TextPattern` (some Electron/Chromium editors) are
   read-only to us and skipped until phase 2.

Everything else → `blur` (daemon detaches). This keeps credentials and
non-editable surfaces out of the LLM pipeline by construction.

## Config HTTP server (separate from this socket)

Alongside the socket protocol above, the daemon runs a **second** server:
an HTTP config server on `127.0.0.1:<socket-port + 1>` that serves the
shared settings popup + a keys/settings API (`/api/config`, `/api/keys`,
`/api/status`). That's a different transport for a different consumer
(the tray's WebView2 window / a browser), not part of the shim protocol.
Full endpoint table: `CLAUDE.md` § "The shared settings component".

## Presence

The daemon writes `/tmp/opencues-hosts/windows-<pid>.json`
(`{host, pid, port, app, attached, startedAt, updatedAt}`) so any other
OpenCues process on the machine can see it exists and what it's attached
to. This is the seed for cross-host precedence arbitration (deferred).
