# notes.md — the complete issue ledger (2026-07-08 → 07-09)

Read this FIRST when anything in the Notes integration misbehaves.
Every root cause found across the two-day debugging arc, its log
signature, and its fix. Companions: `ARCHITECTURE.md` (system
structure + host comparison), `PLAN.md` (the reliability/speed plan),
`NOTES-PLATFORM.md` (measured platform behaviour), `CLAUDE.md`
(invariants).

---

## 0. Why the fix/verify loop kept repeating — three verification blind spots

Every "verified working → broke in the user's hands" cycle traces to
one of these. They are STRUCTURAL: the tests could not see the failure
class at all.

| # | Blind spot | Bug classes it hid |
|---|---|---|
| B1 | AppleScript-created notes get PERMANENT CoreData ids at birth; UI (⌘N) notes start on TEMPORARY ids (`…/ICNote/tXXXX`) | every id-swap bug (rows 9-10) |
| B2 | Scripted notes are never RENDERED in the Notes UI, so foreground-only behaviour (the typography pass) never fires in tests | row 18 |
| B3 | Unit tests pin the pure layer; the failures lived in TIMING races only real typing produces | rows 5, 11, 16 |

**Standing rule: no change to this integration is "verified" without a
UI-grounded end-to-end pass (⌘N + real typing while the note is open —
computer-use automation or a human).** See PLAN.md § harness.

## 1. The bug ledger

Signatures are grep-able against `/tmp/opencues.log`.

| # | Root cause | Log signature | Fix (all shipped) |
|---|---|---|---|
| 1 | Blanks bucket pointed at a dead local provider (ollama not installed) | `FluidBlank: failed (…ms, llm=ollama/…)` in <15ms | config: bucket → cerebras |
| 2 | `opencues run notes` had no dispatch branch on the checked-out branch | silent exit 0 | branch merge; stale-dist lesson |
| 3 | setup.sh built the daemon BEFORE staging the fresh runtime | tsc error on new runtime types | stage-then-build |
| 4 | Splice located the target line by CONTENT only → duplicate cue lines aborted every fill | `could not locate a unique splice region` | diff line index disambiguates (`expectedStart`) |
| 5 | Animation REST frame re-triggered the multi-cue re-dispatch as a fake user event | `unanswered cue remains` mid-animation + aborted resolutions | dedupe map seeded at every arm site |
| 6 | Virtual buffer normalized the trailing `\n` BEFORE getText → runtime discarded its own answers | `skipping — live len=N+1, original len=N` | byte-identity: canonical forms on the WRITE path only |
| 7 | Active-note election by modificationDate → sync/echo/ghosts stole the buffer mid-resolution | `active note switched` flapping between ids | election by `userEditAt` (the note the user last typed in) |
| 8 | Recently-Deleted notes stay enumerated ~30 days and competed for election | flapping to previously-deleted ids | exclusion set (deleted-ids.js, 10s refresh). SUPERSEDED 2026-07-12: exclusion moved INTO list-notes.js — enumeration returns only live notes, deleted-ids.js removed, and the 10s stale window (a just-deleted note kept competing until the next refresh) is structurally gone |
| 9 | Temp→permanent id swap read as delete+create → fills failed, resolution reset | `switched {t…}` then `untracked (deleted)` + CAS `-1728` | id continuity (`id-remapped`: content, prefix, or write-hash match) |
| 10 | A fill's CAS can LAND while its osascript errors (id swapped mid-script) → new id holds our FRAME, content match failed by 1 char | frozen `•` in the note, marker gone | remap accepts the write-hash ring as identity proof |
| 11 | modificationDate is 1-SECOND resolution: a same-second keystroke is invisible to change detection forever → snapshot permanently stale | repeated `fill dropped` with `firstDiff` at a 1-char tail | doFill self-resyncs from the text it just read; user edit → re-dispatch |
| 12 | One-shot answer writes lost to snapshot races ("resyncs next poll" was only true for frames) | answer computed, never landed | outcome-based flush retry (6×400ms); user edit cancels |
| 13 | threeWayMerge's paragraph-break heuristic (built for AgentRewrite) dropped hunks of COMMANDED rewrites → original text stitched into translations. CROSS-HOST | mangled bilingual output; reproducible with live==snapshot in pure code | `authoritative` merge mode for TransformBlank |
| 14 | Real animation frame chars (non-ZWS hosts) tripped the transform race guard → ~50% of answers discarded. CROSS-HOST | `skipping — live text changed` ±1 char | stopAllAnimations() before the guard reads live |
| 15 | Blank-context: catalog fetch skipped on topical queries (scan over-claimed); post-process gated off on empty catalog; singular/plural token near-miss. CROSS-HOST | raw `[STOCKS NVDA]` tokens in the buffer | claimedSlotIndices; strip always runs; plural-tolerant index |
| 16 | Typing mid-animation re-armed per keystroke → frame fill re-dispatched vs stale text → OVERLAPPING resolutions assassinated each other | `skipping — live … vs …` then dead | re-dispatch only when the pipeline is DRAINED (landed fill == latest write) |
| 17 | Notes doesn't round-trip emoji byte-identically; dropping the virtual buffer post-flush let normalized bytes leak into the runtime → one discarded resolution per command | 1-char `skipping` on emoji notes; double latency | virtual buffer RETAINED until a user change/switch |
| 18 | Notes' FOREGROUND typography pass edits rendered notes ~2.4s after our write (smart quotes/dashes/ellipsis) → echo hash missed → our answer classified as a user edit → untrack | `resetState` +2.2-2.4s after landing; no `fill echo observed`; ONLY on UI-open notes | typography-folded echo identity (`canonicalizeForEcho`) — splice/CAS stay byte-exact |
| 19 | Windows-port findings: unexpiring write ring swallowed identical re-types; no runaway backstop | `_` silently ignored on a re-typed command | 30s TTL on ring entries; same-text arm circuit breaker (typing cannot trip it) |
| 20 | A user edit ELSEWHERE mid-resolution aborted it, and freshMarkerIndex (correctly) never re-arms markers outside the changed region → the in-flight cue stranded until its own line was touched — "some prompts work, others don't" during active editing | `skipping — live text changed` ±few chars, then silence for that cue | interrupted-cue recovery: an armed cue's line surviving verbatim + arm <30s old → re-armed on edits elsewhere (`recovering interrupted cue`) |
| 21 | Detection hole: a command whose FINAL keystrokes land in the same mod-second as the poll's fetch is invisible to change detection forever (mod gates fetching) | healthy heartbeats, zero events, `_` visibly in the note | mod-ambiguity window: notes saved <2.5s ago re-fetch regardless of mod match |
| 22 | Id-swap third face: the plaintext FETCH errors when the temp id dies between enumeration and fetch — instant untrack destroyed the entry+ring before remap had a candidate | `untracked (fetch-error)` seconds after `switched {t…}` | fetch errors tolerated 3× before untracking |
| 23 | Interrupted-cue recovery matched the armed line byte-verbatim; Notes' typography pass rewrites the USER'S OWN typed line (straight→curly quotes) so the match missed and the cue froze on its frame | frozen frame char; `recovering…` absent | recovery compares lines under the same typography fold as echo identity |

