# Continue — agent-task benchmark + hardening session

> **Read this when resuming.** This session expanded the agent-task
> benchmark from 70 → 128 cases, added three new benchmark scripts
> (convergence, scale, robustness), A/B-tested the LLM prompt format
> and switched the default, hardened the loop's error handling, and
> updated the architecture + feature docs to match.

---

## Where we left off (2026-05-04)

- All work is **uncommitted** in the worktree. User did not ask to
  commit; per CLAUDE.md "NEVER commit unless explicitly asked."
- Branch: `worktree-zesty-strolling-waterfall`
- 542/542 runtime unit tests green
- 16/16 robustness scenarios green
- 6/6 convergence scenarios green
- 120/128 benchmark cases pass (93.8%); the 8 failures are documented
  model variance on stylistic-judgement tasks (see EXPERIMENTS.md
  "Final state" section).

`git status --short` snapshot at last check:

```
 M docs/architecture/agent-task.md
 M docs/features/agent-task.md
 M packages/opencues-runtime/src/modules/agent-loop.ts
 M tests/benchmarks/agent-task/EXPERIMENTS.md
 M tests/benchmarks/agent-task/cases.ts
 M tests/benchmarks/agent-task/run.ts
?? tests/benchmarks/agent-task/convergence.ts
?? tests/benchmarks/agent-task/robustness.ts
?? tests/benchmarks/agent-task/scale.ts
```

---

## What changed and where

### Runtime (one file touched)

`packages/opencues-runtime/src/modules/agent-loop.ts`
- New `AgentLoopOptions.promptFormat: 'DECISIONS' | 'EDITS'`
  (default `'EDITS'` — see Experiment 4 below).
- `callEditPass` selects between two system-prompt constants
  (`EDITS_SYSTEM_PROMPT`, `DECISIONS_SYSTEM_PROMPT`) at the bottom of
  the file.
- Dynamic max_tokens scales differently per format
  (EDITS: `8 × candidates + 600`, capped at 2200;
  DECISIONS: `30 × candidates + 600`, capped at 4096).
- Defensive parse paths added: empty body, malformed JSON, missing
  `.choices`, empty content, and `{error}` shapes all log + return
  `[]` instead of throwing. No retry loop — the next text-change is
  the implicit retry.
- Header comment reframed: no longer "v1 minimal viable", now points
  at the architecture doc's "Implementation outcomes" section.

### Benchmark suite (one expansion + three new scripts)

All under `tests/benchmarks/agent-task/`:

| File              | Status   | What it does                                          |
|-------------------|----------|-------------------------------------------------------|
| `cases.ts`        | modified | 70 → 128 cases. 8 new categories added (see below).   |
| `run.ts`          | modified | Added `--format DECISIONS\|EDITS` flag                 |
| `convergence.ts`  | NEW      | 6 scenarios pinning the cache contract                |
| `scale.ts`        | NEW      | 25/50/100/200-word docs; latency + recall measurement |
| `robustness.ts`   | NEW      | 16 stubbed-transport scenarios (no network)           |
| `EXPERIMENTS.md`  | modified | Added Experiments 4–8 + final-state summary            |

Existing files for orientation (read these for context):
- `cases.ts` — the case list, organised by category. New cases are
  appended at the bottom (linkedin → long-doc).
- `groq.ts` — the Groq client + `httpAdapter` shape used by all
  benchmarks. Set `GROQ_API_KEY` env var.
- `EXPERIMENTS.md` — the running log; reads top-to-bottom as a
  decision narrative.

### New benchmark categories (48 cases added)

| Category            | Cases | Prompt theme                                  |
|---------------------|-------|-----------------------------------------------|
| linkedin-friendly   |   6   | slang → networking polish                     |
| lawyer              |   6   | casual → legal terminology                    |
| translation         |   6   | English days → Spanish                        |
| medical             |   5   | lay → clinical                                |
| british-english     |   8   | American → British spelling                   |
| inclusive-language  |   6   | gendered occupational nouns → neutral         |
| twitter-concise     |   5   | verbose → terse                               |
| long-doc            |   6   | 30–65 word docs, mix of tasks                  |

User explicitly asked for "career or platform specific agents" and
"a good length test" — the long-doc category satisfies the latter
(complementing the existing `scale.ts` 25/50/100/200-word stress).

### Documentation updates

`docs/architecture/agent-task.md`
- Appended "Implementation outcomes (post-experiment)" section at end.
- Covers: EDITS-vs-DECISIONS decision, defensive parse paths,
  apply-side defence, the cursor-adjacency test bug, cache contract,
  scope of tested tasks, answers to all four originally-open questions.

`docs/features/agent-task.md`
- Replaced stale "v1: 6 categories, 70% spelling" table with current
  16-category breakdown (mechanical / stability / stylistic groups).
- Latency section refreshed to ~379ms suite avg.
- Architecture references section now lists all 4 benchmark scripts
  with their flags + points at EXPERIMENTS.md.

---

## Key findings (TL;DR — see EXPERIMENTS.md for receipts)

