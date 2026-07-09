# Windows integration — implementation notes

This doc is the "how it actually works, and why" record for the OpenCues
Windows host: the problems we hit driving it across real apps
(Notepad, WordPad, Slack, Discord), and the final shape that fixed each
one. It complements `CLAUDE.md` (orientation) and `protocol.md` (the
wire format) — read those first for the big picture; this doc is the
implementation deep-dive.

The recurring theme: **this host observes a foreign app's text buffer by
polling over UI Automation, so it never gets "who typed this?" for
free.** Almost every bug below is a variant of the daemon mistaking its
own write (or an animation frame, or a mangled read-back) for the user
typing, or two processes fighting over one buffer. The fixes are all
about attribution and singleton discipline.

---

## 1. Architecture in one breath

```
Windows (thin shim, no logic)            WSL (the brain)
native/OpenCuesWindows.cs   ── socket ──▶ src/hostd.cjs
  UIA/MSAA read + write      127.0.0.1    boots @opencues/runtime via
  focus tracking             :51789       adapters/windows/v1/boot.ts
  synthetic input            (WSL2 fwd)   keeps a text MIRROR; reconciles
```

- The **shim** (`native/OpenCuesWindows.cs`) is compiled on Windows with
  `Add-Type` (no .NET SDK). It polls `FocusedElement`, reads/writes the
  field, and streams `focus` / `text` / `blur` to the daemon. **No
  OpenCues logic.**
- The **daemon** (`src/hostd.cjs`, in WSL) boots the runtime through the
  `windows` adapter band, using WSL's own `~/.cues` + keys. It keeps a
  **mirror** of the remote field so `getText()` never blocks, and turns
  runtime writes into `set-text` messages back to the shim.
- The **tray** (`native/OpenCuesTray.ps1`, launched hidden via
  `OpenCuesTray.vbs`) is the productized entry point: it hosts the shim
  **in-process** and **spawns the daemon** back into WSL. One tray = the
  whole system. `oc-windows` (run from WSL) launches it via interop.

Profile: **phase 1** = `supportsCycling:false` (Universal-Integration —
single-answer blanks, no colour/chords), and the **caret is assumed at
the end of the field** (text length). Both assumptions are load-bearing
below.

---

## 2. The problems we hit (and what each taught us)

### 2.1 Runaway self-transform loop
**Symptom:** an email draft kept re-transforming itself (e.g. into
Japanese) forever, with nobody typing.

**Cause:** the Windows edit control mangles read-backs — it returns `\r`
for a written `\n`, and injects zero-width chars (U+FEFF/U+200B/U+200C)
between paragraphs. So the daemon's byte-equality echo check
(`text === expectedEcho`) failed on its own output coming back, treated
it as a fresh user edit, and re-resolved it — output becomes input,
forever.

**Fix:** normalise before comparing. `normBuf` (`hostd.cjs:242`) strips
the zero-widths and collapses `\r\n?`→`\n`; a **recent-writes TTL ring**
(`noteWrite`/`isRecentWrite`, `hostd.cjs:247`, 4s TTL) catches late,
mangled echoes that arrive after `expectedEcho` was already cleared.

### 2.2 `_` sometimes didn't resolve
**Symptom:** intermittently, typing a command ending in `_` did nothing.

**Cause:** the recent-writes ring was *too* aggressive — the loading
animation's `_`-restore frame is byte-identical to the user's command
text, so the ring swallowed the genuine trigger as if it were an echo.

**Fix:** an echo may only be swallowed if it does **not add an
underscore** vs the mirror: `isRecentWrite(text) && countUnderscores(text)
<= countUnderscores(mirrorText)` (`hostd.cjs:476`). A fresh user `_`
raises the count, so it's never mistaken for an echo.

