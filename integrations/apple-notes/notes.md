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
- **Refinement (2026-07-09 13:44):** the CAS can LAND in Notes even
  when its osascript errors (id swapped mid-script) — the new id then
  holds our ANIMATION FRAME ("Draft an email •") while the snapshot
  says "_", so content/prefix matching failed by one character, the
  swap read as deletion, and the frame froze in the note with no
  marker left to re-arm ("Draft an email _ becomes • and does
  nothing"). The remap now also matches when the candidate's content
  hashes into the vanished note's `lastWriteHash` ring — our own
  write under a new id is the strongest identity proof there is.

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

## "Translations come back mangled" — two CROSS-HOST runtime bugs (2026-07-09)

Symptom: transform outputs (translations especially) arrived with
original-language fragments stitched into them ("…Für Mittagessen ist
gesorgt.\n\nViele Lunch will be provided.\n\nBest, Sam"), and some
transform answers silently never arrived at all. Initially blamed on
gemma-4-31b reproduction quality — WRONG. Both bugs live in the shared
runtime and affect every host; Notes surfaced them first because notes
exercise whole-document transforms constantly, while input boxes
rarely do.

**How it was proven model-independent:** an A/B on identical content
produced the byte-identical artifact on gemma-4-31b AND gpt-oss-120b;
then a pure-code reproduction with `live === snapshot` — the case
where `threeWayMerge` must return the rewrite verbatim — produced the
corruption with no LLM involved. (The bench archive's
"Frankenstein bilingual buffer" production sighting, attributed at the
time to max_tokens truncation, is plausibly this same bug —
`tests/benchmarks/transform-blank/budget-translate-probe.ts` header.)

**Bug 1 — threeWayMerge's paragraph-break heuristic vs commanded
rewrites** (`packages/opencues-runtime/src/modules/word-diff.ts`).
The merge's survival rules were built for AgentRewrite: a background
rewriter must never canonicalise structure the user typed, so any hunk
whose replacement carries fewer `\n\n` runs than its original is
dropped. On a full translation, word-diff hunk boundaries slice
paragraph breaks ASYMMETRICALLY, so a content-critical hunk trips the
rule, gets dropped, and the original text survives inside the rewrite.
Fix: `threeWayMerge(…, { mode: 'authoritative' })` for user-COMMANDED
rewrites (TransformBlank) — untouched buffer → rewrite verbatim;
typing during the call still wins (the user-overlap rule is kept).
AgentRewrite's conservative default is unchanged. Pinned by three
regression tests in `word-diff.test.ts`.

**Bug 2 — real animation frame chars tripping the transform race
guard** (`packages/opencues-runtime/src/modules/resolver.ts`). The
guard compares live text against the analyzed original, stripping ZWS
because CC's spinner animates via invisible ZWS toggles. Hosts whose
animator writes REAL frame chars (apple-notes `•`/`‾`, terminal hosts)
made liveText differ by one real character mid-cycle: ~half of
completed transform answers were discarded as "live text changed", and
surviving merges saw a fake user edit at the frame position. Fix:
`stopAllAnimations()` (which restores every slot to `_`) now runs
BEFORE the guard reads the live buffer.

Verified end-to-end after both fixes: the exact email that corrupted
pre-fix translates cleanly on gemma-4-31b ("Viele Grüße, Sam", zero
English fragments). `ARCHITECTURE.md` § 8 carries the correction to
the earlier model-blame attribution.

## "ONE use before it breaks" — the 1-second modificationDate hole (2026-07-09)

Symptom: the first command in a note works; a follow-up (or even a
single trailing keystroke) kills everything after it — six flush
retries all dropped with the SAME byte diff, then silence. The drop
log's byte detail cracked it in one read:

    cur : "…t all caps _ "   (403 — the user typed a trailing space)
    snap: "…t all caps _"    (402 — the poll never saw it)

Notes' `modificationDate` has **1-second resolution**. A keystroke that
lands in the same wall-clock second as the previously-fetched state
changes the note WITHOUT changing its mod string → `selectChanged`
skips it forever → the tracked snapshot is permanently stale → every
fill (frames AND answer) drops on the snapshot guard. "Resyncs next
poll" was a lie: the poll physically cannot see sub-second edits that
are followed by inactivity. First use always works (fresh note, fresh
fetch); fast typing right after any fetch is a coin-flip desync —
hence "one use before it breaks".

Fix (`daemon.ts` doFill mismatch branch): at drop time the daemon is
HOLDING the authoritative fresh text it just read — it now resyncs the
tracked snapshot itself. If the fresh text hashes into our write ring
→ own echo → retry against the resynced base. Otherwise it's a real
user edit: their text wins — drop the pending write, resync, and
RE-DISPATCH (arm the marker nearest the change; an edit AROUND a live
`_` must not orphan it) so the resolution re-runs against what they
actually typed — the same semantics as a keystroke during resolve on
the event-driven hosts. Verified live: create note → trailing-space
edit inside the same second → "user edit wins, re-dispatching" →
answer landed 1.1s later.

## Overlapping-resolution assassination via frame-fill re-dispatch (2026-07-09)

Symptom: "good for one or two prompts, then they stop responding" —
typing a follow-up command while the previous answer's animation was
still flowing spawned a SECOND resolution (a frame fill compared
against the newest armed text, differed — the user's keystrokes had
re-armed with slightly different text — and tripped the multi-cue
re-dispatch). The two resolutions then mutually assassinated: when one
landed, its buffer change made the other's completed answer fail the
live-text guard ("skipping — live text changed, 151 vs 181") and be
discarded. NOT caused by the Windows-port TTL/breaker (zero trips).

Fix: re-dispatch only fires when the pipeline is DRAINED — the landed
fill must be the LATEST runtime write (`virtualText` empty or equal).
A frame landing while a newer write is pending can never spawn a
competing resolution; the drained answer-fill still re-dispatches for
genuine multi-cue notes, and an aborted resolution's final frame still
re-dispatches as the recovery path.

Same trace, separate issue: gemma-4-31b answered "Add emojis _" by
REWRITING the poem into a hostile parody with zero emojis. That is the
un-benched model, not the pipeline — logged here so note-vandalism
reports point at the model choice.

## Notes' emoji re-serialization leaking into the runtime buffer (2026-07-09)

Symptom after the drained-gate fix: "prompt effects are slow and
animations unresponsive" — every command in an emoji-bearing note
burned a full DISCARDED resolution first: "skipping — live text
changed (live 363 vs original 362)" — ONE character — then a
re-dispatch and a second LLM round before landing. The char is Notes
itself: emoji (variation selectors) don't round-trip byte-identically,
and after a flush completed the daemon DROPPED the virtual buffer, so
getText fell back to the tracked snapshot — Notes-normalized bytes the
runtime never wrote. That drift invalidated the transform guard
mid-resolution on every command touching emoji content.

Fix: the virtual buffer is RETAINED across flushes — getText serves
the runtime's own bytes until a genuine user change, note switch, or
active-gone replaces them (the same contract every other host has for
free: the buffer changes only via the runtime's writes or user keys).
Notes' normalized reality still drives the splice diffs (tracked
snapshot) and echo hashing (as-landed text) — it just never leaks into
the runtime's view again. Verified: emoji answer + follow-up translate
lands in ONE attempt, zero skips.

## Windows-integration fixes, cross-checked and ported (2026-07-09)

The Windows daemon shares our core blindness (no keyboard; infer input
by reading text back; must recognise its own writes). Its four fixes,
mapped against ours:

| Windows fix | Status here |
|---|---|
| #1 recent-writes registry + read-back normalization (CR→LF, strip zero-width) | Already present and STRONGER: `lastWriteHash` ring hashes both the intended text and the AS-LANDED text Notes returns post-write, absorbing arbitrary mangling (our `‾` round-trip = their `\r`/U+FEFF). |
| #2 registry must not eat a real `_` | **Ported, apple-notes-shaped.** Their marker-count guard would misfire on our rest frames (which legitimately restore `_`), so ours is a TTL: ring entries expire after `WRITE_HASH_TTL_MS` (30s). A fill lifecycle is seconds; a LATER identical re-type of the same command can no longer be classified as our own echo and swallowed. Pinned by tests. |
| #3 circuit breaker (self-healing on runaways) | **Ported.** `armGuarded` counts consecutive same-text arms; >3 trips a 10s pause on resolution triggers with a loud `circuit breaker TRIPPED` log line. Backstop only — every known loop already has a targeted guard. |
| #4 breaker must not trip on typing | Ported as designed: the counter resets the moment the armed text differs, and typing changes the text every keystroke — a true runaway (same text bouncing) still trips it. |
| singleton (two daemons racing one buffer) | Already enforced since day one: pid lockfile + stale-lock recovery (`acquireLockOrExit`), duplicate daemons refuse to start. |

Unrelated environmental note from the same session: Notes.app itself
can time out plaintext fetches when busy (log: "plaintext fetch failed
(timeout)"); the daemon rides it out and recovers on later polls —
if commands seem dead AND these warnings are present, it's Notes
being slow, not the daemon.
