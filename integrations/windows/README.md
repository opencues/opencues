# OpenCues for Windows

A **system-wide** OpenCues host for Windows. Type `_` in almost any
Windows text field — Notepad, WordPad, a settings dialog, a WinForms /
WPF app — and OpenCues fills it in, using the same `~/.cues` config and
the same LLM keys as the rest of your OpenCues setup.

It has two halves:

```
   Windows                                  WSL
 ┌──────────────────────┐               ┌────────────────────────────┐
 │ OpenCuesWindows.ps1  │   socket      │ oc-windows  (hostd.cjs)     │
 │  + OpenCuesWindows.cs │ ────────────▶ │  @opencues/runtime          │
 │  UI Automation shim   │  127.0.0.1    │  windows adapter band       │
 │  (reads/writes the    │ ◀──────────── │  reads ~/.cues, uses your   │
 │   focused text field) │  set-text     │  GROQ/etc. keys             │
 └──────────────────────┘               └────────────────────────────┘
      thin, no logic                        the brain (same runtime
                                            every other WSL host uses)
```

The **brain runs in WSL** — it *is* your existing OpenCues install. No
second config, no re-entering keys, no sync. Edit a cue for `claude-cues`
and this host hot-reloads it. The Windows side is a thin shim that only
watches the focused field via UI Automation and applies what the runtime
sends back.

## Requirements

- **WSL2** with OpenCues checked out and `pnpm install` run.
- On Windows: **Windows PowerShell 5.1** (`powershell.exe` — built into
  Windows 10/11). No .NET SDK — the shim is compiled on-demand by
  `Add-Type`.
- An LLM key in your WSL environment (e.g. `export GROQ_API_KEY=…`), the
  same one your other hosts use.

## Install & run (seamless — one command)

```bash
# In WSL, once:
pnpm exec opencues install windows

# Then, from WSL — this ONE command brings the whole thing up on Windows:
oc-windows            # (or: opencues run windows)
```

`oc-windows` launches the **tray on Windows** for you (via WSL→Windows
interop); the tray spawns the daemon back inside WSL, runs the shim, and
serves the settings UI. You never leave WSL. **Or** start it from Windows
instead — double-click `native\OpenCuesTray.vbs`, or let it autostart at
login. Either entry point lands in the same place.

You get a **tray icon**. Right-click → **Config source** to flip between
your **WSL `~/.cues`** (default) and **Windows `%USERPROFILE%\.cues`** —
it restarts the daemon on the chosen config. Then focus a text field:

```
the cat sat on teh mat  fix typos _
```

The `_` becomes the corrected sentence. Also in phase 1:

- `weather london _`, `time in tokyo _`, `AAPL stock price _` — compute blanks
- `draft a thank-you note _` — free-form fill
- `<your text> make it more formal _` — rewrite

