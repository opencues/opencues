# TSF spike — can OpenCues become a text service?

**Status: research spike on `wip/windows-integration`. Nothing here is wired
into the shipped shim. The build artifact is opt-in and revertable as a unit.**

## Why we're looking at TSF

Everything the Windows host does today lives at the *observer's* entrance to
Windows text — UI Automation / MSAA reads, synthetic input writes. That's the
same rung Grammarly Desktop sits on, and it has a hard floor: replacing a
whole field by trusted input needs a momentary selection, so model-first
Electron editors (Discord's Slate) flash blue on the final substitution.
Every flash-free alternative is closed — proven, not guessed
(see `../IMPLEMENTATION.md` §5 "the write-privilege ladder"):

| Rung | Who | Verdict for us |
|---|---|---|
| In-page JavaScript | browser extensions (Grammarly ext / **our Chrome integration**) | not applicable to a *desktop* app host |
| **TSF** (input-method pipeline) | IMEs, handwriting, Windows autocorrect | **this spike** |
| Trusted input simulation | **us + Grammarly Desktop** | the flash floor |
| Accessibility writes (`SetValue`) | — | Slate ghost (broken) |

**TSF** is the *participant's* entrance. A registered text service replaces
ranges through the input pipeline; Chromium converts those edits into trusted
composition / `insertReplacementText` events
([`tsf_text_store.cc`](https://chromium.googlesource.com/chromium/src/+/lkgr/ui/base/ime/win/tsf_text_store.h):
`SetText(acp_start, acp_end)` → select+insert in one edit session). It's the
channel the OS's own autocorrect uses to replace a word in Discord **with no
flash**. If we can ride it, the flash dies — everywhere TSF-aware, Discord
included.

## What it would buy us (capabilities)

| Capability | Replaces | Class |
|---|---|---|
| Trusted, positioned, **selection-free** range writes | the paste dance + the flash + arguably the EM path | the headline: **no flash anywhere** |
| Real text-store change **notifications** (`OnTextChange`/`OnSelectionChange`) | the 150ms polling loop **and most of the echo/attribution machinery** — the write bracket, recent-writes ring, breaker all exist *only because* polling can't say who changed the text | architectural |
| True caret + pixel **range rectangles** (`GetTextExt`) | the phase-1 caret-at-end assumption; solves phase-2 overlay positioning | phase-2 enabler |
| First-crack **keystroke interception** (`ITfKeystrokeMgr`) | the planned `WH_KEYBOARD_LL` hook for Ctrl+Alt chords | phase-2 enabler |

So "no flashing + better APIs" is accurate — TSF could subsume the write path,
the read path, the caret model, AND chord interception. It is the natural
phase-2 architecture *if the kill-questions pass*.

## RESULT (2026-07-10) — Q2 passed live on Discord

The probe TIP was built, installed (one UAC via `register-tsf.ps1`), and
fired on Discord's Slate composer. **It worked, cleanly:**

```
Activate tid=30
PreserveKey Ctrl+Alt+J hr=0x00000000
OnPreservedKey: replacing focused document
edit: SetText hr=0x00000000 shiftedEnd=13
RequestEditSession hr=0x00000000 sessionHr=0x00000000
```

Confirmed against all three signals:
- **Q2 (the headline) — PASS.** `ITfRange::SetText` replaced the whole Slate
  document **flash-free** (no select-all highlight) **and with no ghost** —
  the composer stayed fully typeable/deletable afterward. This is the exact
  write `ValuePattern.SetValue` could not do (the ghost) and that the paste
  path cannot do without the flash. TSF's trusted edit session sails through
  where every other channel failed.
- **Q1 (activation) — PASS (basic).** `register-tsf.ps1` registered it; the
  profile appeared in Win+Space and switching to it worked. (Still open: the
  non-keyboard-category variant to avoid the IME slot for CJK users — a
  refinement, not a blocker.)
- **Q3 (daemon latency) — untested** by the local-key probe; the socket-driven
  edit-session design remains the one unknown before a production build.

**Verdict flips: TSF's flash-free write path is PROVEN on the hardest editor
we have.** It is no longer a theoretical phase-2 contender — the capability is
demonstrated. What remains is entirely cost/architecture (install invasiveness,
the socket-driven design, non-keyboard category), not "does it work."

## The three kill-questions (what the probe TIP tests)

Built in `../native/tsf/` (see its README to run). Priority order — each can
kill the idea cheaply:

1. **Q2 — does a TSF range `SetText` replace Slate flash-free, no ghost?**
   *The whole point.* Chromium's source says it converts to select+insert;
   the strong prior (autocorrect doesn't flash) says no visible highlight;
   Slate should accept it because the events are trusted. But Slate rejected
   *everything* else — this must be seen, not assumed. **Test: focus Discord,
   type text, Ctrl+Alt+J, watch.**
2. **Q1 — activation & IME coexistence.** Can `register-tsf.ps1` enable the
   profile so no manual Win+Space is needed? And (follow-up, not in this
   probe) can we register in a **non-keyboard category** so we don't occupy
   the single IME slot per language — critical for CJK users who need their
   real IME? The probe registers keyboard-category to prove the *write* first.
3. **Q3 — edit-session latency for the daemon design.** The probe replaces on
   a local key. Production would drive edits from the WSL daemon over a socket
   — animation frames at ~13/sec through a cross-thread edit-session request.
   Is that fast/robust enough, or does the DLL need local logic? (Untested by
   the probe; a design question flagged for later.)

## The install cost (the real objection)

TSF registration is **HKLM** (COM `InprocServer32` + `ITfInputProcessorProfiles`
+ category) — [MS docs](https://learn.microsoft.com/en-us/windows/win32/tsf/text-service-registration),
and how every third-party IME ships ([Weasel/RIME](https://deepwiki.com/rime/weasel/7-installation-and-setup)
runs silent `regsvr32`; [Keyman](https://help.keyman.com/products/windows/9.0/docs/advanced_tsf)
registers a TSF add-in). No documented per-user path, and per-user COM
wouldn't be honoured by elevated apps anyway. Irreducibles:

- **One UAC prompt** at install (HKLM). Everything else is programmatic.
- **Our DLL loads into every focused app.** A bug crashes *that app*. This is
  what a TIP *is*; it can only be mitigated (thin proxy, below), never removed.
- **A code-signing cert** in practice — an unsigned DLL loaded everywhere is
  EDR bait (docs say "should" sign; reality says must).
- **Per-app DLL lifetime**: on update the file is locked until apps restart.

### How seamless it can get (design)

```
opencues install windows --tsf     # optional layer, default OFF
  -> one UAC prompt (irreducible)
  -> drop one small signed DLL + regsvr32 (COM + TSF profile + category)
  -> programmatically enable+activate the profile
uninstall: regsvr32 /u + delete (DLL frees on app restart)
```

Three moves make it palatable, none free:
1. **Thin-proxy TIP** — the DLL holds *no OpenCues logic*, just marshals
   edit-session calls to the WSL daemon over the existing socket. Same
   thin-shim/fat-runtime philosophy, in-proc: the DLL rarely changes (less
   update churn) and the in-proc crash surface is minimal.
2. **Optional enhancement layer** — base install stays exactly as today (zero
   admin, `rm -rf` uninstall); TSF is opt-in "seamless mode" that upgrades
   writes/caret/events where present and degrades to current paths where not.
   Nothing regresses.
3. **Non-keyboard category** — register like the speech/handwriting TIPs, not
   `TFCAT_TIP_KEYBOARD`, to avoid the IME slot and the switcher. This is Q1's
   follow-up — plausible but under-documented; only a prototype settles it.

## Verdict (updated after the live PASS)

- **Still not for phase 1.** The capability is proven, but the *cost* hasn't
  changed: a UAC prompt + our DLL in-proc in every focused app + a signing
  cert + a whole new install surface, to delete one ~100ms flash on Discord.
  Disproportionate for phase 1. The shipped shim stays exactly as-is; Discord's
  flash remains the accepted floor *for the current architecture*.
- **The lead phase-2 architecture, now de-risked.** Phase 2 wants overlay
  positioning, chord interception, and event-driven reads *anyway* — TSF
  delivers all three PLUS the flash-free write, and its headline risk (does the
  write even work on a model-first editor?) is now retired with a live PASS on
  Slate. What's left before committing is cost/design, not feasibility:
  1. **Q3** — socket-driven edit-session latency (animation frames at ~13/sec
     over the WSL socket, cross-thread edit-session requests).
  2. **Non-keyboard category** — coexist with real IMEs (CJK users).
  3. **Thin-proxy + optional-layer + signing** — the install-seamlessness work.
  When phase 2 starts, this spike is the foundation to build the real
  thin-proxy TIP on — not a research question anymore, an engineering one.

## Revert

The entire spike is `../native/tsf/` + this doc, all committed **after** the
branch's spike-anchor commit `7dcc0017` (the last shipped-shim change). To
erase it: `git revert` that commit range, or reset the branch to `7dcc0017`.
Nothing here is imported by the shim, the daemon, or any installer, so
removal is inert — no dangling references.
