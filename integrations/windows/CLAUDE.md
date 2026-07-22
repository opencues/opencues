# CLAUDE.md — Windows integration

`@opencues/windows` — a **system-wide** OpenCues host for Windows. Like
`shell`, it's a **self-owned host**: there is no upstream editor to
patch. Unlike every other host, the text buffer it operates on isn't in
its own process — it's whatever Windows app the user is currently typing
in, reached over UI Automation.

> **Implementation deep-dive:** [`IMPLEMENTATION.md`](IMPLEMENTATION.md) —
> the problems we hit driving real apps (runaway self-transform loop, `_`
> not resolving, cursor jump, process pollution, the CIM self-match
> phantom) and the final working shape: singleton lifecycle, the
> `oc-windows-reset` script, the typed micro-frame animation, caret
> positioning, and the full touch-surface / reset table. Read it before
> touching the write path, the tray/daemon lifecycle, or the attribution
> guards.

## Architecture — two halves, one socket

```
Windows (thin shim, no logic)            WSL (the brain)
native/OpenCuesWindows.cs   ── socket ──▶ src/hostd.cjs
  UI Automation read/write   127.0.0.1    boots @opencues/runtime via
  focus tracking             (WSL2 fwd)   adapters/windows/v1/boot.ts
  sensitive/deny gate        ◀── set-text  reads ~/.cues, uses WSL keys
```

- **`src/hostd.cjs`** (WSL) — the daemon. Boots the runtime through the
  `windows` adapter band using WSL's own `~/.cues` + `process.env` keys
  (this is the literal "plugged into WSL main OC" join — no second
  config, no sync). Keeps a **local mirror** of the remote field's text
  so `getText()` never blocks. Translates the wire protocol
  (`protocol.md`) ↔ the adapter. Publishes a presence file under
  `/tmp/opencues-hosts/`.
- **`native/OpenCuesWindows.cs`** (Windows) — the shim. Polls
  `AutomationElement.FocusedElement`, reads via `ValuePattern` /
  `TextPattern`, writes via `ValuePattern.SetValue`, and streams text /
  focus / blur to the daemon. Contains no OpenCues logic. Compiled
  on-demand by `native/OpenCuesWindows.ps1` (`Add-Type`, Windows
  PowerShell 5.1 — **no .NET SDK**). A `.csproj` is provided for a
  proper `dotnet build` later.
- **`packages/opencues-runtime/adapters/windows/v1/`** — the adapter
  band. Near-clone of `shell/v1` but `supportsCycling()` returns
  **false** (phase 1) and the I/O bindings are backed by the daemon's
  socket + mirror instead of an OpenTUI textarea.

## Why this shape

The runtime is host-agnostic TypeScript and already has an off-process
driving surface (`src/event-bridge.ts`: inject text/keys, observe
events). The Windows shim is essentially a **live driver of that same
surface** across a socket. Running the runtime in WSL (rather than
porting Node + a native sidecar onto Windows) means the Windows host
*is* the user's existing OpenCues install — same config, same keys, same
`/tmp/opencues.log`. The only Windows-native code is the irreducible
part: touching UIA.

## Tray app + shared settings UI

The productized surface is a tray app, in two builds (same behaviour):

- **`native/OpenCuesTray.ps1`** (+ `OpenCuesTray.vbs` hidden launcher) —
  no-SDK PowerShell tray. `Add-Type`s the shim, NotifyIcon menu,
  supervises the daemon (spawn mode). "Settings" opens the browser.
- **`native/TrayProgram.cs`** + `OpenCuesTray.csproj` — compiled .NET
  product. Same menu, hosts the shim in-process, opens Settings in an
  embedded **WebView2** window. Needs the .NET SDK + WebView2 runtime.

Both open the **same settings UI**: the chrome extension's popup,
refactored behind a host port and served by the daemon.

### The shared settings component (this is the important bit)

The chrome popup (`integrations/chrome/src/popup/`) was refactored so its
config/keys/status calls go through **`adapters/host-port.ts`**, which
picks a backing at load:

- chrome extension context → `chrome-storage-adapter` (unchanged behaviour)
- anything else (WebView2 / browser served by the daemon) →
  `http-config-adapter` (fetch `/api/*`)