### 2.3 Only resolved on the *space after* `_`
**Symptom (user's sharp catch):** the blank fired only once you typed a
space after `_`, not on `_` itself — "does it only see previous text?"

**Cause:** the circuit-breaker counted *every* resolve and tripped on
normal fast typing, swallowing the `_` keystroke event and leaving the
resolver with stale `previousText`. The next keystroke (space) carried
the now-current text, so it "worked" one char late.

**Fix:** the breaker only trips on the **same normalized text resolved
repeatedly** (`breakerTrips`, `hostd.cjs:281`: `BREAKER_SAME_TEXT_MAX=6`
consecutive identical resolves → `BREAKER_COOLDOWN_MS=1500` pause). It
resets on any new text, so ordinary typing never trips it; only a true
output-becomes-input loop does.

### 2.4 Freezes / no self-heal / "the tray is empty"
**Symptom:** the field oscillated spinner↔final, or froze mid-animation;
restarts didn't help.

**Cause:** **process pollution.** Debug restarts had accumulated
multiple daemons and multiple shims. **Two shims writing the same field
is unwinnable** — each sees the other's writes as user edits and they
trample each other. There is no per-write ownership across two shims.

**Fix:** enforce a **strict singleton** (§3) and give it a **reset
script** (§4) so recovery is one deterministic command instead of
hand-killing processes.

### 2.5 WordPad cursor jumped during the loading animation
**Symptom:** on a short WordPad buffer, the caret bounced start→end
rapidly while the spinner played; stable on long buffers.

**Cause:** every write — including each spinner frame — did
`ValuePattern.SetValue`, which resets the caret to the field **start**;
we then `RestoreCaretToEnd`. Doing that per frame (~13×/sec) yanked the
caret start→end each frame. On a long buffer the caret already sits near
the end so the jump is invisible.

**Fix (two layers):** first, skip the caret restore on
animation frames (`LooksLikeAnimationFrame`, §6). Then the deeper fix —
**don't `SetValue` for animation frames at all**; type them (§5). No
`SetValue`, no caret reset, nothing to repair.

### 2.6 The phantom "respawning shim" (a measurement bug)
**Symptom:** while cleaning up, a standalone shim appeared to respawn
within ~1s every time it was killed — looked like an invisible watchdog.

**Cause:** the *counting query itself*. A PowerShell
`Get-CimInstance … Where CommandLine -like '*OpenCuesWindows.ps1*'`
**matches its own command line** (the query string contains the
pattern). Every poll returned 1 — it was seeing itself — and each
kill-then-recheck reported a "new PID" that was just the next query
process. There was never a second shim.

**Fix / rule:** every process count excludes cmdlines containing
`Get-CimInstance` (baked into `oc-windows-reset`). Do the same for any
ad-hoc check. This one cost a long detour; it's why the reset script
verifies with a self-excluding filter.

---

## 3. Singleton — by construction

The system is designed so there is exactly **one** of everything, and
the pieces are lifecycle-bound so they can't outlive each other:

```
 OpenCuesTray.vbs ──(wscript, hidden)──▶ OpenCuesTray.ps1  (ONE tray process)
                                            │
             Add-Type OpenCuesWindows.cs ───┤  in-process UIA shim (ONE)
                                            │
             wsl.exe -d Ubuntu bash -lc ────┴─▶ node hostd.cjs  (ONE WSL daemon)
                        + heartbeat file /tmp/oc-win-hb-51789
```

- **One tray** hosts the shim in-process (`[OpenCues.WindowsShim]::Start`)
  — so tray and shim can never be separate counts.
- **The daemon is spawned by the tray** into WSL, with a **heartbeat
  file** the tray keeps fresh (`OPENCUES_HEARTBEAT_FILE=/tmp/oc-win-hb-$PORT`,
  `OPENCUES_HEARTBEAT_TIMEOUT_MS=8000`, 4s startup grace). If the tray
  quits or crashes, the heartbeat goes stale and the **daemon self-exits
  — no orphan.**
- **Ports:** daemon on `127.0.0.1:51789`; the shared settings server on
  `:51790` (port+1, 127.0.0.1-only).

The two `wsl.exe` processes you'll see in a healthy state are just
interop relays for the daemon spawn; only **one** actual `node hostd.cjs`
runs (that's the count that matters).

**Never run a second shim against the same session.** The dev paths
(`-File OpenCuesWindows.ps1` standalone shim; bare
`node hostd.cjs`) exist for isolated testing and must not coexist with a
tray. When in doubt, reset (§4).

---

## 4. Reset script — `bin/oc-windows-reset`

One command that guarantees a clean, verified singleton. Run from WSL.

```bash
integrations/windows/bin/oc-windows-reset       # teardown + relaunch + verify
integrations/windows/bin/oc-windows-reset --down       # teardown only
integrations/windows/bin/oc-windows-reset --no-launch  # teardown + verify clean
```

**Teardown** (loop-killed for a few seconds to outpace any respawner,
then converged to zero):
- Windows: every process whose cmdline matches
  `OpenCuesWindows.ps1 | OpenCuesTray.ps1 | OpenCuesTray.vbs | hostd.cjs`
  (tray, standalone shims, spawn-win node, daemon relays).
- WSL: `pkill -f 'windows/src/hostd.cjs'` (the daemon) + any leftover
  watchdog/monitor bash loops referencing the port/shim (guarding
  against killing the script's own shell).
- State files: the heartbeat (`/tmp/oc-win-hb-$PORT`) and presence
  entries (`/tmp/opencues-hosts/windows-*.json`).

**Launch:** delegates to `oc-windows` (canonical: builds the runtime if
missing, then `wscript OpenCuesTray.vbs` → tray → daemon + shim). The
shim recompiles `OpenCuesWindows.cs` on launch, so a reset always
deploys the latest source.

**Verify:** polls up to 30s for a *proven* singleton — port listening,
`daemon=1`, `tray≥1`, and the `shim connected to daemon` handshake in
new log lines — or fails loudly.

**Counting discipline (do not remove):** every counter excludes
cmdlines containing `Get-CimInstance` (the §2.6 self-match), and
`count_daemon` matches real `node …hostd.cjs` processes only (never the
grep or a `bash -c` wrapper). The script is **idempotent** — a second
run tears down the first and converges to the same state.

---

## 5. Write paths + the typed micro-frame animation

`ApplySetText` (`OpenCuesWindows.cs:678`) picks a write mechanism by how
the focused field exposes itself:

| Path | Apps | Mechanism |
|---|---|---|
| **UIA `ValuePattern.SetValue`** | Notepad, WordPad, Explorer, Win32/WinForms/WPF | whole-value replace, atomic |
| **UIA `TextPattern` paste** | Chromium/Electron with a `TextPattern` but no writable `ValuePattern` | clipboard + Ctrl+A + Ctrl+V |
| **MSAA deferred paste** | Electron whose focused UIA element is an empty read-only shell (text in the MSAA/IA2 tree) — Discord | Ctrl+A + Ctrl+V, coalesced when the stream goes quiet |

**Above all three sits one shared fast path for animation frames:
`TryTypeMicroEdit`** (`OpenCuesWindows.cs:1320`), called *before* the
attach-mode branches. This is the "backspace animation."

How it works:
1. Diff the new text against `_lastSentText` (the last thing we wrote).
2. Proceed only if it's a **small tail edit** — the changed suffix
   (from first-difference to end) is ≤ `MSAA_TYPE_MAX` (6) chars, no
   newline. A loading spinner glyph is 1 char, so it qualifies; the real
   substitution is big and does not.
3. `NoteSelfWrite(text)` so the write bracket still attributes it.
4. `SendInput` one atomic burst: **Backspace × del + `KEYEVENTF_UNICODE`
   for each new char.** No `SetValue`, no clipboard, no select-all
   flash, and **no caret reset.**

Why it's the cleanest animation everywhere:
- **Notepad/WordPad** used to `SetValue` per frame (whole-value replace
  → caret to start → restore → jump). Now the frames just *type*, so the
  caret never moves off the end.
- **Electron/Discord** get the animation live instead of one coalesced
  paste.

**It relies on the phase-1 caret-at-end model** (Backspace deletes
*backwards from the caret*). A frame whose changed suffix exceeds 6
chars, or with the caret elsewhere, **declines** and falls through to
the whole-value path — where `LooksLikeAnimationFrame` (§6) is the
secondary caret-skip net. The **real substitution** (a big, non-tail
write) always takes a whole-value path; typing is only for small frames.

Kill switch: `OPENCUES_TYPE_ANIMATE=0` (legacy `OPENCUES_MSAA_ANIMATE=0`
still honoured) → falls back to per-frame `SetValue`/paste.

> History: this was MSAA-only (`TryTypeMsaaMicroEdit`) until it was
> generalised and hoisted above the attach-mode branches — the method
> was already app-agnostic; only its call-site gate was MSAA-specific.

---

## 6. Cursor positioning

Phase 1 has no real caret API (that's phase-2 `TextPattern2.GetCaretRange`).
It uses the **caret-at-end model**: the user types left-to-right, so the
caret is at end-of-text, and every write path must leave it there.

Two mechanisms keep that true:

- **`RestoreCaretToEnd`** (`OpenCuesWindows.cs:788`) — after a
  `ValuePattern.SetValue` (which parks the caret at the field start),
  put it back. For Edit-family HWNDs (classic `Edit`, RichEdit —
  Win11 Notepad `RichEditD2DPT`, WordPad `RICHEDIT50W`, WinForms
  `…EDIT.app…`) it sends `EM_SETSEL` with an **oversized offset
  (0x7FFFFFFF)** that the control *clamps* to the text end — so there's
  no index arithmetic to skew on CRLF — then `EM_SCROLLCARET` to make it
  visible. Message-based via `SendMessageTimeoutW(ABORTIFHUNG)` (no focus
  theft, can't hang on a wedged app). Non-Edit HWNDs (WPF etc.) are left
  alone — a wrong guess is worse than the status quo. This is correct
  only because reads **strip WordPad's phantom trailing paragraph mark**
  (`StripPhantomTrailingSeparator`) before it can enter the mirror, so
  "absolute end" *is* end-of-visible-content.

- **`LooksLikeAnimationFrame`** (`OpenCuesWindows.cs:763`) — a same-length
  ≤2-char swap of the prior write is a spinner frame; **skip the caret
  restore** for those. This was the first WordPad fix and is now the
  *fallback* net — the primary fix is §5 (animation frames don't
  `SetValue` at all, so there's usually no caret to restore during the
  spinner). After a genuine substitution, `RestoreCaretToEnd` fires and
  a short `_caretRestoreUntil` window (600ms) absorbs the app's own
  async caret settling.

Net: during the spinner the caret is untouched (typed frames); on the
final result it lands cleanly at end.

---

## 7. Write attribution — the write bracket (why none of this loops)

Because reads can't say *who* changed the text, the shim + daemon
synthesise attribution from the one fact they own: **every write funnels
through `NoteSelfWrite` (shim) / sets `expectedEcho` + `noteWrite`
(daemon).**

- **Shim side:** while writes are in flight (a *bracket*, refreshed per
  write, closed after 350ms of quiet), read-backs are unattributable and
  not reported. On quiet, one reconciliation read decides: our latest
  write in any EOL dress → silent sync; a stale self-write (app still
  settling) → hold the bracket; anything else → genuine user edit,
  reported. A 5s hard cap stops a pathological app from starving typing.
- **Daemon side:** `expectedEcho` swallows the exact echo; `normBuf` +
  the recent-writes ring (§2.1) catch mangled/late echoes; the
  underscore-count guard (§2.2) protects a fresh `_`; the breaker (§2.3)
  stops a same-text loop. `echoRuntimeWrite` only delivers an echo **if
  its text still equals the mirror at delivery** ("only the newest write
  may echo") — the invariant that stopped a stale intermediate frame
  from being replayed as a user edit into a selector/satellite span.

---

## 8. All the touch surfaces — and how to reset each

Everything the running system touches, and the authoritative way to
clear it. `oc-windows-reset` handles the whole column in one shot; the
per-surface commands are for targeted debugging.

| Surface | Where | Reset |
|---|---|---|
| **Tray process** (+ in-process shim) | Windows: `powershell -File OpenCuesTray.ps1` (launched by `wscript OpenCuesTray.vbs`) | `oc-windows-reset` → kills by cmdline match; manual: `Stop-Process` the `OpenCuesTray.ps1` PID |
| **Standalone shim** (dev/debug) | Windows: `powershell -File OpenCuesWindows.ps1 -Port …` | `oc-windows-reset` (must not coexist with a tray) |
| **WSL daemon** | WSL: `node …/windows/src/hostd.cjs` | `pkill -f 'windows/src/hostd.cjs'` |
| **Daemon spawn relays** | Windows: `wsl.exe -d Ubuntu -- bash -lc "… node hostd.cjs"` | die with the daemon; `oc-windows-reset` matches them |
| **Watchdog / monitor loops** (debug artifacts) | WSL: `bash -c 'until … ; do sleep …'` referencing the port/shim | `oc-windows-reset` sweeps them (self-shell-guarded) |
| **Heartbeat file** | `/tmp/oc-win-hb-51789` | `rm -f /tmp/oc-win-hb-*` (reset does this) — daemon self-exits when it's stale |
| **Presence registry** | `/tmp/opencues-hosts/windows-<pid>.json` | `rm -f /tmp/opencues-hosts/windows-*.json` (reset does this) |
| **Socket port** | daemon `127.0.0.1:51789`; settings server `:51790` | frees when the daemon dies; check `ss -tln \| grep 51789` |
| **Shared log** | `/tmp/opencues.log` | append-only; `tail -f … \| grep '\[windows\]'`. Reset reads a line-offset rather than truncating (other hosts write here too) |
| **Tray state** | `%LOCALAPPDATA%\OpenCues\tray.json` (mode/port/configSource/distro/hostd) | delete to reset config-source + persisted hostd path; the tray self-heals a stale hostd path from its launch location |
| **Autostart** | `HKCU\…\Run` value `OpenCues` → hidden `.vbs` | tray menu toggle, or `Remove-ItemProperty` |
| **Per-buffer runtime state** (mirror, DynDefs, blankName, `expectedEcho`) | in the daemon, per attached field | `bootResult.resetBufferState()` — fired automatically on every `focus`/`blur` (`hostd.cjs:428,443`); no manual step |

**Golden rule:** if the field is behaving strangely and you're tempted
to hand-kill processes — **run `oc-windows-reset` instead.** It clears
every row above deterministically and proves the result.

---

## 9. Env knobs (no rebuild)

| Var | Default | Effect |
|---|---|---|
| `OPENCUES_WIN_PORT` | `51789` | daemon TCP port (settings server = +1) |
| `OPENCUES_WIN_BIND` | `127.0.0.1` | daemon address (override for mirrored-networking WSL) |
| `OPENCUES_TYPE_ANIMATE` | on | `=0` disables the typed micro-frame animation (falls back to `SetValue`/paste) |
| `OPENCUES_MSAA_ANIMATE` | on | legacy alias for the above; `=0` also disables |
| `OPENCUES_PASTE_GAP_MS` | `0`→15ms | select-all→paste commit gap on the big-field paste path |
| `OPENCUES_HEARTBEAT_FILE` / `_TIMEOUT_MS` | set by tray | daemon liveness binding to the tray (8s) |
| `OPENCUES_HOME` | WSL `~/.cues` | config source (tray "Windows" mode points it at `%USERPROFILE%\.cues` via `/mnt/c`) |

---

## 10. Quick triage

- **Nothing happens / frozen / oscillating** → `oc-windows-reset`. 90%
  of field misbehaviour is process pollution or a stale surface.
- **`_` fires one keystroke late** → breaker or attribution regression;
  check `hostd.cjs` §2.2/§2.3 guards. Watch `grep 'breaker\|runaway'
  /tmp/opencues.log`.
- **Caret jumps on a short buffer** → the typed-animation path declined
  (suffix > 6 chars, or `OPENCUES_TYPE_ANIMATE=0`); confirm frames log
  `typed micro-frame` not `ValuePattern`.
- **"Extra shim that won't die"** → you're counting the CIM query itself
  (§2.6). Exclude `Get-CimInstance`, or just trust `oc-windows-reset`'s
  verified counts.
- **Tray up but no daemon** → stale `tray.json` hostd path (self-heals on
  next launch) or heartbeat not being written; reset.
