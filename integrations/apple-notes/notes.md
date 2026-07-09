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