So the popup is **one component with two backends**. On Windows it's
served by the daemon's **config server** (`src/config-server.cjs`, an
HTTP server on the socket port + 1, 127.0.0.1-only):

| Endpoint | Backing |
|---|---|
| `GET /` + `/popup.{css,js}` | the staged popup assets (`ui/`, built from chrome) |
| `GET /api/config` | provider/model from `OPENCUES.md`, key **fingerprints** from `.env` |
| `GET /api/keys` | **real** key values (localhost + same-user — same trust as the `.env` file itself), for input pre-fill |
| `POST /api/config` | writes keys → `.env`, provider → `llm-provider`, model → `{cues,blanks,auditors}-llm-model`, ttsRate → `tts-rate` |
| `GET /api/status` | shim connection + attached app (drives the popup's "host connected" state) |

**When you change the chrome popup, this path is exercised too** — run
the chrome build + E2E per `integrations/chrome/CLAUDE.md`. The two
adapters keep identical signatures; drift there breaks one host silently.

Config lives at `%USERPROFILE%\.cues` by default (or `OPENCUES_HOME` →
`\\wsl.localhost\...` to share WSL). Tray state in
`%LOCALAPPDATA%\OpenCues\tray.json`; logs in `%TEMP%\opencues.log`.

## Phase 2 (EXPERIMENTAL, this branch) — cycling + overlay + real caret

| | Phase 1 | Phase 2 (shipped on this branch) |
|---|---|---|
| Profile | `supportsCycling:false` — Universal-Integration | **per-field dynamic** — `focus.cycling` from the shim (UIA attach + managed TextPattern → true; MSAA/Electron → false) |
| Surface | fluid-blank, transform-blank, compute blanks | + word-cues, selector/satellite, cycling blanks on cycling fields |
| Windows I/O | UIA read/write only | + WH_KEYBOARD_LL hook (Ctrl+Alt+arrows swallowed → `key` msgs; Escape observe-only) + layered click-through overlay (`OverlayForm`) painted from TextPattern `GetBoundingRectangles` |
| Cursor | assumed at end (text length) | real caret via native `IUIAutomationTextPattern2.GetCaretRange` (poll-tick `cursor` events; `set-cursor` applied via EM_SETSEL / native collapsed Select) |
| Render | none | daemon collects `RenderDirectives` per event + forceRender, ships `render {dim, hl, style}`; adapter advertises `dim-ranges` + `highlight-range` + `render-rgb-color` |

The resolver folds `supportsCycling` into its build key, so focusing
between a cycling and a non-cycling field rebuilds the source set
automatically — no reboot, no band edits.

**Overlay dim looks (all three implemented, for evaluation):** the
daemon env `OPENCUES_WIN_OVERLAY_STYLE=underline|wash|repaint` picks the
treatment and rides every `render` message — restart the daemon to
switch, no Windows-side rebuild:

- `live` (default) — per-span **DWM thumbnails**: a live, sharp,
  GPU-composited mirror of the word itself (source-rect-cropped from
  the field's top-level window) drawn 1:1 over the word at ~65%
  opacity above a gray underlay (accent underlay for the active span).
  Caret blink, selections and edits show through in real time — no
  capture, no cache, no staleness by construction. Spike-proven
  2026-07-21 (`native/composition-spike/`; the composition
  BackdropBrush route was rejected there — host backdrop is pre-
  blurred by design). Plain Win32 `dwmapi`, so it lives in the
  Add-Type shim like everything else. NOTE: thumbnails ignore the
  window's LWA alpha — the typing/scroll suppressors drive thumbnail
  opacity explicitly alongside the window fade.
- `underline` — thin gray line under each cue word; the
  active/cycling span gets a thicker blue line. Robust everywhere.
- `wash` — translucent gray rectangle over the word (whole-window
  alpha + color-key). Closest cheap approximation of the terminal dim.
- `capture` — screen-capture the word rect and redraw the APP'S OWN
  glyph pixels dimmed: each pixel collapsed to luminance and pulled
  45% toward the rect's corner-sampled background (active span pulls
  toward the accent). True terminal gray with zero font guessing.
  Mechanics: captures hide the overlay's own ink for one composited
  frame, land in a per-span bitmap cache, and steady state repaints
  from cache (no captures); scroll/move invalidates the cache so the
  marks blink briefly while re-capturing. (The earlier `repaint`
  style — re-drawing the word in our own font — was retired after the
  live test showed exactly the misalignment it was predicted to have.)

**Kill switches:** `OPENCUES_WIN_PHASE2=0` (daemon — whole profile back
to phase 1), `OPENCUES_WIN_HOOK=0` (shim — no keyboard hook),
`OPENCUES_WIN_OVERLAY=0` (shim — no overlay paint),
`OPENCUES_WIN_SCREEN_READER_FLAG=0` (shim — don't raise the system
screen-reader flag; Chromium apps degrade to synthesized marks).

**The screen-reader flag (Chromium geometry, 2026-07-22).** Chromium
(Chrome, Edge, every Electron app) decides its accessibility mode at
process start by checking the Windows screen-reader flag
(`SPI_SETSCREENREADER`). Without it, text fields like the Chrome
omnibox return one frozen 2px rect for every `GetBoundingRectangles`
query — no real geometry exists for out-of-process clients through
managed UIA, native UIA, `GetGUIThreadInfo`, or IA2 (the full
dead-end ladder is recorded in `native/ia2-extents-probe.ps1`'s
header; IA2 is refused with `E_NOINTERFACE` even under the flag).
With the flag up at browser start, the same queries return real
per-word rects and the overlay renders exactly as it does in Notepad.

So the shim **owns the flag as part of its lifecycle**: raised at
`Start()` (only if it wasn't already up — a real screen reader owns
it then), restored at `Stop()`/process-exit only if we raised it,
session-scoped (never persisted) so a reboot self-heals any crash
that skipped the restore. This is the OS-sanctioned "an assistive
client is running" signal and the same class of mechanism assistive
writing tools such as Grammarly's desktop app ship on — the app-side
effects (keyboard-friendly behaviours in Office, extra accessibility
bookkeeping in browsers) are well-trodden ground. Websites cannot
observe the flag.

The one seam: a Chromium app **already running** when the flag goes
up keeps its stubbed geometry until its next restart (the mode is
sticky per process, in both directions — which also means a Chrome
started under the flag keeps real geometry after the flag drops).
Until that restart, stub-detected fields fall back to the calibrated
width synthesis (`TrySynthCalibrated` — proportional GDI-measured
marks on the stub origin; approximate by construction). A future
tray notification "restart Chrome for precise marks" can close the
seam; the frozen-stub rect is a reliable detector.

**Chord semantics:** while a cycling field is attached (and the shim is
enabled + connected), Ctrl+Alt+Up/Down/Left/Right key-downs are
swallowed system-wide and forwarded; the matching key-ups are swallowed
too.

**Per-app chord (2026-07-23):** apps that bind Ctrl+Alt+arrows to
their own commands (today: Slack, hardcoded in `AltShiftChordApps`)
get the OpenCues chord on **Alt+Shift+arrows** — all four arrows,
claimed unconditionally while attached-cycling; **Ctrl+Alt passes
through to the app untouched**. Design history (for the override UI):
Ctrl+Shift rejected (select-by-word + also bound in Slack);
capture-first on Ctrl+Alt with a marks-live gate rejected (the app
should keep its chord outright). **Alt+Shift caveat:** on
multi-input-language systems it is the Windows layout-toggle hotkey,
fires on the modifiers alone, and the noop-key mask does NOT defuse
it — presents as "the app is eating my input" (silent en-GB/en-US
flips). Usable only with that hotkey disabled (Settings → Typing →
Advanced keyboard settings → Input language hot keys) or a single
installed layout. The override UI must surface this trap; modifier
pairs with system meanings (Alt+Shift, Win+anything) need a warning.

> **TODO (final Windows integration): per-app override UI.** The
> chord remap above is the first entry in what will inevitably be a
> per-app compatibility table (chord choice, write path preferences,
> paragraph-break dress, paste timing — several such app lists are
> already hardcoded in the shim: `ShiftChordApps`,
> `PastePreferredApps`, `ParagraphBreakApps`, `RichEditParagraphApps`).
> Before the integration ships, these need a user-facing override
> surface (tray settings page backed by a config file) so users can
> (a) see which well-known apps have overrides, (b) add their own for
> apps we haven't met, without editing C#. Wilfred, 2026-07-23. `key-result consumed:false` re-injects the arrow with
`INJECT_MARK` in `dwExtraInfo` (the hook passes marked events through —
that mark check is what prevents an infinite self-hook loop). The LL
hook callback never touches the socket inline (ThreadPool send) — a
blocking LL hook gets silently removed by Windows after ~300ms.

**The snapshot-overlay embodiment (final form, 2026-07-21).** The
capture pipeline's full machinery, built out over the 07-20/21 live
sessions — this is the practical ceiling of the "hold copies of the
app's pixels" architecture (its successor, the composition
BackdropBrush live-dim, lives on `spike/windows-composition-overlay`):

