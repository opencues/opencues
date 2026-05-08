# Agent Task — Implementation Reference

> **Status: SHIPPED.** As of May 2026 the runtime ships a single
> implementation: `AgentRewrite`. A cadence-driven module that emits
> the full rewritten buffer per round and three-way-merges the result
> against the live buffer, so user typing during the call is never
> clobbered. See "Architecture" below for the design and the
> invariants the merge layer enforces.
>
> An earlier per-keystroke `AgentLoop` + per-edit `Judge` lived in
> tree until May 2026; both were retired once `AgentRewrite` proved
> the merge layer made the per-edit guards structurally unnecessary.
> Git history holds the legacy if you need to consult it.

## Architecture

`AgentRewrite` is a single, debounce-driven module. While a task is
armed, every text-change event reschedules a tick; after the user
pauses for `agent-debounce-ms` (default 1000ms, OPENCUES.md-tunable):

```
1. Snapshot the live buffer (A) and the active task prompt.
2. ONE LLM call:  "given DOC and TASK, return the rewritten DOC."
   The model emits the entire rewritten buffer (B), nothing else.
3. Three-way merge:
     - diff A → B  (LLM's hunks: every region the LLM wants to change)
     - diff A → C  (user hunks; C is the live buffer at apply time)
     - drop any LLM hunk that overlaps a user hunk in A's char frame
     - splice surviving LLM hunks into C with cursor translation
4. Place a DynDef per applied hunk (Down-arrow reverts it).
```

The diff is a small word-level LCS implemented inline in
`word-diff.ts` — no `diff` npm dependency. Whitespace handling
mirrors transform-blank's existing convention (consume one adjacent
space on pure deletion; pad on pure insertion between word-chars).

### Why this shape

Transform-blank's three-pass EXTRACT/APPLY/VERIFY pattern works well
because each invocation is structurally small: one LLM call, parsed
once, applied once. AgentRewrite picks the same primitive — one
holistic rewrite per round, parsed once, merged once.

The merge layer is a textbook three-way merge — well-understood, no
LLM-specific edge cases. Whatever the model emits, the merge either
applies it cleanly or drops it cleanly. Failure modes collapse from
"infinite per-edit corruption shapes" to "either it lands or it
doesn't."

### What the merge layer enforces structurally

Earlier per-edit guard architectures defended against specific LLM
failure modes — sentence-fingerprint drift, anti-oscillation, shape
classification, edge-duplication. All four classes are impossible
under AgentRewrite by construction:

| Failure mode             | Why it can't form under AgentRewrite                              |
|--------------------------|-------------------------------------------------------------------|
| Sentence-fingerprint drift | Three-way merge drops any LLM hunk that overlaps a user hunk. |
| Anti-oscillation         | Each round re-reads from current state — no past edits to invert. |
| Shape (SHRINK/ADDITION)  | One coherent rewrite per round; the LLM can't stack micro-edits.  |
| Edge-duplication         | The rewrite IS the final text; nothing to compose on apply.       |

Production logs after the May 2026 switchover show **zero** of each
class across multi-hour sessions.

---

## Code surface

| Module                       | Lines | Role                                                          |
|------------------------------|-------|---------------------------------------------------------------|
| `word-diff.ts`               | ~150  | Pure: `wordDiff`, `applyHunks`, `translateAToC`, `threeWayMerge` |
| `agent-rewrite.ts`           | ~250  | Timer + LLM call + merge + DynDef placement + cursor          |
| `word-diff.test.ts`          | ~150  | 27 unit tests — every diff edge case                          |
| `word-diff.scenarios.test.ts`| ~150  | 13 live-typing scenario tests                                 |
| `agent-rewrite.test.ts`      | ~250  | 33 integration tests — full pipeline                          |

