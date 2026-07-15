# Undo / Redo — architecture reference

Canonical reference for the `undo _` / `redo _` feature: the
UndoJournal transaction log, the recording taps, the ACTION verdict on
the config-intent classifier, and the UndoApplier's
exact-match-or-refuse policy. Read this before touching
`packages/opencues-runtime/src/state/undo-journal.ts`,
`packages/opencues-runtime/src/modules/undo.ts`, the resolver's ACTION
branch, or any recording tap.

User-facing summary: [docs/features/undo.md](../features/undo.md).

---

## Routing — a fourth verdict kind, not a keyword blank

`undo` is deliberately NOT a keyword blank (that shape is
English-anchored — the same reason the `with <model>` override was
retired). It rides the config-intent classifier
(`packages/opencues-core/src/sources/config-intent-source.ts`), which
already owns language-invariant command handling:

- `ActionVerdict { kind: 'action'; action: 'undo'|'redo'; count }` is
  the fourth member of `ConfigIntentVerdict` (SETTING / PROVIDER /
  ACTION / NONE). The prompt's `INTENT C — ACTION` section is **always
  present** — the system prompt is one byte-stable string so cerebras
  prefix caching holds (docs/architecture/cerebras.md). Gating is
  **verdict-level**: `allowConfigVerdicts` (`fluid-config-mode`) and
  `allowActionVerdicts` (`undo-mode`) each decide post-classification
  whether their verdict kinds are acted on; a disabled kind cedes
  exactly like NONE. `build-sources.ts` constructs the source when
  either flag is on.
- **Action verdicts carry no emit-time side effect.** Settings verdicts
  apply their scalar inside `getCues`; an action verdict only emits
  `metadata.undoAction = { action, count }` plus the summon-phrase wipe
  span (the existing `resolveCommandSpanStart` regex-floor + SUMMON
  machinery — unchanged, span is a pure function of buffer text). The
  RUNTIME applies it: core classifies, runtime owns the journal.
- The likely-intent prefilter (`LIKELY_INTENT_KEYWORDS`) carries a
  curated multilingual undo/redo alias list (~22 languages). It is a
  RECALL prefilter only — the LLM decides; a miss means undo doesn't
  fire in that language, and extending coverage is one alias line.
  `hasLikelyIntent` substring-matches non-ASCII tokens because JS `\b`
  is `\w`-based and never matches CJK/Cyrillic/Thai.
- `validateAgainstRegistry` rejects anything but
  `action ∈ {undo, redo}` + integer `count ≥ 1`. Count CLAMPING to the
  journal's depth is the applier's job.

Prompt-edit discipline: any change to the ACTION section (or anything
else in `SYSTEM_PROMPT`) re-runs
`tests/benchmarks/fluid-config/prod.ts` — baseline first, same session,
`--parallel 4` (see EXPERIMENTS.md § v2.2 for the certification run:
settings precision 100% unchanged, undo recall 93.3%).

## The journal — session-scoped transaction log