- Capture source: PrintWindow(PW_RENDERFULLCONTENT) on the field's
  HWND, batch-rendered + cropped per span (no DWM vblank wait, no
  occluders); CopyFromScreen + WDA-exclusion + paint-settle guard as
  the no-HWND fallback. Modal (most-frequent-colour) background
  estimate; caret-fringe hot recapture incl. previous caret.
- Freshness: event-gated O(1)-per-tick sensing (UIA change events +
  EM_GETSEL caret + watchdogs), adaptive fast-poll (8ms +
  timeBeginPeriod(1) in the fast window), chord/write-triggered
  cadence ramps, post-write RedrawWindow(UPDATENOW) paint nudge.
- Visibility policy: hide-on-keydown (volatile/stable window split by
  caret position) + 150ms fade-in after 500ms quiet; scroll
  suppression (WH_MOUSE_LL wheel + PgUp/PgDn + rect-moved probe →
  hide all, settle 350ms, fade back).

**Phase-2 known limitations:**
- Cycling substitutions are whole-value writes — the app's native undo
  granularity cost from phase 1 applies per cycle step on non-Edit
  fields (Edit/RichEdit keep native undo via the EM convergent path).
- The overlay repaints rects every other poll tick (~300ms), so fast
  window drags/scrolls show transient lag of the ink.
