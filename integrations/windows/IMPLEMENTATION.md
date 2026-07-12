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

## 5. Write paths — the convergent surface

This is the trickiest part of the host, and it went through several
wrong turns before converging (see the *relative-vs-absolute* lesson at
the end — it's the crux). `ApplySetText` (`OpenCuesWindows.cs`) picks a
mechanism by how the focused field exposes itself:

| Surface | Apps | Write primitive | Undo | Drift |
|---|---|---|---|---|
| **Edit-family HWND** (`IsEditClassHwnd`) | Notepad `RichEditD2DPT`, WordPad `RICHEDIT50W`, WinForms, classic `Edit` | `EM_SETSEL` + `EM_REPLACESEL` per write (`TryEmConvergentWrite`) | **native Ctrl+Z** | none — absolute |
| **Non-Edit UIA** (writable `ValuePattern`, no Edit HWND) | Slack, other Chromium-UIA composers | typed micro-frames for the animation (`TryTypeMicroEdit`) + `ValuePattern.SetValue` **final**; caret repaired via **native-UIA** collapsed `Select()` | app's own | bounded by the SetValue anchor |
| **MSAA** (read-only UIA shell, text in the MSAA/IA2 tree) | Discord/Electron | relative backspace micro-frames (`TryTypeMicroEdit`) **anchored** by an absolute deferred paste | app's own | bounded by the paste anchor |

### The convergent principle

**Every write is (a) absolute and (b) computed against the buffer's
actual content, read back each call.** Absolute = the write fully
specifies the result, so a prior divergence can't accumulate. Read-back
= we never trust an optimistic model. Together that's *convergent*: the
buffer can't drift no matter how laggy or foreign it is. This is the
whole reason `TryEmConvergentWrite` reads `cur` (the real value, phantom-
mark-stripped) at the top of every call before deciding anything.

### Edit-family — `TryEmConvergentWrite`

RichEdit/Edit controls speak `EM_*` messages, which are **value-based**
so they marshal fine cross-process (our shim drives these apps from a
*different* process — remember that, it bites TOM below). `EM_REPLACESEL`
is the key primitive: a select-all + replace is **both absolute** (whole
value → no drift) **and undo-participating** (unlike `SetValue`, which
maps to `WM_SETTEXT` and *clears* RichEdit's undo — the reason Ctrl+Z did
nothing before this).

- **Animation frame** (small delta, `IsSmallDelta` vs `cur`): whole-value
  `EM_REPLACESEL` with `fUndo=FALSE` — cosmetic, not recorded in undo.
- **Final result** (large delta): reset to the captured baseline (the `_`
  command, `fUndo=FALSE`) then write the result (`fUndo=TRUE`) = **one
  undo unit**, so a single Ctrl+Z restores the pre-command text. The
  baseline is read from `cur` at write-stream start (`_emUndoBaseline`),
  not a separate UIA round-trip — that extra read was a lag source in an
  earlier attempt.
- **Verify + fallback**: read back (EOL-normalised); any mismatch (a
  control whose EM index model diverges from the UIA string) returns
  false and the caller repairs via absolute `SetValue`. Worst case =
  the old robust-but-no-undo behaviour.

### `EM_HIDESELECTION` — killing the blue flash (important)

`EM_REPLACESEL` needs a selection to replace, so we `EM_SETSEL` first —
and the control **paints that selection blue**, 13×/sec during the
spinner. Shrinking the selection to the single changed glyph (target-
span) did **not** help: even a 1-char selection flashed. The fix is to
tell the control *don't draw the selection highlight at all* for the
instant it exists: **`EM_HIDESELECTION(TRUE)` before the write,
`EM_HIDESELECTION(FALSE)` after.** The text still paints live; only the
highlight is suppressed. It's toggled per write (never left on, or it
would hide the *user's* own selections when they highlight text).

Rejected alternatives, and why:
- **`WM_SETREDRAW`** (suspend *all* painting, then force a repaint):
  heavier (a full repaint per frame) and Win11 Notepad's Direct2D
  control *ignores* it — the flash survived.
- **Keystrokes** (Backspace/type never highlight): would fix the flash
  but every keystroke is a native undo unit → Ctrl+Z granularity
  wrecked. That's the whole thing we use `EM_REPLACESEL` to avoid.

`EM_HIDESELECTION` is RichEdit-only; it's a harmless no-op on a classic
`Edit` (dialog boxes), which aren't animation targets.

### The cross-process wall — why Notepad's undo can't be perfect

On **WordPad**, `EM_REPLACESEL`'s `fUndo=FALSE` is honoured, so the
animation frames stay out of undo and one Ctrl+Z lands cleanly on the
command. On **Win11 Notepad** (`RichEditD2DPT`) it is **not** — Notepad
manages undo at the app level and records every buffer change regardless
of the flag, so Ctrl+Z steps back through the spinner frames.

The "correct" fix — suspend undo recording during the animation via the
Text Object Model (`ITextDocument.Undo(tomSuspend/tomResume)`) — is
**not reachable from here.** The only way to get `ITextDocument` is
`EM_GETOLEINTERFACE`, which returns a COM pointer valid **only inside the
target process's address space**. `SendMessage` does not marshal it
across the process boundary, and our shim is out-of-process. Value-based
`EM_*` messages (the `fUndo` flag, `EM_SETSEL`, …) marshal fine;
pointer-returning ones (`EM_GETOLEINTERFACE`) do not. **Do not re-attempt
TOM from the shim** — it's structurally impossible without in-process
injection.

So Notepad's undo-includes-the-dots is an *accepted limitation*, not a
bug to keep chasing. The feasible-but-rejected trades were: skip the
spinner on Notepad (loses the animation) or `EM_EMPTYUNDOBUFFER` before
the result (works cross-process, but wipes the user's *prior* undo
history). We chose to leave it.

### MSAA (Discord) — the anchored exception

Discord's focused element is an empty shell *to the managed UIA client*;
there's no `ValuePattern` to `SetValue` and no Edit HWND for `EM_*`. So
it keeps the **relative** backspace micro-frame path
(`TryTypeMsaaMicroEdit`: `SendInput` Backspace×del +
`KEYEVENTF_UNICODE`), which is safe there because the **final** write is
an absolute select-all **paste** — any frame drift is wiped when the
result lands. Relative writes are acceptable *only* when anchored to an
absolute checkpoint like this. Kill switch: `OPENCUES_TYPE_ANIMATE=0`
(legacy `OPENCUES_MSAA_ANIMATE=0`).

### Native UIA on Electron — reads yes, writes NO (the Slate ghost)

A July 2026 probe pass (`uia-native-probe.ps1`, `uia-native-drive-probe.ps1`)
overturned the "Electron is a black box" assumption: Chromium serves its
**modern native UIA provider** (`IUIAutomation` COM — what Narrator uses)
even though the legacy managed API sees an empty shell. On Discord that
surface is complete: writable `ValuePattern`, `TextPattern.GetText`,
`TextPattern2.GetCaretRange` (a real caret read!), and collapsed-range
`Select()` caret positioning — all verified live. Slack (older Electron)
serves `ValuePattern` + `TextPattern` but no `TextPattern2`, and reports
no selection, so its caret is unreadable by any route.

**But the write half is a trap.** `SetValue` into Discord passed the
a11y round-trip ("TEXT CHANGED", read-back correct) and **still
corrupted the editor**: Discord's composer is **Slate, a model-first
React editor** — `SetValue` writes the DOM/a11y layer behind the model,
leaving **ghost text the user cannot delete** (Backspace edits the
model; the ghost isn't in it) and breaking subsequent input synthesis
until the renderer reloads (`Ctrl+R`). Slack's **Quill** composer syncs
its model *from* DOM mutations, so `SetValue` is safe there — it is the
live Slack write path. A read-back verify **cannot** catch the Slate
desync: the a11y layer reports the new text while the model disagrees.

**The rule this fixes in stone:** on Electron, native UIA is for
*observation* — text reads and caret — never mutation. Writes go through
the app's real input pipeline (keystrokes / paste), unless the editor
framework is *verified* SetValue-safe (Quill yes, Slate no). The upgrade
this enables: Discord can gain a genuine caret model (`GetCaretRange`)
and cleaner reads without touching its proven write path.

### The write-privilege ladder — why Discord's flash is the floor

Researched (July 2026) after every flash-free write into Discord failed;
each rung verified against docs/community, not just our experiments:

1. **In-page JavaScript** (browser extensions; Grammarly's extension +
   [Text Editor SDK](https://developer.grammarly.com/) with per-editor
   adapters) — full access, the editor is driven on its own terms.
   *Our analog: the OpenCues Chrome extension. Discord-in-a-browser is
   its territory; Discord desktop is this host's.*
2. **TSF** (Text Services Framework — the OS input-method plumbing that
   IMEs / handwriting / Windows text-suggestions ride). A registered
   text service can replace ranges *through the input pipeline*;
   Chromium converts TSF edits into **trusted** composition /
   `insertReplacementText` events, which Slate handles — this is why
   the OS's own autocorrect replaces words in Discord with no flash.
   Price: shipping a TIP — an in-proc COM DLL **loaded into every
   application's input stack**. **Built and tested, then removed
   (July 2026 spike, `wip/windows-integration`, reverted in `be2005ab`):
   a single one-shot `ITfRange::SetText` IS flash-free on Discord/Slate
   — verified live (the M0 Ctrl+Alt+J test) — but driving Slate in the
   continuous resolve loop (read → resolve → write → read-back, many
   times/sec) desyncs its text store: content balloons, writes revert,
   double + undeletable ghost text. Coalescing frames into one write and
   reading back through the TIP (GETTEXT) both helped but did not fully
   tame it. Conclusion: the one-shot works, the live loop does not, so
   the flash-class trusted-input path (rung 3) stays the floor. The full
   diagnosis is in the spike's git history (M1–M5 → `be2005ab`).**
3. **Trusted input simulation** (keystrokes + clipboard) — *us, and
   Grammarly Desktop*, whose own docs require fields to support the
   [UIA Text Pattern](https://support.grammarly.com/hc/en-us/articles/10139846131213-How-do-I-integrate-Grammarly-with-my-website-or-application)
   and which falls back to a floating widget + paste-back on hostile
   fields (the same flash-class write). Whole-field replace on this
   rung requires a momentary selection — the flash.
4. **Accessibility writes** (`SetValue`) — broken on model-first
   editors (the Slate ghost, above).

Slate specifics that close rungs 3½ and 4 permanently: Slate handles
`insertReplacementText`/`insertFromPaste` via `beforeinput`
([editable.tsx](https://github.com/ianstormtaylor/slate/blob/main/packages/slate-react/src/components/editable.tsx))
but only from **browser-generated** input; the maintainers' own
discussion ([#5003](https://github.com/ianstormtaylor/slate/discussions/5003))
confirms both direct DOM mutation ("editor reverts … incorrect cursor" —
the ghost, verbatim) AND synthetically dispatched `InputEvent`s fail to
sync its model. `TextEditPattern` (which Discord advertises) is
read-only — composition observation + notifications, no write methods
([MS Learn](https://learn.microsoft.com/en-us/windows/win32/winauto/textedit-control-pattern)).
Empirical additions from our tests: a 354-backspace burst drops/mangles
in Slate (the chomp experiment), and typing result text triggers
Discord's `:`/`@`/`#` popups. **Trusted input is the only writable
channel from outside, and whole-field-replace-by-input needs a
selection: the flash is structural, not a bug.**

**First shipped consumer (July 2026): the Slack caret fix.** Slack's
caret used to bounce during the animation because every spinner frame
was a whole-value `SetValue` (caret invalidated → parked at start →
synthetic `Ctrl+End` repair, ~13×/sec). Two changes killed it: (1) the
animation frames now go through `TryTypeMicroEdit` (typed keystrokes —
caret rides naturally, editor-safe), leaving only the FINAL substitution
as a `SetValue`; (2) that one remaining caret repair is a **native-UIA
collapsed-range `Select()`** (`TryNativeUiaCaretToEnd`) — silent, no key
synthesis — falling back to the managed attempt + `Ctrl+End` when the
provider doesn't serve it. The native client lives in the shim as
partial-vtable COM interop (`IUIAutomationN` etc.), created lazily on
the first non-Edit caret restore so sessions that never write a
Slack-class composer never flip Chromium apps into UIA mode.

### The lesson: relative accumulates, absolute converges

The load-bearing insight, learned the hard way (a whole arc of stray
dots, double-deletes, overshoot):

| | `SetValue` / `EM_REPLACESEL` (absolute) | Backspace × N (relative) |
|---|---|---|
| Operation | writes the whole value | deletes N chars *from where the caret is* |
| If our model of the buffer drifts | self-corrects next write | **accumulates** — wrong N → overshoot / double-delete / stray glyph |
| Needs remote buffer to match our mirror | no | **yes** |

On a **polled, laggy, foreign** buffer, drift is a *when* not an *if*, so
a relative/blind operation is the wrong tool wherever an absolute one
exists. Backspace-typing was briefly used on Notepad/WordPad (commit
`63be937f`, reverted) to dodge the caret-reset — but those controls have
an absolute write, so it traded a self-correcting operation for a
fragile one to solve a caret problem we'd already solved another way
(`LooksLikeAnimationFrame`, §6). Use relative writes **only** where no
absolute write exists (MSAA), and anchor them to an absolute checkpoint.

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

### Undo must not re-fire the blank (`isPureInsertion`)

Native Ctrl+Z (§5) restores the `_` command text — and the daemon's
"fresh `_`" path would then re-synthesise the `_` keystroke and re-run
the blank (the buffer re-processes on undo). The fix is timing-free and
lives at `hostd.cjs`: a blank fires **only when the `_` was TYPED — a
*pure insertion* into the current buffer** (the prior text survives as
the prefix+suffix around the inserted `_`). An **undo / redo / paste**
wholesale-replaces the buffer, so the pre-`_` content is *not* preserved
→ `isPureInsertion` is false → the daemon adopts the text into the mirror
(so `getText()` stays correct) but **returns without `notifyTextChange`**,
so the resolver never sees it as a change and never re-resolves. A
genuine **re-run** (retype the command) *is* a pure insertion, so it
still fires. No result/command bookkeeping, no clocks — robust even on
apps like Slack that re-render the buffer, because it never has to
recognise a transformed result. (Watch it: `grep 'suppressed .* re-fire'
/tmp/opencues.log`.)

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
