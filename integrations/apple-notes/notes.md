# notes.md — why "it works, then it breaks" kept happening (2026-07-08/09)

A post-mortem of the recurring apple-notes breakage, written so the
next person (or model) debugging "blanks stopped working in Notes"
reads this FIRST. Companion docs: `NOTES-PLATFORM.md` (platform
measurements), `CLAUDE.md` (invariants), and the band repair log.

## The root cause: Notes' temporary → permanent CoreData id swap

When a note is created in the Notes **UI** (⌘N) and the user types
immediately, AppleEvents enumeration first returns it under a
**temporary CoreData id**:

    x-coredata://…/ICNote/t02CDA686-4661-48D1-940E-2F20B0406D476   ← t-prefix

One to two seconds later Notes commits the object and the SAME note
enumerates under its permanent id:

    x-coredata://…/ICNote/p948

The daemon interpreted the swap as *tracked note deleted* + *unrelated
new note appeared*:

1. the in-flight fill's CAS failed under the old id
   (`Can't get object (-1728)`),
2. tracking was dropped (`note untracked (reason: deleted)` /
   `note deleted mid-fill`),
3. `resetBufferState()` killed the in-flight LLM resolution,
4. the note re-tracked under the new id and re-armed, colliding with
   animation frames and live typing.

Every failure session across 2026-07-08/09 shows the same log
signature — `active note switched {t…}` followed within ~2s by an
untrack — including the original "fills AAPL price but not normal
queries" report:

| session | temp id | symptom |
|---|---|---|
| 07-08 07:57 | tE1EA3A05… | "fills AAPL but not normal queries" |
| 07-08 19:56 | t64DA3892…23 | "Draft an email _" vanished |
| 07-08 20:01 | t64DA3892…26 | resignation-letter session chaos |
| 07-09 10:28 | t02CDA686… | draft dead again, CAS -1728 in log |

## Why the fix/verify cycle kept repeating

Verification probes created notes via AppleScript
(`make new note … with properties {body: …}`), which returns the
**permanent id at birth** — those notes never cross the swap. So every
"verified working" pass was structurally blind to the exact flow the
user exercises (⌘N, type a cue, wait). The two realities coexisted:

- **probe flow**: permanent id → always worked;
- **human flow**: temp id + a multi-second LLM resolution straddling
  the swap → broke every time.

Instant fills (stock prices, countries — sub-second, often landing
before the swap) usually survived; anything slow (draft/transform,
fluid lookups on a slow model) always straddled it. Hence
"price cues work but drafts don't".

The intermediate bugs fixed along the way were real (mod-date election
flapping, virtual-buffer byte identity, splice ambiguity on duplicate
cue lines, rest-frame redispatch storms — see the band repair log and
git history), but fixing each one re-opened the loop because the probe
methodology couldn't observe THIS one.

**Lesson: any apple-notes e2e verification MUST include a UI-created
note (⌘N + typing, or computer-use automation), not only
AppleScript-created notes.**

## The fix (2026-07-09)

Id **continuity** in the pure poll layer (`src/tick.ts`, event
`id-remapped`, pinned by four scenario tests in `tick.test.ts`):

- `applyPoll` detects a same-tick *tracked-id vanished* + *never-seen
  id appeared* pair whose fetched text matches the vanished snapshot
  (exact, or prefix modulo the canonical trailing `\n` — typing
  appends), and migrates identity instead of deleting: tracked
  snapshot, `userEditAt`, the `lastWriteHash` echo ring, and
  `activeId` all carry over.
- A pure identity swap emits ONLY `id-remapped` — no text-change, no
  switch-active, no buffer reset. The runtime never notices.
- The daemon migrates its id-keyed maps on that event: `knownBody`
  (CAS body cache), `echoPending`, `lastRedispatchText`, and
  `virtualNoteId`.
- A mid-fill `not-found` no longer untracks — the next poll resolves
  it as either a swap (remap; the pending write retries under the new
  id) or a genuine deletion (enumeration alive-check).

## Secondary finding (same investigation)