`AgentTaskState` (in `state/agent-task.ts`) is unchanged: holds the
task prompt + taskId + per-word evaluation cache + edit-signature
ring (the latter two no longer carry correctness load, but the cache
prevents the agent from churning when nothing's changed).

`Resolver` still owns the TASK_* trigger keywords (`agentically`, `add
task`, `stop task`, `current task`). `transform-blank-source.ts`
EXTRACT routes those triggers to the resolver, which arms / appends /
clears / reads the task state.

---

## Cadence

**Event-driven debounce.** Each user-source `onTextChange` resets a
debounce timer; the tick fires only after the user pauses for
`agent-debounce-ms` (default 1000ms, configurable in OPENCUES.md).
Misparses or non-positive values fall back to 1000ms via
`getCadenceMs()`. Idle = no ticks.

A skip-on-stable guard short-circuits when `(snapshot, task, cursor)`
matches the last applied state — no LLM call when there's nothing to
do. A 64-entry LRU cache covers backspace+retype as well: identical
input returns cached output, no network round-trip.

If the LLM call takes longer than the next tick's debounce, the next
tick sees `_running === true` and bails. Only one LLM call is in
flight at a time.

Earlier designs used `setInterval(..., 1500ms)` — pure cadence, no
debounce. Replaced because idle ticks burned LLM calls when the user
wasn't typing. The event-driven debounce + skip-on-stable + cache is
strictly cheaper and not noticeably less responsive.

---

## Cursor translation

For each applied LLM hunk, if the hunk's translated end position is
≤ cursor-before, the cursor shifts by the hunk's length delta.
Insertions at the cursor's position don't shift it (the user's caret
stays before the inserted content).

The translation is clamped to `[0, newText.length]` defensively —
out-of-bounds cursors land at 0 in OpenCode (host clamps differently),
which would surface as "cursor jumped to start." The clamp is
belt-and-braces; production logs show zero clamp events under
AgentRewrite.

---

## Stop semantics

`stop task _` clears `AgentTaskState`. The agent stops ticking.
**Existing DynDefs from previous rounds stay in the buffer** — the
user can still cycle Down on any to revert, or leave them. This
mirrors transform-blank: edits are user-visible and user-reversible,
not magically undone when the task ends.

---

## Drift, race, and edge cases

- **Buffer changed mid-LLM-call**: the merge handles it. LLM hunks
  that overlap user hunks drop; other LLM hunks land at translated
  positions in C.
- **Task changed mid-round** (user issued a fresh ARM/ADD/STOP while
  LLM was thinking): `tick()` checks `state.prompt` against
  `taskAtSnapshot` after the LLM returns; on mismatch, the rewrite
  is discarded. Next tick reruns under the new prompt.
- **LLM error / empty / malformed**: tick swallows, buffer
  untouched. Next tick retries.
- **Empty buffer**: tick is a no-op (no LLM call).

All four cases are pinned by integration tests in
`agent-rewrite.test.ts`.

---

## Trigger keywords

The literal words `agentically`, `add task`, `stop task`, `current
task` need to remain recognisable so the user can issue follow-up
commands. The legacy AgentLoop had explicit "trigger-word
protection" filters. AgentRewrite doesn't need them: a holistic
rewrite under `correct spelling` etc. wouldn't translate
`agentically` to a non-trigger word — and even if it did, the user's
NEXT typed `agentically <X> _` regenerates the keyword on the fly
because EXTRACT operates on the user's typed prefix, not the buffer's
mutated tail.

`TASK_TRIGGER_KEYWORDS` is exported from `resolver.ts` as the
canonical map.

---

## Test coverage

The full sweep is `npm test` from `packages/opencues-runtime/`.
Highlights:

- **Diff core** — 27 unit tests on every word-LCS edge case
  (substitutions, deletions, insertions, ranges, paragraph breaks,
  case sensitivity, ordering invariants).
- **Live-typing scenarios** — 13 tests driving realistic
  interleavings: append-during-call, fix-same-word-differently,
  delete-mid-call, identical-fix-idempotent, cross-paragraph,
  insertion-conflicts.
- **AgentRewrite integration** — 33 tests covering basic flow, live
  typing, task changes mid-round, LLM failure modes, DynDefs/cycling
  state, cursor translation, concurrency.

Together they pin the property the architecture provides:
**user-typed content is never clobbered**.