All three were caught by the UI-grounded harness (PLAN.md 1.1) on its
FIRST run — each invisible to every scripted test, visible within
minutes of driving the real ⌘N + live-typing flow.
| 24 | Windows-integration review round 2 (their implementation notes): our echo ring's 30s re-type residual; breaker counted identical arms across unlimited time with a 10s user-hostile cooldown; stale frame echoes fed into the runtime's event stream | re-typed identical command within 30s ignored; breaker risk on repeated identical commands | underscore-count echo guard (ring-hit that ADDS a `_` vs the virtual mirror = user, never echo); breaker: 5s repeat window, 2s cooldown, typography-folded compare; "only the newest write may echo" — stale runtime echoes update tracked but never notify the runtime |
| 25 | "Animation freezes while the model thinks": Notes.app periodically wedges; ONE wedged osascript blocked the whole poll loop for the full 15s bridge timeout, and frames (same Apple Events channel) piled up unsent. Aggravated by self-inflicted pressure: a status() spawn EVERY 150ms tick, and the excluded-note warn writing 30+ synchronous log lines in one poll during a sync batch | `plaintext fetch failed (timeout)` + a 10-15s gap with only heartbeat/reload lines; `readMs`/`casMs` 5-8× baseline | bridge timeout 15s→6s; stress backoff (any timeout → 1s polls for 3s — hammering a wedged Notes extends the stall); status() cached 5s; excluded-note warn aggregated + rate-limited |
| 26 | Row 25's remedy ("restart Notes.app") was MANUAL — a wedge left blanks silently unresolved until the user diagnosed it from the log. Worse: a wedged `status()` timeout read as "Notes not running", parking the loop at the 10s paused cadence mid-wedge | `enumeration failed (timeout)` / `fill CAS failed (timeout)` ×2 within 60s; blanks sit unanswered; log otherwise quiet | wedge detector + AUTO-RESTART (user decision 2026-07-12): every bridge timeout feeds `WedgeState` via the bridge's central `onTimeout` hook; ≥2 timeouts in 60s = wedged → daemon drains the fill chain, quits Notes (AppleScript → SIGTERM → SIGKILL escalation), reopens with `open -g` (no focus steal), re-flushes any retained un-landed answer. Gates: 5-min cooldown (anti-thrash), 2s FSEvents quiescence (never mid-keystroke), Notes-already-quit skips (user quit wins). Restart check runs BEFORE the status gate so a wedged status() can't park the loop |