`gemma-4-31b` occasionally **answers** an imperative draft command as
a sentence completion ("Draft an email _" → "I'm writing to follow
up…") instead of ceding to TransformBlank. The cede rules in the FUSED
prompt were bench-validated on other models; gemma was never benched.
This is nondeterministic model quality, independent of the id swap —
if drafts occasionally come back as a single continuation line rather
than a full draft, that's this, not the daemon.

## Degradation after 2-3 commands in the SAME note (2026-07-09)

Symptom: the first couple of commands in a note are fast and correct,
then speed and quality collapse and commands stop executing. Not a
daemon bug — a scaling property of running every command in one
long-lived note, colliding with TransformBlank's whole-buffer design.

The note ACCUMULATES each command + answer (observed live: 35 chars at
the first command → 1,147 chars an hour later). TransformBlank rewrites
the ENTIRE buffer per command, so each new instruction asks the LLM to
reproduce the whole accumulated document verbatim plus execute the
change. Three compounding effects:

1. **Speed** — every command pays a full-document rewrite
   (reasoning=medium over 1,000+ chars, 12+ line outputs, seconds per
   attempt, sometimes retried) instead of a one-command rewrite.
2. **Quality ("lost intelligence")** — verbatim-reproduction fidelity
   collapses with length: observed a 451-char buffer returned for a
   1,148-char note (~700 chars of user content dropped). The
   live-text guard rightly discards such answers — but the user just
   sees "nothing happened" or a mangled draft.
3. **Execution** — leftover `_`s in accumulated content re-fire the
   multi-cue re-dispatch, spawning EXTRA whole-buffer resolutions that
   race animation frames → `note changed since resolution — fill
   dropped` storms.

Other hosts never hit this because their buffer is an EPHEMERAL input
box, consumed and cleared per message — TransformBlank's whole-buffer
contract always operates on ~one command of text there. A note is a
persistent, growing document; nothing windows the buffer down to the
command being typed.

> **RETIRED same day (2026-07-09, user decision).** The paragraph
> window shipped and worked as designed, but the design was wrong for
> real content: ANSWERS are themselves multi-paragraph (emails have
> blank lines between salutation/body/signoff), so "type the command
> directly under the content" only reached back to the content's LAST
> blank line — "prompts only affect lines up to a return". Scope is
> whole-note again: every prompt analyzes and may rewrite the entire
> note. The known cost returns with it: quality/speed degrade as one
> note accumulates content (gemma's verbatim reproduction of long
> buffers is the weak link) — keep notes per-task, or accept the
> degradation. The durable fix remains "full note in, patch out"
> (TransformBlank emitting only the changed region) — a core, bench-
> gated change. The section below is kept for the design record; the
> v1 bugs it lists were real and their FIXES survive (the flush retry
> is scope-independent and still shipped).

**Fixed 2026-07-09: the PARAGRAPH WINDOW.** The runtime's buffer on
this host is now the blank-line-delimited paragraph containing the
active cue (`tick.ts paragraphWindow` + `daemon.ts dispatchWindow`),
not the whole note. Every command is constant-cost regardless of note
length; a window move resets the runtime buffer state ("fresh context
per command"); content outside the window is never dispatched,
analyzed, or rewritten. The note-side write path stays whole-note
(flush reassembles prefix + windowRaw + suffix; diff/splice/CAS
unchanged), and the getText byte-identity contract holds — the window
serves back exactly the bytes the runtime last received or wrote.

USER CONVENTION: a command that operates on earlier content must be
typed DIRECTLY under it (same paragraph — no blank line between).
A blank line above the command = a fresh, isolated scope. Verified
live: a poem command in its own paragraph resolved with textLen=38
while 85 chars of older content sat untouched above it; a translate
command typed under its target line saw that line (textLen=82) and
rewrote only that paragraph.

### Two v1 window bugs, same-day (2026-07-09): "works a couple times, then stops"

1. **The window silently grew back to whole-note scope.** The
   same-window fast path matched on `startsWith(prefix)` /
   `endsWith(suffix)` — but a last-paragraph window has `suffix: ''`,
   and `endsWith('')` is ALWAYS true, so every paragraph the user typed
   below joined the existing window. By command 2-3 the buffer was the
   entire note again: slow, low-fidelity, and destructive (observed:
   command 2 ran with textLen=122 — the whole note — and its rewrite
   consumed the previous answer). Fix: the sliced base must remain ONE
   paragraph (no interior blank line) or the window moves. Consequence
   to know: a multi-paragraph ANSWER echoing back also reads as a
   window move — harmless on this no-cycling host (there is no revert
   channel to lose), and the window then narrows to the answer's last
   paragraph.

2. **A dropped answer was lost forever.** `flushVirtual` cleared the
   virtual buffer after `doFill` regardless of outcome. The snapshot
   race guard's "fill dropped (resyncs next poll)" was only ever true
   for animation frames — the animator rewrites those every ~150ms —
   but the FINAL answer is written exactly once, so one race against
   the user's typing discarded it permanently (observed live: three
   completed translations in a row, all computed, none landed; the
   user experienced "not responding"). Fix: `doFill` returns
   landed/retry/fatal/noop; transient outcomes (snapshot race, CAS
   conflict, id-swap not-found, splice miss) keep the buffer and retry
   up to 6× at 400ms while the poll resyncs. A user edit still wins:
   its text-change event drops the buffer and cancels the retry.

Diagnostic aid added at the same time: the "note changed since
resolution" drop log now includes `curLen`/`snapLen`/`firstDiff` and
a ±12-char excerpt of both texts at the divergence point — the next
snapshot-mismatch investigation starts from bytes, not theories.
