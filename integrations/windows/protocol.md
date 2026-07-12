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
| `focus` | `app`, `text`, `cursor`, `tsf?` | An **attachable** field gained focus (already passed the shim's editable + non-sensitive + not-deny-listed checks). Carries the field's current contents. The daemon treats this as a hard buffer boundary → `resetBufferState()` then seeds the mirror. `tsf:true` means a live OpenCues TSF TIP is present for this field, so writes take the flash-free path (see § TSF write transport). |
| `blur` | `app` | Focus moved to something we don't touch (browser, terminal, password box, non-editable). Daemon detaches + resets. |
| `text` | `text`, `cursor` | The focused field's text changed (user typed / pasted). Daemon updates its mirror; if `_` count increased it synthesises a `_` keystroke first (explicit-`_` gate) then fires `notifyTextChange`. |
| `cursor` | `cursor` | Caret moved without a text change. (Phase 1 sends caret = text length; real caret tracking is phase 2.) |
| `key` | `id`, `key`, `mods{ctrl,alt,shift,meta}` | A chord the shim intercepted (phase 2 — needs the keyboard hook). Daemon replies `key-result`. |
| `ping` | — | Liveness. Daemon replies `pong`. |

## Daemon → Shim (WSL → Windows)

| `t` | Fields | Meaning |
|---|---|---|
| `welcome` | `host`, `hostVersion`, `protocol`, `cuesHome`, `cuesHomeWin`, `logFile`, `logFileWin`, `tsf` | Reply to `hello`. The `*Win` variants are Windows-openable paths (a `\\wsl.localhost\...` UNC path when the daemon runs in WSL) so the tray's "Open config folder" / "View log" resolve to the right place. `tsf` is the flash-free-path **kill switch** — `true` (default) lets the shim auto-use a live TIP; `false` forces the legacy path (§ TSF write transport). |
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

## TSF write transport (flash-free writes — automatic when installed)

The default write path (`set-text` → UIA `ValuePattern.SetValue` / MSAA
paste) has an irreducible cosmetic cost on some editors: a select-all
flash (Discord's Slate, Slack) or undo-granularity loss. The
`native/tsf/` **Text Services Framework TIP** removes it — an in-process
COM DLL that replaces the focused document via `ITfRange::SetText`
through the input pipeline (flash-free, no Slate ghost).

**It engages automatically — no mode to turn on.** Installing the TIP
is a deliberate, UAC-gated act, so a live TIP for the focused app is
itself the signal; a separate opt-in flag would be redundant friction.

**The daemon can't drive the TIP directly.** The TIP serves a Windows
named pipe (`\\.\pipe\opencues-tsf-<pid>`), and the daemon runs in WSL2,
which can't open a Windows named pipe. So the split is:

- **Shim is the pipe client.** On each focus it checks whether a TIP
  pipe exists for the app (`File.Exists(\\.\pipe\opencues-tsf-<pid>)` —
  O(1), so no probe stall when nothing's installed) and, if so,
  confirms it with a `GETCARET` (cached per field), reporting
  `tsf:true/false` on the `focus` event. When a TIP is live it writes
  **every** `set-text` — loading-animation frames AND the final
  substitution — via `SETTEXT` over the pipe. TSF must be the SOLE
  writer on a TSF field: mixing the shim's typed spinner frames
  (`SendInput`) with a TSF final `SetText` corrupts Slate's model
  (Discord double / undeletable ghost — different input layers), so on a
  TSF field the typed micro-edit path is bypassed entirely.
- **Fallback is automatic.** Any pipe failure (no TIP installed, pipe
  busy, timeout) falls straight through to the existing UIA/MSAA path.
  Nothing regresses when the TIP isn't there.
- **Kill switch.** `OPENCUES_TSF=0` — on the daemon (→ `welcome
  tsf:false`) or on the shim itself — forces the legacy path if the
  spike write path ever misbehaves.

The pipe command/event protocol is documented in `native/tsf/README.md`.

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
