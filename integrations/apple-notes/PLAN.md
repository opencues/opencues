# PLAN.md — the version that is (1) reliable and (2) fast

Written 2026-07-09 from the full two-day arc (see `notes.md` for every
root cause). Two goals, nothing else. Each item says what it buys and
what it costs.

## Phase 1 — Lock in reliability (the meta-fix first)

### 1.1 UI-grounded e2e harness  ← THE item that ends the fix/break loop
Every regression that survived "verified working" hid behind a
verification blind spot (notes.md § 0): scripted notes never have
temporary ids, are never rendered in the UI, and never type at human
cadence. Build a harness that drives the REAL flow:
- computer-use (or AXUIElement) automation: activate Notes, ⌘N, type a
  command with per-keystroke delays, leave the note OPEN and frontmost,
  wait, assert the note's final text + zero error signatures in the log
  (`skipping — live`, `untracked`, `circuit breaker`, `fill dropped`
  without a matching retry-success).
- Scenario set (one per ledger row that had a user-visible symptom):
  fresh-note command; second command in the same note; typing during
  animation; same-second trailing keystroke; quote/emoji content
  (typography pass); re-typed identical command; two-cue note.
- Definition of done for ANY future change: harness green, plus one
  human pass. No AppleScript-only verification claims, ever again.
Cost: ~half a day with computer-use. Buys: the loop actually ends.

### 1.2 One-hour soak
Daemon + harness scenarios on repeat for an hour while the log is
watched for: breaker trips, unexplained untracks, retry exhaustion,
fetch timeouts, heartbeat gaps. Any hit = a ledger row before any new
feature work. Cost: passive. Buys: confidence the guards compose.

### 1.3 Close the two observability gaps
- Log when enumeration sees a mod change in an EXCLUDED
  (Recently-Deleted) note — today an edit there is invisible silence.
- Log baseline-seeding count of notes containing a live `_` at daemon
  start ("N pre-existing cues are inert until edited") so
  restart-window dead prompts are self-explaining.
Cost: minutes. Buys: the next "it does nothing" diagnoses itself.

## Phase 2 — Fast (the two real levers)

### 2.1 Model: blanks/cues buckets → `gpt-oss-120b` (RECOMMENDED)
Everything else is at its physical floor. gemma-4-31b is ~2× slower
per call at its reasoning levels AND is the source of every
instruction-following failure in the ledger's model section — it was
never bench-validated for this pipeline; gpt-oss-120b is. One config
line, reversible, hot-reloads. This is the single biggest speed AND
reliability win available today. (User decision — declined twice;
re-recommended with the full evidence now on the table.)

### 2.2 Transform "full note in, patch out" (core work, 2-3 days)
TransformBlank currently reproduces its whole buffer per command. On a
persistent document that means cost grows with note length and the
model must reproduce everything verbatim (the fidelity failures in the
ledger). Change the FUSED contract to emit only the changed region
(the resolver's bounded-span splice path still exists for this);
re-run `tests/benchmarks/transform-blank/` per repo discipline.
Buys: constant-cost commands in long-lived notes on EVERY host, and
eliminates the whole-buffer-reproduction failure class permanently.
This supersedes the retired paragraph-window idea without its
convention.

### 2.3 Micro-levers already done (kept for the record)
FSEvents wake, 150ms hot tier, body pre-warm, serialized CAS at ~6fps.
Remaining floor is Apple's: ~150ms per osascript round-trip, 1-second
modificationDate, no key events.

## Phase 3 — Sequence

1. 1.3 observability gaps (minutes) → restart daemon once, then STOP
   restarting it under the user.
2. 1.1 harness (half day) → run full scenario set against current HEAD.
3. Fix anything the harness catches (ledger discipline).
4. 1.2 soak.
5. 2.1 model switch (one line, if approved) → re-run harness.
6. 2.2 patch-out transform (2-3 days, bench-gated) → harness + benches.
7. Tag `apple-notes-v1-reliable`.

## What we are NOT doing (decided)

- Paragraph windowing (retired — breaks multi-paragraph content ops).
- Whole-note "memory" theories — there is no memory; see
  ARCHITECTURE.md § 1.
- Speculative guards without a ledger row: every new protection must
  cite a reproduced failure, its log signature, and carry a test.