1. **EDITS format beats DECISIONS** on every dimension.
   - 70-case suite: 100% vs 92.9–97.1%, 30% lower latency.
   - 200-word doc: 1.7s / 100% recall vs 8.5s / 25% recall.
   - Why DECISIONS lost: at high candidate counts the model spent its
     output budget reciting `<idx> | <word> | KEEP` lines and ran out
     of tokens. The runtime already provides implicit completeness:
     any candidate index missing from the response is recorded as
     evaluated and won't be re-asked.
   - Made EDITS the default. DECISIONS preserved for future experiments.

2. **The cache contract holds**.
   - 6/6 convergence scenarios pass.
   - Re-running on unchanged text fires zero LLM calls in steady state.
   - `appendToPrompt` regenerates taskId → forces full re-eval.

3. **Loop survives every transport failure shape we tested** (16/16):
   empty body, malformed JSON, rate limits, throws, missing fields,
   bogus LLM output (out-of-range index, stale original word, no-op,
   claimed-index, garbage interleaved with valid edits).

4. **Domain prompts work with no code changes.** LinkedIn, legal,
   medical, translation, British English, inclusive language, Twitter
   concision — all 87.5–100% pass. The runtime is genuinely
   task-agnostic; the prompt is the whole interface.

5. **Stylistic tasks have a lower ceiling** (professionalism ~50%,
   mixed-task ~80%). Model has its own opinions on what counts as
   "more professional" and over-edits clean prose. Documented as
   model judgement, not pipeline bug. **Don't prompt-tune to
   suppress** — that hurts mechanical-task accuracy.

6. **Variance between runs is real**: ±5pp at the same model + seed.
   `british-english` was 7/8 in one suite run, 8/8 standalone.

---

## How to re-run things

From the worktree root (`/home/wilfred/opencues/.claude/worktrees/zesty-strolling-waterfall`):

```bash
# Full suite (needs GROQ_API_KEY)
npx tsx tests/benchmarks/agent-task/run.ts --parallel 8

# One category
npx tsx tests/benchmarks/agent-task/run.ts --parallel 8 --category linkedin-friendly

# A/B prompt formats
npx tsx tests/benchmarks/agent-task/run.ts --parallel 8 --format DECISIONS
npx tsx tests/benchmarks/agent-task/run.ts --parallel 8 --format EDITS

# The three standalone scripts
npx tsx tests/benchmarks/agent-task/convergence.ts
npx tsx tests/benchmarks/agent-task/scale.ts
AGENT_FORMAT=EDITS npx tsx tests/benchmarks/agent-task/scale.ts
npx tsx tests/benchmarks/agent-task/robustness.ts        # no GROQ_API_KEY needed (stubbed)

# Unit tests
npx vitest --root packages/opencues-runtime run --reporter=dot
```

`scale.ts` and `robustness.ts` accept no flags. `scale.ts` reads
`AGENT_FORMAT` env to switch formats.

---

## Things deferred (not started this session)

From `EXPERIMENTS.md` "Experiments deferred to later sessions":

1. **Classify-first vs always-edit** — does a cheap "anything to do?"
   pre-classifier save tokens vs the current always-call edit pass?
2. **What does the agent SEE** — full doc with `[N]word` indexed
   format vs just-candidates vs `<owned>...</owned>` markers.
3. **Cadence backoff** — should consecutive no-ops slow the loop
   (500ms → 1s → 2s)?
4. **Multi-edit batching** — could stagger applied edits for
   animation effect.
5. **Word-level vs region-level** — current format is single-word
   swap; could extend to span-level for sentence rewrites.

Not blockers — the system is shippable as-is.

---

## Open follow-up the user might pick up

- **Commit the work.** Per CLAUDE.md I waited for explicit ask.
  Suggested commit shape: one commit for runtime change + one for
  benchmark expansion + one for docs, OR a single bundled commit
  since the work is cohesive.
- **Decide on the five deferred experiments** above. None are
  blocking; pick whichever matches the next user goal.
- **Stylistic-task scoring methodology.** The professionalism +
  mixed-task failures are model judgement, not bugs. Could either
  (a) loosen the assertions, (b) drop those cases from the headline
  pass-rate metric, or (c) leave as-is to surface model behaviour.
  Currently (c).

---

## File locator (quick reference)

| Concern                          | File                                                                            |
|----------------------------------|---------------------------------------------------------------------------------|
| Loop logic + LLM call            | `packages/opencues-runtime/src/modules/agent-loop.ts`                           |
| Per-task cache state             | `packages/opencues-runtime/src/state/agent-task.ts`                             |
| EXTRACT classifier (TASK_*)      | `packages/opencues-core/src/sources/transform-blank-source.ts`                  |
| Resolver wiring                  | `packages/opencues-runtime/src/modules/resolver.ts` (`handleTaskCommand`)       |
| Architecture doc                 | `docs/architecture/agent-task.md` (see "Implementation outcomes" at end)        |
| Feature doc                      | `docs/features/agent-task.md`                                                   |
| Experiment log                   | `tests/benchmarks/agent-task/EXPERIMENTS.md`                                    |
| Cases                            | `tests/benchmarks/agent-task/cases.ts`                                          |
| Main runner                      | `tests/benchmarks/agent-task/run.ts`                                            |
| Convergence / scale / robustness | `tests/benchmarks/agent-task/{convergence,scale,robustness}.ts`                 |