> **No Windows Node needed** in the default (spawn-wsl) mode — the daemon
> runs on your WSL node via `wsl.exe … bash -lc`. When the tray quits or
> crashes, the WSL daemon self-exits via a heartbeat file (no orphan).
>
> **Dev / manual two-process mode**: run the daemon yourself in WSL
> (`bash integrations/windows/bin/oc-windows`) and launch the tray with
> `-Mode connect` (it won't spawn its own daemon). Or skip the tray
> entirely with the bare shim `OpenCuesWindows.ps1 -Port 51789`.

## What works where

Coverage is per-app, decided by how much UI Automation each field
exposes:

| Works fully | Read-only for now | Not covered |
|---|---|---|
| Notepad, WordPad, most Win32 / WinForms / WPF edit fields, dialog inputs | Some Electron / Chromium editors (TextPattern but no writable ValuePattern) | Browsers (use the Chrome extension), terminals (use the WSL hosts), elevated/admin apps, games |

Browsers and terminals are **skipped on purpose** — the Chrome
extension and the in-terminal hosts are the better surface there, and
skipping avoids double-attaching. (Letting local OpenCues take
precedence *inside* those is planned, not yet built.)

## Phase 2: word-cues, cycling, the overlay

On fields that expose enough UIA (Notepad, WordPad, most Win32/WinForms
dialogs), the host now also runs **word-cues + Ctrl+Alt+arrow cycling**:
cue words are marked by a click-through overlay painted over the app,
Ctrl+Alt+Left/Right walks between them, Ctrl+Alt+Up/Down cycles the
alternatives, and the caret is tracked for real. Fields that can't
(Discord/Slack-class Electron editors) transparently stay on the
single-answer profile (`_` fluid-blank, transform-blank, compute
blanks) — the capability is decided per focused field.

Try the three dim looks (restart the daemon to switch):

```bash
oc-windows                                        # default: live (DWM-thumbnail mirror, dimmed in real time)
OPENCUES_WIN_OVERLAY_STYLE=capture   oc-windows   # snapshot of the app's own glyphs, dimmed
OPENCUES_WIN_OVERLAY_STYLE=underline oc-windows   # thin gray underline
OPENCUES_WIN_OVERLAY_STYLE=wash      oc-windows   # translucent gray tint over the word
```

Opt out entirely with `OPENCUES_WIN_PHASE2=0` (daemon), or disable just
the hook / overlay with `OPENCUES_WIN_HOOK=0` / `OPENCUES_WIN_OVERLAY=0`
(Windows side). Details + limitations: `CLAUDE.md` § Phase 2.

## Tray app, settings & keys, and where config lives

The productized surface is a **system-tray icon** — the one thing you
interact with. Two builds of it, same behaviour:

- **`OpenCuesTray.ps1`** (no toolchain) — a PowerShell tray. "Settings &
  keys…" opens the shared settings UI in your **browser**. Launch hidden
  via `OpenCuesTray.vbs` (also what autostart runs).
- **`OpenCuesTray.exe`** (compiled — `OpenCuesTray.csproj`, needs the
  .NET SDK + the WebView2 runtime) — the native product. "Settings &
  keys…" opens the **same** UI in an embedded window. No browser tab.

Tray menu:

| Item | What it does |
|---|---|
| **Enabled** | Pause/resume without quitting — unchecked, nothing reaches the LLM |
| **Settings & keys…** | Opens the settings UI (provider, model, API keys) — the *same component the chrome extension uses* |
| **Open config folder** | Opens your `.cues` folder |
| **View log** | Opens `opencues.log` |
| **Start at login** | Toggles a per-user autostart entry (no admin) |
| **Quit** | Stops the shim and the daemon |

### The settings UI is the chrome popup

The daemon serves the chrome extension's settings popup over localhost,
backed by your native config files — so keys/provider/model use the
exact same UI on Windows as in the browser. Keys you enter are written
to your `.cues/.env`; provider/model to `.cues/OPENCUES.md`. One
component, two backends.

### Where config lives

| What | Location | Notes |
|---|---|---|
| Cues, blanks, settings, keys | **`%USERPROFILE%\.cues\`** | The Windows equivalent of `~/.cues`. Same files every OpenCues host reads. `.env` holds keys; `OPENCUES.md` holds settings. |
| Share your WSL config instead | set `OPENCUES_HOME` to `\\wsl.localhost\<distro>\home\<you>\.cues` | Makes the Windows host read your WSL cues + keys — "plugged into WSL main OC" without the socket bridge. |
| Tray state (mode, port, autostart) | `%LOCALAPPDATA%\OpenCues\tray.json` | |
| Logs | `%TEMP%\opencues.log` | "View log" opens this. |

### Stopping it

- **Quit** in the tray — stops the shim and kills the daemon.
- **Enabled** unchecked — pauses (stays in the tray, nothing sent to the LLM).
- **Start at login** unchecked — it won't come back after reboot.
- If the tray ever crashes, the daemon exits on its own (it watches the
  tray's process id), so there's no orphaned background process.

## Troubleshooting

- **`waiting for daemon …` on Windows** — the WSL `oc-windows` daemon
  isn't running, or the port differs. Start it first; match the port.
- **Nothing happens when I type `_`** — check the field is a plain edit
  box (not a browser/terminal), and watch the daemon:
  `tail -f /tmp/opencues.log | grep '\[windows\]'`.
- **`Add-Type` errors on Windows** — you're likely on `pwsh` (PowerShell
  7). Use `powershell.exe` (Windows PowerShell 5.1).
- **Can't reach the socket** — rare WSL2 networking modes break
  localhost forwarding. Set the daemon to the WSL IP
  (`OPENCUES_WIN_BIND=0.0.0.0 oc-windows`) and pass that IP to the ps1
  with `-DaemonHost <wsl-ip>`.

Full wire protocol: [`protocol.md`](protocol.md).