Model-quality issues (NOT pipeline; `cerebras/gemma-4-31b` was never
bench-validated for this pipeline):
- occasionally ANSWERS an imperative draft as a sentence completion
  instead of ceding to TransformBlank;
- occasionally rewrites content instead of following the instruction
  (observed: "Add emojis" → hostile parody of the poem, zero emojis);
- ~2× slower than the bench-validated `gpt-oss-120b`.

Environmental (not code):
- Notes.app can time out plaintext fetches when busy
  (`plaintext fetch failed (timeout)`) — the daemon rides it out
  (≤6s per stall + stress backoff since row 25).
- **Notes.app DEGRADATION is measurable in the phase logs**: when
  `readMs`/`casMs` run 5-8× baseline (1.5s reads vs ~180ms, 0.8-1.3s
  CAS vs ~160ms), Notes itself is wedged — no daemon setting can paint
  frames faster than its Apple Events queue. Remedies: restart
  Notes.app — **now automated** (row 26: ≥2 bridge timeouts in 60s →
  the daemon restarts Notes itself, gated by cooldown + FSEvents
  quiescence); keep Recently Deleted small (every entry enlarges the
  exclusion scan and sync churn). The animator is never the freeze:
  it generates frames at blank-loading-interval-ms regardless; frames
  freeze only when DELIVERY stalls.
- Prompts typed on ANOTHER DEVICE reach this daemon only after iCloud
  sync; a note created+edited+deleted remotely can arrive already dead.
- Every daemon restart re-seeds the baseline: a `_` typed DURING a
  restart window is deliberately inert until its note is edited again.

## 2. The scope decision (whole note vs paragraph)

TransformBlank rewrites its whole buffer. Other hosts' buffers are
ephemeral input boxes; a note is a persistent document, so cost and
reproduction fidelity degrade as a note accumulates content.
- Paragraph windowing: SHIPPED then RETIRED same day — real answers
  are multi-paragraph, so "type the command under the content" only
  reached back to the last blank line.
- Current semantics (user decision): whole-note scope. Keep notes
  per-task for best speed.
- Durable fix (planned): "full note in, patch out" — see PLAN.md.

## 3. Speed history (what got it fast, and the floors)

- FSEvents wake on the Notes group container → detection collapses to
  ~one enumeration; our own reads fire no events (no self-wake loop).
- Hot poll tier: 150ms for 5s after any content change; 500ms active;
  2s idle. AppleEvents reads see LIVE text (no autosave dependency).
- Arm-time body pre-warm → first animation frame ~190ms like the rest.
- Phase instrumentation on every fill
  (settleMs/queueMs/readMs/spliceMs/casMs/totalMs + echoMs) and a
  1/min poll heartbeat — "is it looking?" is never a guess.
- Physical floors: ~150ms per rendered frame (osascript CAS), ~0.3-0.9s
  keystroke→detection, ~6fps animation. The LLM leg is the only lever
  left (model choice; patch-out transform).

## 4. Quick triage

- **Anything weird / frozen / duplicated** → `integrations/apple-notes/bin/oc-notes-reset`
  — teardown, relaunch, VERIFIED singleton in one command.
- **A `_` does nothing, log silent** → grep `edit detected in a Recently-Deleted note`
  (typing in a deleted note) and check the baseline line (cue typed
  during a daemon restart window is inert until its note is edited).
- **A `_` does nothing, healthy heartbeats** → ledger 21 class; check
  `poll heartbeat` cadence and whether the note's mod-second matches
  the last fetch.
- **Answer landed then vanished/untracked** → ledger 18 class; grep
  `fill echo observed` (absent = echo hash miss) and `untracked`.
- **Mangled/mixed-language output** → the model (ledger's model
  section), not the pipeline — reproduce via the transform bench before
  blaming the daemon.
- **`circuit breaker TRIPPED`** → a genuine same-text loop; the log
  names the note; 2s self-heal, then diagnose from the preceding arms.
- **`Notes.app wedged … restarting it`** → row 26 fired: the daemon
  confirmed a wedge and auto-restarted Notes. One line is the system
  working; repeated lines an hour apart mean Notes keeps wedging —
  check Recently Deleted size and account sync health.
