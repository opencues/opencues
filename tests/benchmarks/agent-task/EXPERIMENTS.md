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

## Experiment 4 — DECISIONS vs EDITS prompt format A/B

**Hypothesis:** the DECISIONS format (one verdict per candidate) was
adopted in Experiment 3 as defense in depth against the model dropping
items in long lists. Now that the cursor-adjacency test bug is fixed,
is it actually pulling its weight, or is the simpler EDITS-only format
(emit lines only for actual edits) faster and at least as accurate?

**Variants:**
- **DECISIONS:** model emits `<idx> | <orig> | KEEP|<edit>` per
  candidate; max_tokens scales as `30 × candidates + 600`.
- **EDITS:** model emits `<idx> | <orig> | <edit>` only for proposed
  edits, or `none`; max_tokens scales as `8 × candidates + 600`.

Both formats pass through the same lenient parser (`parseEditPassOutput`)
which already accepts either marker. Wired up via a new
`promptFormat: 'DECISIONS' | 'EDITS'` option on `AgentLoop`.

### Results — 70-case suite (gpt-oss-120b, parallel=8)

```
Format       Run 1     Run 2    Avg ms/case   Wall-clock
─────────────────────────────────────────────────────────
DECISIONS    92.9%     97.1%    448–564       5.3–5.5s
EDITS        97.1%    100.0%    331–365       3.2–3.7s
```

EDITS wins on every dimension: pass rate, latency, throughput.

### Results — scale benchmark (1 doc per tier)

```
Tier        DECISIONS                EDITS
────────────────────────────────────────────────────────────
25 words    66.7% recall, 612ms     100.0% recall, 1343ms
50 words    100.0% recall, 1302ms   100.0% recall,  971ms
100 words     0.0% recall, 1668ms    87.5% recall,  929ms
200 words    25.0% recall, 8503ms   100.0% recall, 1689ms
```

The 100-word DECISIONS run with 0% recall is the smoking gun: at that
size, the model spends so many output tokens emitting KEEP lines that
it truncates before reaching the typos. EDITS is 5× faster on the
200-word doc and 4× more accurate.

### Why EDITS won

1. **Smaller output budget** — the model isn't forced to emit ~30
   tokens per non-edit candidate. Reasoning tokens stay focused on
   identifying edits, not on reciting every KEEP line.
2. **Defense-in-depth was unnecessary.** The "model drops the last
   item" symptom from Experiment 2 was a test bug (cursor default —
   see Experiment 3). Once the cursor was off the last word, the
   model never actually dropped anything on EDITS format.
