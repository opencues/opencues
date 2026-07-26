# @opencues/mac — the universal macOS host

Answers `_`-gated blanks in the **focused text element of any app** —
TextEdit, Notes, Mail, Stickies, any native text field — via the
macOS Accessibility API. One daemon covers the whole desktop: no
polling, no per-app automation, no plugins.

```bash
opencues install mac    # build + stage + Accessibility permission probe
opencues run mac        # start the daemon (aliases: macos, ax)
```

Type `the tallest mountain in japan is _` into any focused text field
and the answer replaces the `_` in place, formatting untouched.

## How it works

```
opencues run mac
  └─ node integrations/mac/dist/daemon.js
       ├─ dist/ax-bridge (Swift, ../ax-bridge.swift)
       │    • AXObserver on the frontmost app: focus / per-keystroke
       │      change / cursor events, pushed as JSON lines — no polling
       │    • replace commands: ~1ms in-place range writes
       └─ src/daemon.ts — thin glue to the runtime's universal
            (no-cycling) boot; src/ax-host.ts holds the pure logic
```

The buffer IS the element's value and the cursor IS the real caret, so
the host is nearly stateless. The pure logic (`ax-host.ts`,
unit-tested) is three small pieces:

- `utf16Diff` — runtime writes become ONE small range replace.
- `freshMarkerAtCursor` — a standalone `_` arms only when TYPED at the
  caret (marker count must grow; focus content is context, never a
  trigger).
- `WriteRing` — our own writes echo back as change events; a change
  matching a recent write is ours, anything else is the user's (and
  clears the ring).

## The write path

Two methods, learned per focused element by verifying re-read
(log line `write path` names the one in use):

1. **`AXReplaceRangeWithText`** — an ATOMIC, selection-free range
   replace: never touches the caret, nothing to highlight. Private
   parameter encoding (reverse-engineered, see AX-SPIKE.md):
   `{"AXReplacementRange": <AXValue range>, "AXReplacementText":
   <string>}`. Works on focused AppKit views and WebKit/Electron
   views. **Its return value lies** (AppKit's default stub returns YES
   without editing), hence the verifying re-read.
2. **Selection transaction** (fallback) — select → replace → restore
   the prior selection delta-adjusted, three synchronous calls on the
   app's main thread. Rendering needs a runloop turn, so the
   intermediate selection is never painted; the insertion point is
   handed back in ~1ms.

Both paths perform the edit like a keystroke (the app's own text
machinery does it), so rich formatting survives — verified against
styled text in AX-SPIKE.md.

## Permissions

Needs **Accessibility** (System Settings → Privacy & Security →
Accessibility) for the process that launches the daemon. This is a
different TCC class from the Automation permission AppleScript-based
hosts use. The bridge reports `trusted:false` and the daemon exits
with the fix path when the grant is missing.

## Scope decisions (v0)

- **Focused element only.** Blur/app-switch resets buffer state (the
  universal-band contract). Background documents don't exist for this
  host.
- **Secure fields never leave the bridge** (AXSecureTextField → blur).
- **Terminals denied by default** (`com.apple.Terminal`, iTerm2, Warp,
  Ghostty — oc-shell owns that surface); extend the denylist via
  `OPENCUES_AX_DENY=bundle.id,bundle.id`.
- Values over 200k UTF-16 units → blur (a focused log viewer must not
  flood the pipe).
- Fields whose app rewrites text (autocorrect, smart quotes) may
  misclassify our transformed echo as a user edit — the resolver's
  live-text guard absorbs this (worst case: one dropped resolution).
- **Cycling (experimental, `feat/mac-cycling`)**: AX itself delivers no
  keystrokes, so the bridge captures Ctrl+Option+↑↓←→ with a session-level
  `CGEventTap` (armed under the Accessibility grant it already needs — no
  Input Monitoring prompt) and consumes them ONLY while the daemon says a
  non-denied field is focused (`{"cmd":"capture","on":…}`). `supportsCycling`
  is therefore per-target rather than a constant false.
  - **Navigate first, then cycle**: Ctrl+Option+←/→ moves OpenCues' highlight
    onto a word, Ctrl+Option+↑ cycles THAT word. `↑` with no prior navigation
    is a no-op (the log shows `consumed=false`).
  - **No visible highlight yet.** Cycling swaps the word in the buffer, but
    nothing paints the dim/active spans a cycling host normally shows —
    that needs an overlay window fed by `AXBoundsForRange` (the shape
    Windows phase-2 uses). Until then cycling is functional but blind.
  - Turning it on un-prunes word-cues + sentence-cues, so ordinary typing
    now costs LLM calls in every app. `OPENCUES_AX_CYCLING=off` restores
    the previous no-cycling profile exactly.
  - See docs/architecture/universal-integration.md.
- **Spotlight-only field semantics.** Its search field is treated as a
  disposable question box: answers stay short (~37 chars,
  `OPENCUES_AX_CHAR_BUDGET`) and **replace** the typed query rather than
  trailing after it (`capital of france _` → `Paris`,
  `OPENCUES_AX_REPLACE_QUERY`). Every other app keeps the
  fill-only-the-`_` behaviour — see
  docs/features/answer-replaces-query.md.

## Debugging

- `tail -f /tmp/opencues.log | grep '\[mac\]'`
- `DEBUG_OPENCUES=1` for debug-level lines to stderr.
- `dist/ax-bridge` standalone (hold stdin open: `tail -f /dev/null |
  dist/ax-bridge`) logs every focus/change event as JSON.

## Known-unknowns

- One daemon launch (2026-07-12, first run) received no focus events
  until restart — not reproduced since. If it recurs, check whether
  NSWorkspace activation notifications reach the bridge (standalone
  run above shows every focus).
- Electron/web-content fields (AXWebArea internals) untested; browsers
  are covered by the chrome extension.
- Channel evidence + reverse-engineering notes: `AX-SPIKE.md`; probe
  tool: `scripts/ax-spike.swift`.
