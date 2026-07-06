# Notes.app platform findings (Phase 0 spike, 2026-07-06)

Measured on macOS 15 (Darwin 24.1.0), Apple Silicon, iCloud account with **335 notes**.
Spike scripts: `scripts/spike.mjs` + `scripts/spike-jxa.js` (all writes confined to the
"OpenCues Spike" folder; remove artifacts with `node scripts/spike.mjs --cleanup`).

## Verdict: GO

| Operation (one osascript spawn each) | median | max | go criterion |
|---|---|---|---|
| `Application('Notes').running()` | ~30ms | 51ms | — |
| Enumerate ALL notes: bulk `notes.id()` + `notes.modificationDate()` (335 notes) | 91ms | 97ms | "acceptable at account size" ✔ |
| Read one note (name + plaintext + body) | 205ms | 210ms | ≤500ms ✔ |
| CAS fill (re-read body, verify unique fragment, splice, write) | 159ms | 174ms | ≤800ms ✔ |

Bulk property fetch is the key win: ids for the whole account cost ~63ms + modDates
~11ms *inside* the script, so a poll tick over 335 notes is dominated by osascript
process spawn (~80ms). All-notes scope is cheap.

## Body HTML shape

- One `<div>…</div>` per line, joined with `\n`. Empty line = `<div><br></div>`.
- `plaintext` corresponds line-for-line with the `<div>` sequence and ends with a
  trailing `\n`. No other normalization observed.
- `modificationDate` has **1-second resolution** — don't use it for sub-second echo
  discrimination; compare content hashes instead.

## ⚠️ Entity encoding is NON-STANDARD on read-back

Notes re-serializes `body` with **semicolon-less entities**:

| plaintext | body on read-back |
|---|---|
| `<tag>` | `&lttag&gt` |
| `&` | `&amp` |
| `"quotes"` | `&quotquotes&quot` |
| `'` `—` `😀` `éèü` | literal, unescaped |

Writing *standard* entities (`&lt;` with semicolon) is accepted and round-trips into
correct plaintext — but the body you read back is in the semicolon-less form.

**Consequence for the CAS splice:** never locate the target line by escaping plaintext
yourself and `indexOf`-ing it. Instead split body into `<div>` fragments, **unescape
each fragment** (handling the semicolon-less forms), and compare against the plaintext
line. Replace that exact fragment; write the new line with standard escaping.

## CAS behavior

- Zero-match after content changed is correctly detected (`{conflict: 'zero-match'}`),
  which is exactly the stale-fill protection we want.
- Read-verify-splice-write inside a single osascript invocation keeps the race window
  at ~150ms.

## TCC / Automation permission

- Denial = osascript exit 1, stderr contains `(-1743)` — cleanly classifiable.
- **A cached deny is SILENT and instant** (~70ms, no dialog). Observed in the wild on
  this machine: the deny was recorded for `com.apple.Terminal` without any prompt ever
  being shown (likely auto-denied while the requesting process ran sandboxed).
- Recovery that worked: `tccutil reset AppleEvents com.apple.Terminal`, then have the
  USER enable Terminal → Notes in System Settings → Privacy & Security → Automation
  (or re-trigger the prompt from their own shell). `opencues doctor` must surface the
  -1743 state with these exact instructions — users will hit the silent-deny trap.
- `running()` needs no permission; safe as the daemon's pre-flight probe.

## Not yet exercised (manual steps for the e2e checklist)

- Attachment-bearing note: `body` set is expected to destroy attachments (guard:
  skip notes whose body matches `<img|<object|<attachment|data:`); verify manually
  via `attachment-check` subcommand after dropping an image into a spike-folder note.
- iCloud cross-device edit during a pending fill (verify CAS conflict path with a
  second device).
- Password-locked notes (expected: invisible to scripting or throwing per-note —
  bulk fetch worked fine on this account, which has none).