`packages/opencues-runtime/src/state/undo-journal.ts`. Pure state
(no adapter, no IO); constructed in `buildSharedRuntime` (and inline in
the CC band, which doesn't use it — keep the two in lockstep), threaded
into every mutating module.

**Transactions** (cap 50, drop-oldest), each holding typed entries:

| Entry kind | Records | Inverted by |
|---|---|---|
| `buffer-splice` | `beforeSlice` / `afterSlice` (diffSplice-trimmed) + `bufferEpoch` | unique-match relocation |
| `scalar-write` | key + prev/new value | `applyScalarAndPersist` (reload-suppression arms) |
| `os-set` | blankName (+scriptPath) + prev/new value | verify-`get` then `set` via `invokeOrSpawnBlank` |
| `file-write` | inverse + forward blank ops ({keyword, args}) | replayed through the blank → its validator |
| `external` | a label | never — always reported as skipped (Tier 4) |

Key invariants:

- **diffSplice, no span plumbing.** Every buffer entry is derived by
  diffing pre/post text at the tap site — common prefix/suffix trimmed,
  pure deletions widened by one char of context so the relocation
  anchor is never empty. Whole-buffer merges (transform fused,
  agent-rewrite) shrink to their actual hunk. Nothing in the journal
  needs shiftAfter-style offset maintenance.
- **Epochs, not wipes.** `resetSharedBufferState` calls
  `noteBufferReset()` — epoch++ only. The stacks survive buffer/submit
  boundaries (a settings or volume change from the previous message
  stays undoable); buffer entries from an older epoch are skipped at
  apply time (`stale-epoch`) while sibling scalar/os/file entries still
  revert. The journal is deliberately NOT in the reset wipe set.
- **Coalescing.** Cycling paths pass a `coalesceKey`
  (`blank-step:<blank>:<index>`, `sel-sat:<index>`, …); a record whose
  key matches the top undo transaction merges — first before-state
  kept, after-state overwritten — so a volume burst reverts to its
  origin with one undo. Any record (coalesced or not) clears the redo
  stack.
- **Reentrancy.** The applier runs inside `journal.runApply()`;
  `record()` no-ops for the duration, so an undo's own writes are never
  journaled (redo is served by the two stacks).
- **Two-phase recording** (`begin()`/`commit()`) exists for
  config-intent: scalar writes land at emit time (inside core's
  `getCues`, via the resolver's wrapped `applyOpencuesScalar`), the
  buffer entry only at resolver-apply time — and a race-bailed splice
  still commits scalar-only, because the scalar really did change.

**Recording taps** are explicit `journal.record()` calls at each
mutation site (the event bus was rejected: `blank.substituted`
truncates output to 200 chars and carries no offsets). Sites: resolver
fluid/transform/config-intent substitutes, BlankFill commits (static /
weave / satellite, plus `file-write` from `ProcessResult.writeInverse`
and os-set from the shaped set/step's get-before-set), all five cycling
paths, AgentRewrite merges. **Adding a new mutating surface means
adding a tap** — an untapped surface is invisible to undo.

The sentinel/note `file-write` channel deserves a note: the blanks
stash a one-shot inverse (`consumeLastWriteInverse()`), and
`createBlankInvoke` attaches it to the `ProcessResult` — so the wiring
needs zero integration-bootstrap changes, and replaying the inverse op
goes back through `validateSentinelWrite`/`validateNoteWrite` by
construction (audit row #24 stays intact).

## The applier — exact-match-or-refuse

`packages/opencues-runtime/src/modules/undo.ts` (`UndoApplier`),
invoked from the resolver's ACTION branch. Policy, in order of
importance:

1. **Never guess, never clobber** (the no-logical-landmines rule). A
   buffer slice applies only on a UNIQUE `indexOf` match of its
   relocation anchor; a scalar only if it still holds what the
   transaction wrote; an OS value only after a verify-`get` matches.
   Everything else → a skipped entry with a reason
   (`not-found` / `ambiguous` / `stale-epoch` / `value-drifted` /
   `no-prior-value` / `external` / `exec-failed`).
2. **Partial failure is reported, never masked.** Skips land in the
   `UndoApplyReport`, surfaced via the statusline `undo` block
   (TTL'd by `journal.recentApplyReport`) and the `undo.applied` event.
3. **Consumed transactions pop regardless of skips** — a dead
   transaction must not wedge the stack so `undo _` re-hits it forever.
4. **Never throws.**

The resolver ACTION branch sequences: race guards (same pair as the
settings branch) → command span spliced out (whitespace-swallowed) →
`applier.apply()` → span-state cleanup (`dynDefs`/`spanFillState`/
`selectorSatelliteState`/`hlState` — reverted splices invalidate their
offsets; deliberately NOT `resetSharedBufferState`, which would bump
the epoch and stale the remaining journal) → **one `pushText`** (one
host history entry). Nothing-applied → an inline
`[OpenCues: nothing to undo]` note with a `clearOnEdit` span.

## What's NOT in scope (v1)

- **Tier 4 — user-pack external effects.** A pack's script/JS blank
  fetched or executed; the runtime cannot know its inverse, and letting
  packs declare one is a new exec-capability surface (packs never
  self-grant — the capability model). The buffer fill reverts; the
  effect is journaled as an `external` entry and always reported. A
  spec-level `inverse:` declaration gated by the same trust list is a
  possible future, deliberately not built.
- **Agent-task lifecycle** (`agentically X _` arm/stop) — session
  state, not a buffer change; "undo an arm" is ambiguous.
- **clearOnEdit wipes** — user-driven (they backspaced); not journaled.
- **Host-native undo** (Ctrl+Z) — orthogonal; the host owns it. The
  runtime's one-write-per-apply discipline keeps host history sane.
- **Cross-restart persistence** — the journal is in-memory. Restoring
  state you can no longer verify is how landmines happen.
- **Kata buffers** — the resolver is modally suppressed there anyway.

## Tests pinning this behaviour

| Surface | Test |
|---|---|
| Journal semantics (coalescing, epochs, two-phase, reentrancy, cap) | `src/state/undo-journal.test.ts` |
| Classifier parse/validate/gating + CJK gate fix | `packages/opencues-core/src/sources/config-intent-source.test.ts` |
| Source construction under flag combinations | `packages/opencues-core/src/sources/build-sources.test.ts` |
| Runtime journeys (relocation, refusal honesty, burst revert, drift skips, race bail, redo) | `src/modules/undo.scenarios.test.ts` |
| LLM classification quality (multilingual, counts, negatives) | `tests/benchmarks/fluid-config/prod.ts` + `cases-undo.ts` |

## Related architecture docs

- [fluid-config.md](fluid-config.md) — the classifier this rides on
- [blank-sources.md](blank-sources.md) — splice-vs-merge; diffSplice is
  the journal-side analogue of "never trust a claimed span"
- [config-loader-reload-race.md](config-loader-reload-race.md) — why
  scalar inversions go through `applyScalarAndPersist`
- [security-audit.md](security-audit.md) — row #24 (IDENTITY.md
  validator chokepoint; the file-write inverse preserves it)
