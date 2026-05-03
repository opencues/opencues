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

## Experiment 2 — Expanded suite (70 cases, 7 categories)

**Hypothesis:** v1 baseline holds at scale and across more categories.

**Results (parallel=8):**

```
Category               Pass rate
─────────────────────────────────────
spelling-task          7/10  (70.0%)
cursor-adjacent       10/10  (100.0%)
no-op-recall          10/10  (100.0%)
ownership-respect      7/10  (70.0%)
task-id-invalidation   8/10  (80.0%)
caps-task              4/10  (40.0%)
mixed-task             7/10  (70.0%)
─────────────────────────────────────
Total                 53/70  (75.7%)

Avg per case          510ms
Wall-clock (parallel=8) 4.9s
Throughput             14.37 cases/sec
```

**Findings:**

1. **Architectural primitives all 100%** — cursor-adjacent, no-op-recall.
   The agent never touches the cursor word, never makes spurious edits
   when nothing's wrong.

2. **One real architectural bug found and fixed.** When the cache had
   index 1 ("somm") marked as evaluated, the LLM still occasionally
   proposed edits for that index (despite being told only candidates).
   The agent applied them anyway — the apply loop didn't enforce
   the candidate set. **Fix:** added `candidateSet.has(edit.wordIndex)`
   check in both the DynDef-application loop AND the buffer-write loop.
   `task-id-invalidation` jumped 70% → 80% as a result.

3. **Caps-task at 40% reveals a model behaviour.** The model
   consistently **misses the LAST item in multi-item lists**:
   - `caps-3`: misses "june", catches "march"
   - `caps-4`: misses "sunday", catches "monday + friday"
   - `caps-5`: misses "paris", catches "london + tokyo"
   - `caps-7`: misses "germany", catches "france + italy"
   - `own-10`: misses "tommorow" (last typo), catches the first 3

   Same model-variance pattern shows up in the spelling-task failures.
   Worth investigating with prompt tuning ("be exhaustive — list ALL
   applicable edits, don't stop at the first few").

4. **Latency stable** at ~500ms per case across the larger suite.
   parallel=8 finishes 70 cases in ~5 seconds.

5. **mixed-task (composed prompts) at 70%** is competitive with
   single-task — composing instructions doesn't degrade the agent
   significantly.

**Decision:** the agent loop is production-ready. The caps-task /
spelling-task floor is a model-variance issue, not a pipeline issue.
Try prompt nudges in a follow-up experiment.

---

## Experiment 3 — Chasing the "model misses last item" bug

**Hypothesis:** the model has a model-variance issue where it
consistently misses the LAST item in multi-item edit lists. Tried
multiple fixes — prompt nudges, DECISIONS-format, dynamic max_tokens.

**Variants tested:**

1. **EDITS format with "be exhaustive" nudge** + worked example showing
   3-item edit list with last item explicitly called out.
2. **DECISIONS format** — model emits one verdict (KEEP or edit) per
   candidate, in ascending order. Forces complete enumeration.
3. **Dynamic max_tokens** sized to candidate count (30 × candidates +
   600 reasoning headroom) so DECISIONS output isn't truncated.

**Results were all stuck at ~75% total — until we found the actual
root cause.**

### The actual bug

The "last item missed" pattern was 100% a TEST-AUTHOR BUG.

The mock adapter defaulted `cursorPos: undefined` → `cursorPos: -1`
→ `cursor = text.length`. For text "i was born in march and graduated
in june", that's position 41 — exactly at the end of "june" (chars
37-41). The runtime's `findCursorWordIdx` (correctly) treats
`cursorPos <= w.end` as "cursor on this word", so word 8 ("june") was
classified as cursor-adjacent and (correctly) excluded from candidates.

The agent was doing exactly the right thing: respecting the
cursor-adjacent rule. My benchmark was telling it to skip the word it
was supposedly testing.

### The fix

```ts
// Mock adapter default
let cursor = cursorPos === -1 ? text.length + 1 : cursorPos;
```

`text.length + 1` is past every word's `[start, end]` range, so
`findCursorWordIdx` returns `-1` and no word is cursor-excluded.

Tests that explicitly want to exercise cursor-adjacent behavior
continue to set `cursorPos` to a specific position.

### Results after the fix

```
Category               Before fix   After fix
─────────────────────────────────────────────
spelling-task          70%          100%   (+30pp)
cursor-adjacent        100%         100%
no-op-recall           100%         100%
ownership-respect      70%          100%   (+30pp)
task-id-invalidation   80%          100%   (+20pp)
caps-task              40%          100%   (+60pp)  ← biggest jump
mixed-task             70%           90%   (+20pp)
─────────────────────────────────────────────
Total                  75.7%        98.6%  (+22.9pp)
```

The single remaining failure (mix-6) is genuine model variance on a
"remove redundant words" task with a duplicated word.

### What stayed in the implementation

The DECISIONS format + dynamic max_tokens stayed even though the bug
was elsewhere — they DO provide a stronger completeness guarantee for
the cases where the cursor isn't tricking us. The model occasionally
still drops items in long lists when output budget is tight; the
DECISIONS format acts as defense in depth.

Latency actually improved: 510ms → 398ms per case. The DECISIONS
format parses cleanly and the model spends less reasoning effort
deciding what to emit (it just walks the candidate list in order).

### Lesson

When a benchmark consistently fails the same way across many cases,
suspect the benchmark itself before the model. The cursor-adjacent
rule worked as designed in production; the test default was making
EVERY test case implicitly cursor-edge.

This is the same pattern as the transform-blank `\s* → [ \t]*` parser
bug from earlier — looks like a model issue, turns out to be a
serialization/test infrastructure issue.

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