- `capture` estimates the background as the rect's MODAL pixel colour
  (immune to the caret bar / neighbouring glyphs; the earlier
  corner-average pumped the whole patch when the caret blinked at the
  word edge) — still wrong on gradient/imagery backgrounds where no
  colour dominates.
- Chromium-UIA composers (Slack) expose TextPattern only to native
  clients → managed probe says no rects → they stay phase 1.
- WPF fields (no Edit-class HWND, but TextPattern present → cycling on)
  can route a small LAST-WORD cycle substitution through
  `TryTypeMicroEdit`, which still assumes caret-at-end — a mid-word
  caret there can misplace the backspace burst. Notepad/WordPad are
  immune (EM convergent path); revisit if a WPF target misbehaves.
- Pinned by `tests/render-wire-invariants.mjs` (wire mapping + hook/
  overlay source guards) and the fake-shim smoke pattern (see Dev loop).

## Write attribution — the write bracket

Every other host lives inside the editor process, so "the runtime
wrote" and "the user typed" arrive as separate channels for free. This
host observes a foreign app's buffer by polling — a read-back can't say
*who* changed the text. The shim therefore synthesizes attribution from
the one fact it owns: **every write funnels through `NoteSelfWrite`**.

- While writes are in flight (a *bracket*, refreshed per write, closed
  after 350ms of quiet) read-backs are unattributable → not reported.
- On quiet, ONE reconciliation read: latest write in any EOL dress →
  silent sync; a stale self-write (async editor still settling) → hold
  the bracket another quiet window; anything else → genuine divergence
  (user typed / app transformed the text), reported as a text event.
- A 5s hard cap stops a pathological app from starving typing reports.
- A TTL ring of recent writes (EOL-normalized — RichEdit echoes `\r`
  for a written `\n`) backs the reconcile and catches late echoes.

