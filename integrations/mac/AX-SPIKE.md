# AX hybrid spike — findings (2026-07-12)

Question: can the macOS Accessibility API give this integration a real
editor channel — focused-note text, a true cursor, change
notifications instead of polling, and in-place text replacement?

## Verdict: GO — every capability confirmed, with structural caveats

Probe: `scripts/ax-spike.swift` (build: `swiftc -O ax-spike.swift -o
/tmp/ax-spike`; modes: `tree` / `read` / `cursor` / `write <old>
<new>` / `watch <secs>`). All numbers measured live on macOS 15,
Notes with 342 notes, spike note `p997` displayed.

## Measurements vs the AppleScript channel

| Capability | AX | AppleScript (today) |
|---|---|---|
| Read full body plaintext | **<1ms** (`AXValue`) | 90–220ms osascript |
| Locate body element | ~10ms (targeted walk) | n/a |
| Replace a text range | **1ms**, formatting PRESERVED | ~160–830ms CAS |
| Cursor position | **real caret**, 0ms (`AXSelectedTextRange`, UTF-16 loc) | does not exist — synthesized from `_` position |
| Change detection | **push, per keystroke** (`AXObserver`: AXValueChanged + AXSelectedTextChanged per key, verified with real typing) | poll 150ms–2s + FSEvents wake |
| Works when Notes is backgrounded | **YES** (verified — whole spike ran with Notes not frontmost) | yes |
| Works when the note is not displayed | no — displayed note only | yes (any note) |

Key evidence:

- **Formatting survives AX writes.** Range-select via
  `AXSelectedTextRange` + set `AXSelectedText` edits in place like a
  keystroke (TextKit does the edit): bold, h1 title styling, and a
  bullet list all survived byte-perfect in the body HTML (verified by
  AppleScript body read after the AX write).
- **External writes fire notifications too.** An AppleScript body set
  produced AXSelectedTextChanged/AXValueChanged on the observed
  element — the hybrid still needs echo classification, but detection
  becomes push-instant instead of poll-lagged.
- **11 real keystrokes → 11 notification pairs**, plus a trailing
  pair seconds later (autosave/typography pass — the row-18 rewrite is
  visible on this channel too).

## Structural caveats (what AX cannot replace)

1. **Displayed-note only.** AX sees the note currently rendered in the
   Notes window. Background notes, other windows' notes, and
   phone-synced edits to non-displayed notes remain AppleScript
   territory. The AX channel is a HOT PATH, not a replacement.
2. **Identity mapping is unsolved.** The AX element carries no
   CoreData note id. Mapping "the displayed note" onto the daemon's
   tracked ids needs content matching (the id-remap machinery already
   does exactly this shape of work).
3. **AX offsets are UTF-16** code units; the runtime buffer is JS
   string (also UTF-16-indexed — likely a happy match, verify emoji).
4. **`AXValue` includes the title line** (first line = note title);
   AppleScript `plaintext` matched it exactly in this spike, but the
   equivalence needs pinning across list/checklist/table notes.
5. **Fragility class: UI tree.** The body lookup walks
   window → split group → last scroll area → AXTextArea. That's an
   implementation detail Apple can rearrange in any release —
   strictly worse stability than the 10-years-frozen AppleScript
   dictionary. The hybrid must degrade to the AppleScript path the
   moment the lookup misses (same posture as every other guard).
6. **Separate TCC class.** AX needs Accessibility permission for the
   daemon's host process — in ADDITION to the existing Automation
   grant. Install/doctor must probe and explain both.
7. **Untested**: attachment-bearing notes via AX (the AppleScript
   attachment guard must stay), locked notes, multiple Notes windows,
   split view, emoji/UTF-16 offset edge cases.

## Sketch: the hybrid architecture

- **Detection**: AXObserver on the displayed note → push events with a
  real caret; the poll loop drops to a slow reconciliation sweep for
  everything else (background notes, sync arrivals).
- **Animation frames**: AX range-writes at 1ms — the ~6fps CAS floor
  becomes effectively unlimited; frames stop competing with reads on
  the wedge-prone Apple Events queue entirely.
- **Committed answers**: keep the AppleScript CAS splice as the final
  write (byte-verified, CAS-guarded, works on any note) OR AX-write +
  AppleScript verify. Decide after offset-equivalence pinning.
- **Wedge posture**: AX rides a different IPC path than Apple Events;
  when Notes' event queue wedges, the AX channel likely keeps working
  (untested during a real wedge) — at minimum, reads stop stalling.

## Addendum (2026-07-12, same night): selection-free writes

The range-select + AXSelectedText write moves the user's caret. A
better channel exists and was reverse-engineered live:

- Text elements advertise the parameterized attribute
  **`AXReplaceRangeWithText`** — an ATOMIC range replace that never
  touches the selection. Its undocumented parameter encoding
  (recovered by intercepting `accessibilityReplaceRange:withText:` in
  a harness NSTextView and letting AppKit's own glue decode candidate
  dictionaries): `{"AXReplacementRange": AXValue(CFRange),
  "AXReplacementText": CFString}`.
- **Trap: the return value lies.** `accessibilityReplaceRange:withText:`
  exists only as an NSObject category default that can return YES
  without editing (observed against a backgrounded TextEdit). The ONLY
  reliable feature detection is a verifying re-read of the edited
  slice after the call.
- Against the FOCUSED element it edits for real on native AppKit views
  (TextEdit confirmed live, `write path: replace-attr`), and
  WebKit/Electron implement it explicitly. Backgrounded/unfocused
  elements are where the YES-no-op default shows up.
- Fallback for elements where verification fails: select → replace →
  restore the prior selection (delta-adjusted), three synchronous
  main-thread AX calls — nothing paints in between (rendering needs a
  runloop turn), so no visible highlight and the caret is returned.

Implementation: `integrations/mac/ax-bridge.swift` `replace()` —
tries the atomic path, verifies, learns per focused element.

## Cleanup

Spike note deleted (Recently Deleted, 30-day recovery). Probe source
kept at `scripts/ax-spike.swift`.
