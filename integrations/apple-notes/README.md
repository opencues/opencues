# OpenCues for Apple Notes (macOS)

Type a cue ending in `_` in any unlocked Apple Note; the answer replaces
the line in place a moment later.

```
distance to the moon in km _
```

## How it works

A daemon (`opencues run apple-notes`) polls Notes.app over JXA
(`osascript -l JavaScript`):

1. **Detect** — one bulk enumeration per tick (~90ms for 335 notes)
   returns every note's id + modificationDate; plaintext is fetched only
   for notes that changed; only notes containing a standalone `_` blank
   marker are tracked. Cadence adapts: 500ms while you're editing, 2s
   idle, paused entirely while Notes.app isn't running.
2. **Resolve** — the most recently modified cue-bearing note becomes the
   OpenCues runtime buffer (universal/no-cycling profile: no key events,
   no cursor, no colour — so cycling cues are pruned; `_` blanks work).
3. **Write back** — the answer is spliced into the note's body HTML as a
   targeted line replacement, compare-and-swap-verified inside a single
   osascript call. If the note changed under us (you kept typing, iCloud
   synced an edit from your phone), the fill is dropped and re-resolved
   on the next poll — never a corrupting write.

## Safety properties

- **Attachment-bearing notes are skipped** — a body write would destroy
  images/scans/checklists, so the daemon refuses to touch them.
- **Splice-only writes** — the body is never rebuilt from plaintext; a
  fill that can't locate a unique target line aborts silently.
- **Password-locked notes** are invisible to AppleScript entirely.
- **Oversized notes** (>30k chars) are skipped.

## ⚠️ Shared notes

Unlike every other OpenCues host, this buffer is **not only your
keyboard**: the daemon watches every unlocked note, and iCloud syncs
edits from other devices *and other people* into shared notes. Anyone
you share a note with can type `<request> _` and trigger a cue on your
machine — the same LLM calls and keyword blanks your own typing can
reach (they are capability-gated exactly like local input, and answers
only ever land as visible note text — there is no exec channel). If
that trade-off doesn't suit you, don't keep `_` markers in shared
notes, or stop the daemon while collaborating. Threat-model detail:
`docs/architecture/security-audit.md` row #31 (a shared-note skip /
folder allow-list is a tracked follow-up).

## Install

```bash
opencues install apple-notes
```

macOS will ask for permission for your terminal to control Notes
(Automation / Apple Events). **If you deny it — or no prompt appears —**
the deny is cached silently; `opencues doctor` explains the fix
(System Settings → Privacy & Security → Automation, or
`tccutil reset AppleEvents <terminal-bundle-id>`).

## Run

```bash
opencues run apple-notes
tail -f /tmp/opencues.log | grep '\[apple-notes\]'   # watch it work
```

Platform measurements + quirks: [NOTES-PLATFORM.md](NOTES-PLATFORM.md).
Band repair log: `packages/opencues-runtime/adapters/apple-notes/REPAIR.md`.