Without this, the loading animation (~50ms frames vs the ~150ms poll)
reads back as "user typing", the runtime re-resolves mid-substitution,
and the field oscillates spinner ↔ final ("live text changed" skips
with nobody at the keyboard). The Android accessibility host has the
same shape (TEXT_CHANGED events carry no attribution) — reuse this
pattern there.

## Write paths — and the typed micro-frame animation

`ApplySetText` picks one of three write mechanisms by how the focused
field exposes itself:

| Path | Apps | Mechanism |
|---|---|---|
| **UIA `ValuePattern.SetValue`** | Notepad, WordPad, Explorer, Win32/WinForms/WPF | whole-value replace, atomic |
| **UIA `TextPattern` paste** | Electron/Chromium with a writable-less UIA element but a `TextPattern` | clipboard + Ctrl+A + Ctrl+V |
| **MSAA deferred paste** | Chromium/Electron whose focused UIA element is an empty read-only shell (text lives in the MSAA/IA2 tree) — Discord | Ctrl+A + Ctrl+V, coalesced once the stream goes quiet |

**Above all three sits ONE shared fast path for loading-animation
frames: `TryTypeMicroEdit`.** A spinner frame is a tiny tail edit vs
`_lastSentText` (the glyph churning near the trailing `_`). When the
changed suffix is ≤6 chars with no newline, it's applied as **synthetic
typing** — Backspace × del + `KEYEVENTF_UNICODE` chars in one atomic
`SendInput` burst — instead of a whole-value write. No clipboard, no
select-all flash, and **no caret reset** (the reason WordPad's cursor
used to jump: every `SetValue` parks the caret at the field start, so
restoring it per frame yanked it start→end ~13×/sec). This is the
cleanest animation on every app; it was MSAA-only until 63be937f, when
the call was hoisted above the attach-mode branches so Notepad/WordPad
get it too.

It calls `NoteSelfWrite(text)` like every other path, so the write
bracket still attributes the frames correctly. It relies on the
**phase-1 caret-at-end model** (Backspace deletes backwards from the
caret); a frame with a longer changed suffix, or the caret elsewhere,
declines and falls through to the whole-value path — where
`LooksLikeAnimationFrame` is the secondary caret-skip net for
`SetValue`. Kill switch: `OPENCUES_TYPE_ANIMATE=0` (legacy
`OPENCUES_MSAA_ANIMATE=0` still honoured). The **real substitution** (a
big, non-tail write) always takes a whole-value path — typing is only
for the small frames.

## Verify-before-write + verify-before-restore (2026-07-14 incident pair)

Two silent races shipped in the write paths and both fired live on the
same day; the fixes share one primitive, `TryReadCurrentField` (an
on-demand, mode-aware read of the attached field), and are pinned by
`tests/clipboard-invariants.mjs` (in pre-pr):

1. **Clipboard restore raced the app's async paste read.** `PasteReplace`
   saved the user's clipboard, set the substitution, sent Ctrl+V, slept
   a fixed 300ms, restored. Electron consumes the clipboard
   asynchronously — Discord under load was observed reading >1.1s after
   Ctrl+V — so when the restore won, the paste delivered the USER'S OLD
   CLIPBOARD into the focused app (live: a copied email address landed
   in a Discord input instead of the substitution). That is a clipboard
   LEAK into whatever app is focused. Now: poll the field until it
   reflects the pasted text (EolNorm-folded), THEN restore; on timeout
   (`OPENCUES_CLIPBOARD_RESTORE_MAX_MS`, default 3000) FAIL SAFE — skip
   the restore and warn. Losing old clipboard contents is an annoyance;
   pasting them into the foreground app is a leak.

2. **Write diffs computed against a stale field model.** Both
   `TryTypeMicroEdit` (animation frames) and `PasteReplace`'s backspace
   path diffed against the shim's belief (`_lastSentText` / the
   daemon's `oldText`). Phase 1 has no keyboard hook, so USER keystrokes
   are invisible between reads — a stale model turns the backspace burst
   into user-content deletion (live: "congratulations" typed mid-
   animation lost its leading "con"). Now: read the field immediately
   before acting; micro-frames DROP on divergence (cosmetic — the final
   write is the absolute anchor), PasteReplace REBASES its diff on the
   fresh read. Known trade: on very slow editors a frame whose
   predecessor hasn't rendered yet reads as divergence and gets dropped
   — the animation stalls a frame; never a wrong write.

