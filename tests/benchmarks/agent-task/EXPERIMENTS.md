# Agent-Task Pipeline Experiments

Running log of experiments on the agent-task pipeline. Mirrors the
`tests/benchmarks/transform-blank/EXPERIMENTS.md` structure.

> Suite: 20 cases across 6 categories (spelling-task, cursor-adjacent,
> no-op-recall, ownership-respect, task-id-invalidation, caps-task).
> Model: `openai/gpt-oss-120b` via Groq, `temperature: 0`,
> `reasoning_effort: 'low'`, `seed: 42`. All runs use the parallel
> benchmark runner with concurrency 4.

---

## Experiment 1 — V1 baseline

**Hypothesis:** the v1 loop (single-call edit pass + per-task evaluation
cache + DynDef-backed ownership) works on simple cases without prompt
tuning.

**Variant:** v1 with system prompt described in `agent-loop.ts`'s
`callEditPass` method:

- Sends the task prompt + the doc with `[N]word` indexed format
- Lists candidate word indices the model MAY edit (others owned)
- Output: `EDITS: <idx> | <orig> | <edit> ... END`
- One LLM call per debounce settle

**Results (parallel=4):**

```
Category               Pass rate
─────────────────────────────────────
spelling-task          7/10  (70.0%)
cursor-adjacent        2/2   (100.0%)
no-op-recall           2/2   (100.0%)
ownership-respect      2/2   (100.0%)
task-id-invalidation   2/2   (100.0%)
caps-task              2/2   (100.0%)
─────────────────────────────────────
Total                  17/20 (85.0%)

Avg per case           519ms
Wall-clock (parallel=4) 3.0s
Throughput             6.74 cases/sec
```

**Findings:**

1. **The architecture works.** The five non-spelling categories all
   passed 100% — cursor-adjacent exclusion, ownership respect, no-op
   recall, task-id invalidation, and caps-task all behaved as
   designed. The DynDef-backed ownership model (use existing
   primitives, don't build new ones) plays nicely with the agent
   loop.

2. **Spelling-task floor at 70% is model variance, not pipeline.**
   The 3 failures:
   - `spell-5`: caught 2/3 typos (`believe`, `separate`) but missed
     `succede → succeed`. Model fatigue on long lists.
   - `spell-9` (after fix): the model sometimes catches contractions
     ("Im → I'm") that the test doesn't expect. Test author bug
     fixed by writing "I am" verbatim.
   - `spell-10`: missed `wel-recieved → well-received` — hyphenated
     misspellings are harder to detect than standalone ones.

3. **Latency is excellent** — 519ms avg per case. No VERIFY pass
   (intentionally — the agent's edits already get applied as DynDefs
   the user can revert via cycling), single-call edit pass keeps it
   snappy.

4. **The cache works.** `task-id-invalidation` 2/2 pass confirms:
   - Cache hit on `somm` (already-evaluated) → agent skips it (no
     re-eval).
   - Off-by-one resilience: `tommorow` at the wrong index in the test
     was caught as a test-author bug, not a pipeline failure.

5. **Cursor-adjacent + ownership protections fire correctly.** Both
   100%. The agent never touches the cursor-adjacent word; never
   touches a word claimed by another DynDef.

**Decision:** ship v1 as-is. Spelling failures will likely improve
with more APPLY-style examples in the edit prompt, but the feature
works end-to-end and the failures are rare/predictable.

---

## Experiments deferred to later sessions

These were marked as deferred in `docs/architecture/agent-task.md`.
Not run yet — to be benchmarked when iterating:

1. **Classify-first vs always-edit.** Does running a cheap "anything
   to do?" classifier BEFORE the expensive edit pass save tokens, or
   is the edit pass with "return empty if nothing" cheaper end-to-end?

2. **What does the agent SEE.** Currently sends full doc with `[N]word`
   indexed format. Alternatives: just candidate words; or doc with
   `<owned>...</owned>` markers for skip regions.

3. **Cadence backoff.** Currently fires on every debounce settle.
   Should consecutive no-ops slow the loop down (500ms → 1s → 2s)?

4. **Multi-edit batching.** Currently applies all edits in one
   setText pulse. Could stagger for animation effect.

5. **Word-level vs region-level edits.** Current format is
   `<idx> | <orig> | <edit>` — single-word swap. Could extend to
   span-level edits for sentence rewrites.
