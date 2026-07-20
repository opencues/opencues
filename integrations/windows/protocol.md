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
| `focus` | `app`, `text`, `cursor`, `cycling` | An **attachable** field gained focus (already passed the shim's editable + non-sensitive + not-deny-listed checks). Carries the field's current contents. `cycling` (phase 2): true when the field is UIA-attached with a managed TextPattern — the shim can hook chords + paint the overlay there; feeds the adapter's per-field `supportsCycling`. The daemon treats this as a hard buffer boundary → `resetBufferState()` then seeds the mirror. |
| `blur` | `app` | Focus moved to something we don't touch (browser, terminal, password box, non-editable). Daemon detaches + resets. |
| `text` | `text`, `cursor` | The focused field's text changed (user typed / pasted). Daemon updates its mirror; if `_` count increased it synthesises a `_` keystroke first (explicit-`_` gate) then fires `notifyTextChange`. `cursor` is the real caret on cycling fields (TextPattern2 GetCaretRange), text length elsewhere. |
| `cursor` | `cursor` | Caret moved without a text change. Phase 2 sends the real caret on cycling UIA fields (polled per tick, suppressed while the write bracket is open); non-cycling fields never send it. |
| `key` | `id`, `key`, `mods{ctrl,alt,shift,meta}` | A chord the WH_KEYBOARD_LL hook intercepted (Ctrl+Alt+arrows, swallowed; `escape` observe-only). Daemon replies `key-result`. |
| `ping` | — | Liveness. Daemon replies `pong`. |

## Daemon → Shim (WSL → Windows)

| `t` | Fields | Meaning |
|---|---|---|
| `welcome` | `host`, `hostVersion`, `protocol`, `cuesHome`, `cuesHomeWin`, `logFile`, `logFileWin` | Reply to `hello`. The `*Win` variants are Windows-openable paths (a `\\wsl.localhost\...` UNC path when the daemon runs in WSL) so the tray's "Open config folder" / "View log" resolve to the right place. |
| `set-text` | `text`, `cursor` | Replace the focused field's whole value (an LLM substitution, blank fill, or a loading-spinner frame). Shim applies via UIA `ValuePattern.SetValue` and suppresses the resulting echo. |
| `set-cursor` | `cursor` | Move the caret. Phase 2: applied via `EM_SETSEL` on Edit-family HWNDs, native-UIA collapsed-range `Select()` elsewhere; best-effort. |
| `render` | `dim` (array of `[start,end)` pairs), `hl` (`[start,end)` or null), `style` (`underline`\|`wash`\|`repaint`) | Phase 2: the runtime's dim ("has alternatives") spans + the single active/cycling span, as char offsets into the mirror text. The shim resolves them to physical screen rects via TextPattern `GetBoundingRectangles` and paints the click-through overlay. Empty `dim` + null `hl` clears the overlay. `style` comes from the daemon's `OPENCUES_WIN_OVERLAY_STYLE` env so the three dim looks can be compared without a Windows-side rebuild. |
| `key-result` | `id`, `consumed` | Whether the runtime consumed a `key`. If `false`, the shim re-injects the chord marked with `INJECT_MARK` in `dwExtraInfo` so its own hook passes it through to the app. |
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