## Multi-buffer state — reset on field change, RESUME on same-field refocus

The Windows host attaches to **many** independent fields across apps in
one runtime instance. That's the canonical multi-buffer trigger from
`docs/architecture/universal-integration.md`: adopting a DIFFERENT
buffer must be preceded by `bootResult.resetBufferState()`. Without it,
a DynDef with `blankName` set from the previous field silently blocks the
next field's first blank (the "bare `_` returns nothing" bug). If you add
a new boundary (e.g. external paste detection), wire a reset there too.

**Phase 2 refinement — the reset is deferred from blur to the next
focus.** Clicking away and straight back to the SAME field with
unchanged text is a RESUME: no reset, no re-seed, no re-resolve — the
spans (word-cue dims, substitution DynDefs, satellite pairs) survive
and the overlay repaints from the preserved state. This fixes the
"marks vanish on every focus flicker" UX (substitution spans are
unrecoverable by re-resolve, so a blanket reset destroyed them). The
invariant is preserved three ways: (1) the next focus performs the
full reset whenever the field id OR the text differs; (2) while
detached, inbound text/key events are ignored and outbound
setText/pushText are DROPPED (a late in-flight LLM result must never
ship with no attached field — and a drop poisons the resume so stale
runtime state can't survive into it); (3) the shim independently
verifies the focused element IS the attached one (UIA runtime-id
match) before any write path runs. A→B→A does NOT resume — adopting B
reset A's state; per-field snapshots are a possible later extension.

## Security posture (phase 1)

- **Attachability gate lives on the shim** (`IsAttachable`): Edit/Document
  control types only; never password (`IsPassword`) or fields whose
  name/id carries a sensitive token; must have a writable `ValuePattern`.
  Browsers + terminals are deny-listed by foreground process. Result:
  credentials + non-editable surfaces never enter the LLM pipeline, by
  construction.
- **Spawn sandbox** is the shared runtime path — `hostd.cjs` reuses
  `validateScriptPath` + `wrapWithBwrap` exactly like the shell host, so
  script blanks are path-validated and (on Linux) bwrap-confined. The
  daemon runs in WSL, so bwrap is available — a genuine advantage over a
  hypothetical native-Windows host.

## Dev loop

```bash
# Build the band + stage into node_modules:
integrations/windows/patches/setup.sh

# Run the daemon (WSL). It falls back to the repo dist for dev runs:
OPENCUES_WIN_PORT=51789 node integrations/windows/src/hostd.cjs
# or: oc-windows

# Drive it WITHOUT Windows (fake shim over the socket) — the fastest
# inner loop, no Windows needed:
#   send {t:hello}, {t:focus,text:""}, {t:text,text:"... fix typos _"}
#   expect a stream of {t:set-text,...} back (loading frames → result).
# See the e2e probe pattern in the integration's git history / tests.
```

Debugging: `tail -f /tmp/opencues.log | grep '\[windows\]'`. The daemon
prints the Windows-side command on start.

### Singleton discipline — `oc-windows-reset`

The integration is a **singleton by design**: one tray hosting one
in-process shim + one WSL daemon (kept alive by a heartbeat file, so it
self-exits if the tray dies). **Two shims writing the same foreign field
is unwinnable** — they fight over the buffer. Debug sessions and crashes
leave orphans (standalone `-File OpenCuesWindows.ps1` shims, bare `node
hostd.cjs` daemons, watchdog loops, stale heartbeat/presence files), so
when anything looks stuck, don't hand-kill processes — run:

```bash
integrations/windows/bin/oc-windows-reset   # teardown + relaunch + verify singleton
#   --down        teardown only, leave stopped
#   --no-launch   teardown + verify-clean, don't relaunch
```

It loop-kills everything, clears the stale state files, relaunches ONE
instance the canonical way (`oc-windows` → hidden tray → daemon + shim),
and polls until it can *prove* a singleton (port listening, daemon=1,
tray=1, shim handshake in the log) or fails loudly. It's idempotent — a
second run tears down the first and converges to the same state.

> **Counting gotcha (baked into the script, don't reintroduce):** a CIM
> `Where CommandLine -match/-like '…OpenCues…'` query MATCHES ITS OWN
> command line, so a naive shim/tray count is always off by one (the
> query sees itself). It reads as a phantom "extra shim that respawns
> every time you kill it" — it cost a long detour. Every counter in the
> reset script excludes processes whose cmdline contains
> `Get-CimInstance`. Do the same for any ad-hoc process check.

## Wire protocol

Versioned, newline-JSON, `protocol.md`. Bump `protocol` (in the
`welcome`/`hello` handshake) only on a breaking shape change; add new
message types freely (both sides ignore unknown `t`).

## Known limitations (phase 1)

- **Write requires `ValuePattern`.** Rich Electron/Chromium editors that
  expose only `TextPattern` are read-only to us and skipped. Browsers are
  deny-listed anyway (Chrome extension is the surface there).
- **`ValuePattern.SetValue` replaces the whole value** and resets undo
  granularity — the standing cost of the UIA write path (same class as
  the Android `ACTION_SET_TEXT` tradeoff). The caret reset is repaired
  (`RestoreCaretToEnd` — EM_SETSEL clamp-to-end on Edit-family HWNDs);
  undo is not. Fine for `_` blank fills; revisit for phase-2 word-level
  cycling. (A surgical EM_REPLACESEL splice + prefix/suffix diff
  windowing was tried and reverted — see a28d4ab0 / 1386b60d; retry
  needs CRLF index mapping for RichEdit and MSAA `setSelection` instead
  of big key bursts on Electron.) Note `SetValue` now only fires for the
  **real substitution**; the loading-animation frames take the typed
  micro-edit path (see § Write paths), so there's no per-frame caret
  churn to repair during the spinner.
- **Elevated apps** are invisible to a normal-integrity UIA client
  (UIPI). A signed UIAccess build is deferred.
- **WSL2 localhost forwarding** is assumed (Windows → WSL server on
  localhost). Mirrored-networking setups may need `-DaemonHost <wsl-ip>`.

## The "no-cycling defect family" that wasn't (agentic suite, 2026-07-08/09 — RESOLVED)

Windows is the first no-cycling host driven by the agentic harness
(opencues-agentic PR #13), and its first suite run showed five
scenarios ending in empty/wrong buffers (18-fluid-config-flip,
57-identity-context-flip, 60-sentinel-write,
86-integration-pass-blank-fill, 102-config-intent-preserves-buffer).
The initial hypothesis — a runtime defect where selector/satellite
outputs are pruned on `supportsCycling: false` after consuming the
summon text — was **wrong**. A direct-boot repro (band with stubbed
bindings, stack-traced writes) proved the runtime pipeline correct on
the no-cycling profile, including selector/satellite REGISTRATION
(which works fine without cycling; only the chords are inert). The
real causes were two host-side bugs:

1. **Stale-echo replay (hostd)** — `echoRuntimeWrite`'s deferred echo
   could deliver an INTERMEDIATE write (the loading animation's
   underscore-restore) to the band AFTER the final substitution, and
   stateful text-change handlers (selector-satellite clearOnEdit) read
   the stale buffer as a user edit into their span → destructive
   cleanup → empty buffer. Fix: an echo only fires if its text still
   equals the mirror at delivery ("only the newest write may echo") —
   the invariant every real editor gives the other bands. Fixed 4/5
   scenarios.
2. **`on-host:` allowlists predating the windows host** — the
   sentinel / note / opencues blanks declare explicit host allowlists
   in their BLANK.md; `windows` wasn't on them, so folder discovery
   (correctly) dropped the configs and `set sentinel … _` fell through
   to fluid-blank. Fix: `windows` added to the three allowlists in
   `defaults/` (+ seeded copies self-healed). **Porting lesson: any
   NEW host name must be grep'd against `on-host:` allowlists in
   shipped defaults** — an allowlist silently excludes every future
   host (this will bite the next integration too; see
   docs/guides/porting-to-new-integration.md).

All five scenarios + both note-blank scenarios now pass on windows;
the touched flows regression-pass on shell. Pinned by the same
scenarios in the private harness repo.