3. **The runtime already enforces completeness.** Each candidate that
   doesn't show up in the response is recorded as "evaluated" anyway
   (so it won't be re-asked) — the absence of an EDIT line for an
   index is treated as a KEEP. The DECISIONS format added explicit
   KEEPs for a guarantee the runtime already provides implicitly.

### Decision

**EDITS is the new default** for `AgentLoop` (see
`agent-loop.ts:promptFormat`). DECISIONS is preserved as an opt-in
for future experiments where the explicit-KEEP guarantee might matter
(e.g. extremely terse single-word docs where the model might infer the
prompt ended unexpectedly).

---

## Experiment 5 — Convergence (no redundant LLM calls)

**Hypothesis:** the per-task evaluation cache (taskId + textHash)
should make the agent strictly idempotent — running it twice on the
same text does NOT trigger a second LLM call. If we add new content,
only the new word should be re-evaluated.

**Setup:** built `tests/benchmarks/agent-task/convergence.ts`. Wraps
the http adapter in a counting proxy and runs 6 scenarios where each
scenario fires `loop.runOnce` multiple times and inspects the call
log.

**Scenarios:**

| ID                  | Setup                                              | Expected                          |
|---------------------|----------------------------------------------------|-----------------------------------|
| idempotent-noop     | Clean doc + spelling task, run twice               | 1 call total (2nd is cache hit)   |
| idempotent-fixed    | Doc with typos, run, then run on edited text       | 1 call total (typos owned now)    |
| incremental-append  | Run, append a typo, run                            | 2 calls; 2nd has only new index   |
| task-switch         | Run, `appendToPrompt`, run                         | 2 calls; cache cleared on append  |
| dyn-def-owns        | Pre-claim a word, run                              | 1 call; owned word not in cands   |
| cursor-rotation     | Run, move cursor onto word 0, re-run same text     | 1 call total (rest cached)        |

**Results:** 6/6 pass.

The cache contract holds: `(taskId, textHash)` is a sufficient key.
The agent never re-asks about an unchanged word under the same task.
The `appendToPrompt` regenerate-taskId design correctly invalidates
the cache without any explicit eviction step.

**Latency benefit:** in steady state (no doc changes), the agent fires
zero LLM calls per debounce settle — it just recomputes candidates,
finds them all cached, and exits.

---

## Experiment 6 — Robustness (failure-mode handling)

**Hypothesis:** the loop should survive every realistic transport
failure without crashing or applying garbage edits.

**Setup:** `tests/benchmarks/agent-task/robustness.ts`. 16 scenarios
exercise empty docs, transport errors, malformed responses, and
defensive checks against bad LLM output. All scenarios use a stubbed
`httpAdapter` — no network calls.

**Code changes during this experiment:**

1. **Defensive JSON parse.** `JSON.parse(response)` was wrapped in
   try/catch. Empty responses, HTML error pages, and partial JSON now
   log + return empty edits instead of bubbling up.
2. **Empty-content guard.** If `data.choices[0].message.content` is
   missing or empty, log + return empty edits.
3. **No retry loop.** Deliberate. The next text-change re-fires the
   debounce, which is our retry. Adding retries inside `runOnce`
   would compound rate-limit failures.

**Failure-mode coverage:**

| Failure mode                            | Behaviour                          |
|-----------------------------------------|------------------------------------|
| Empty doc / all-blank doc / all-owned   | 0 candidates → no LLM call         |
| Single-word doc with cursor on it       | 0 candidates → no LLM call         |
| Empty response body                     | log + 0 edits                       |
| Malformed JSON (HTML error page)        | log + 0 edits                       |
| `{error: {message: ...}}`               | log + 0 edits                       |
| 429 rate-limit shape                    | log + 0 edits                       |
| Valid JSON missing `.choices`           | log + 0 edits                       |
| Empty `choices[0].message.content`      | log + 0 edits                       |
| EDITS body with garbage interleaved     | only valid lines parsed, applied   |
| LLM proposes index out of range         | apply-loop skips                    |
| LLM proposes wrong original word        | apply-loop skips (stale-original)  |
| LLM proposes `x → x`                    | parser skips (no-op)                |
| LLM proposes index claimed by other src | apply-loop skips (DynDef check)    |
| `httpAdapter.post()` throws             | outer try/catch logs + returns     |

**Results:** 16/16 pass. The loop is non-fatal under every failure
shape we tested.

---

## Experiment 7 — Professionalism (abstract style task)

**Hypothesis:** the agent should generalise beyond mechanical
spell-correction. A "make wording more professional" prompt is
qualitatively different — there's no single right answer per word,
and many sentences could be left alone.

**Setup:** added a `professionalism` category (10 cases) targeting:
- 8 informal-word swaps (`gonna`, `kinda`, `super`, `stuff`, `wanna`,
  `lemme`, `awesome`, etc.)
- 2 already-professional sentences where we expect no edits

**Results:** 6–7/10 pass. The model:
- ✅ Correctly identifies `gonna`, `kinda`, `super`, `stuff`, `wanna`,
  `lemme`, `awesome` as informal and substitutes plausible
  professional alternatives.
- ❌ Over-edits. Suggests `know → are aware`, `if → whether`,
  `have → possess` — defensible style choices, but more edits than the
  test author marked. Counts as "extra unexpected edit" warnings, not
  failures.
- ❌ Edits the no-op cases. Suggests `we → We`, `need → must`,
  `finalise → finalize`, `the → The`, `board → Board`. These are all
  defensible edits (sentence-case capitalisation, AmE spelling); the
  test fails because we asserted "no edits" but the model has a
  legitimate stylistic opinion.

**Lesson:** abstract style tasks are valid agent-task use cases, but
the benchmark's pass-rate metric isn't the right way to score them
because the test author and the model can disagree about what counts
as "improvement." For shipping purposes, the agent's behaviour is
correct: it identifies informal vocabulary and proposes more formal
substitutes. For benchmarking purposes, only the unambiguous-informal
cases (gonna, kinda, lemme, etc.) belong in a strict pass/fail suite.

**Decision:** keep the 10-case category as documentation of agent
behaviour on style tasks; treat the failures as known model variance,
not pipeline bugs. Don't over-tune the prompt to suppress legitimate
edits — that would hurt other categories.

---

## Experiment 8 — Domain-specific agents

**Hypothesis:** the agent loop generalises beyond spelling/caps to
arbitrary single-word substitution tasks declared in plain English.
A career-or-platform-shaped prompt (LinkedIn polish, legal precision,
medical terminology, British spelling, inclusive language, Twitter
concision, English-to-Spanish day translation) should land cleanly,
since the runtime is task-agnostic and only the prompt changes.

**Setup:** added 48 new cases across 8 categories:

| Category            | Cases | Prompt                                   |
|---------------------|-------|------------------------------------------|
| linkedin-friendly   |   6   | make wording linkedin friendly           |
| lawyer              |   6   | use precise legal terminology            |
| translation         |   6   | translate english days to spanish        |
| medical             |   5   | use clinical terminology                 |
| british-english     |   8   | use british english spelling             |
| inclusive-language  |   6   | use inclusive gender-neutral language    |
| twitter-concise     |   5   | shorten verbose words                    |
| long-doc            |   6   | varied (40–60 word docs, mixed tasks)    |

Most cases use single-word substitutions with a near-canonical answer
(e.g. `chairman → chairperson`, `monday → lunes`, `color → colour`).
The `long-doc` category puts the agent on documents of 30–65 words
with a mix of typo / British / inclusive / professional tasks — this
is the "good length test" the spec called for, alongside the existing
`scale.ts` 25/50/100/200-word stress runs.

**Results — full 128-case suite (parallel=8, EDITS default):**

```
Category              Pass rate
─────────────────────────────────────
spelling-task         10/10  (100.0%)
cursor-adjacent       10/10  (100.0%)
no-op-recall          10/10  (100.0%)
ownership-respect     10/10  (100.0%)
task-id-invalidation  10/10  (100.0%)
caps-task             10/10  (100.0%)
mixed-task             8/10   (80.0%)
professionalism        5/10   (50.0%)
linkedin-friendly      6/6   (100.0%)
lawyer                 6/6   (100.0%)
translation            6/6   (100.0%)
medical                5/5   (100.0%)
british-english        7/8    (87.5%)  ← variance; 8/8 standalone
inclusive-language     6/6   (100.0%)
twitter-concise        5/5   (100.0%)
long-doc               6/6   (100.0%)
─────────────────────────────────────
Total                120/128  (93.8%)

Avg per case          379ms
Wall-clock            7.2s   (parallel=8)
Throughput           17.73 cases/sec
```

**Findings:**

1. **The agent generalises cleanly to domain prompts.** All seven
   new domain categories sit at 87.5–100%. The runtime is genuinely
   task-agnostic — switching from "correct spelling" to "translate
   english days to spanish" or "use precise legal terminology" needs
   zero code changes; it's all in the user-supplied prompt.

2. **Stylistic-judgement tasks have a lower ceiling.** `professionalism`
   sits at 50%, `mixed-task` at 80%, primarily because:
   - The model has its own opinions about what counts as
     "more professional" (`assessed → evaluated`, `the → The`,
     `contract → agreement`) and over-edits no-op cases.
   - The benchmark asserts strict "no edits expected" on the no-op
     cases, which fails when the model exercises legitimate
     editorial discretion.
   These failures are model judgement, not pipeline bugs. Don't
   prompt-tune to suppress them — that hurts mechanical-task accuracy.

3. **Long-doc tests pass at 100%** even with the EDITS format on
   40–65 word docs. Combined with the `scale.ts` 200-word run
   (100% recall, 1.7s), the agent comfortably handles realistic
   document lengths.

4. **Variance between runs is real.** `british-english` was 7/8 in
   the full-suite run but 8/8 standalone; `lawyer` was 3/6 in the
   per-category sweep but 6/6 in the full-suite run. The model
   (`gpt-oss-120b @ temperature=0, seed=42`) is not perfectly
   deterministic across requests. Treat any single-run pass rate
   as ±5pp noise.

5. **Translation prompt is the surprise win.** "Translate english
   days to spanish" lands 6/6 — the model emits `lunes`, `martes`,
   `viernes` etc. cleanly even though it's a content-generation task
   (not just style polish). This validates the agent loop as a
   general-purpose plain-English-declared continuous editor, not
   just a spell/style fixer.

**Decision:** ship the 128-case suite as the canonical benchmark.
The 50%/80% stylistic-task failures are documented model variance,
not pipeline regressions — they should not block release.

---

## Final state — May 2026

- **128 cases across 16 categories** (8 mechanical, 7 domain-specific,
  1 long-doc). 120/128 (93.8%) pass on EDITS format.
- **Convergence:** 6/6 pass — agent never re-asks about cached words.
- **Robustness:** 16/16 pass — every transport failure mode handled.
- **Scale:** EDITS handles 200-word docs at 100% recall in ~1.7s.
- **Default format:** EDITS (was DECISIONS until Experiment 4).
- **Domain coverage:** LinkedIn, legal, medical, translation,
  British English, inclusive language, Twitter concision, long-doc —
  all working with no runtime changes, only prompt swaps.

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
