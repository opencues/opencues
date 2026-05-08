# Continue — agent-rewrite session

> **Read this when resuming work on the agent-task system.**
>
> The legacy AgentLoop / Judge / four-runtime-guards architecture
> was retired in May 2026 in favour of `AgentRewrite`: a cadence-
> driven module that emits the full rewritten buffer per round and
> three-way-merges it against the live buffer so user typing is
> never clobbered.

---

## Where we left off (2026-05-07)

- All work is **uncommitted** in the worktree. Per CLAUDE.md, never
  commit unless explicitly asked.
- 605/605 unit + integration tests green
  (`npx vitest run` from `packages/opencues-runtime/`).
- TypeScript clean (`npx tsc --noEmit`).
- AgentRewrite is wired as the only agent path in all three boots
  (oc/v1.4, cc/v2.1, chrome/v1).
- Legacy files DELETED:
  - `agent-loop.ts` + 3 test files
  - `judge.ts` + 1 test file
  - `tests/benchmarks/agent-task/` whole directory
  - 3 dead settings (`agent-mode`, `agent-judge-mode`,
    `agent-retry-mode`) gone from `config-loader.ts`,
    `defaults/OPENCUES.md`, and `~/.cues/OPENCUES.md`.

---

## What changed and where

### New runtime modules

| File | Lines | Role |
|---|---|---|
| `src/modules/word-diff.ts` | ~155 | Pure word-LCS diff — `wordDiff`, `applyHunks`, `translateAToC`, `threeWayMerge`. No external dep. |
| `src/modules/agent-rewrite.ts` | ~250 | Timer + LLM call + three-way merge + DynDef placement + cursor translation. The single agent module. |

### New tests

| File | Tests | What it covers |
|---|---|---|
| `src/modules/word-diff.test.ts` | 27 | Every diff edge case — substitutions, deletions, insertions, ranges, paragraphs, ordering. |
| `src/modules/word-diff.scenarios.test.ts` | 13 | Live-typing merge scenarios (synthetic, no LLM). |
| `src/modules/agent-rewrite.test.ts` | 33 | Full pipeline integration — basic flow, live typing, task changes mid-round, LLM failures, DynDefs, cursor, concurrency. |

### Boot wiring

All three boots now construct only `AgentRewrite` and call
`.start()`. The `reconcileAgent` flip logic between rewrite/edits is
gone — there's only one agent module to instantiate.

### Settings

Three settings deleted (`agent-mode`, `agent-judge-mode`,
`agent-retry-mode`). The runtime no longer reads them from
`OPENCUES.md`. Existing user files with these keys are silently
ignored — no migration needed.

### Docs

- `docs/architecture/agent-task.md` — 905 → 185 lines. Header now
  states the single-implementation status; legacy is acknowledged
  as git-history-only. Architecture section describes the cadence,
  the three-way merge, and the structural invariants the merge
  layer enforces.
- `docs/features/agent-task.md` — "How it works" rewritten as a
  single section. Debug-log examples updated. "Subjective grammar
  oscillation" caveat reworded (each round is independent now).

### New benchmarks

`tests/benchmarks/agent-rewrite/`:

| File | Role |
|---|---|
| `cases.ts` | 17 cases × 7 categories (spelling, capitalisation, translation, grammar, paragraph-structure, idempotent, style, long-doc). |
| `groq.ts` | Standard Groq client (copy of transform-blank's). |
| `run.ts` | Main runner with `--parallel`, `--category`, `--case`, `--verbose` flags. |
| `live-typing.ts` | Stress test: simulates user typing during the LLM call and asserts user content survives. |

---

## How to re-run things

From `packages/opencues-runtime/`:

```bash
# Unit + integration tests (no network needed)
npx vitest --reporter=dot run

# Just the diff core
npx vitest run src/modules/word-diff.test.ts

# Just the live-typing scenarios (synthetic, no LLM)
npx vitest run src/modules/word-diff.scenarios.test.ts

# Full agent-rewrite pipeline tests
npx vitest run src/modules/agent-rewrite.test.ts
```

From repo root (Groq API):

```bash
# Full benchmark suite
GROQ_API_KEY=... npx tsx tests/benchmarks/agent-rewrite/run.ts --parallel 4

# One category
GROQ_API_KEY=... npx tsx tests/benchmarks/agent-rewrite/run.ts --category spelling

# One case
GROQ_API_KEY=... npx tsx tests/benchmarks/agent-rewrite/run.ts --case sp-1 --verbose

# Live-typing robustness
GROQ_API_KEY=... npx tsx tests/benchmarks/agent-rewrite/live-typing.ts
```

---

## Live observations from production logs (2026-05-07)

After flipping `agent-mode: rewrite` ON in `~/.cues/OPENCUES.md`:

- **Zero** `clamping cursor` events across multi-hour sessions.
- **Zero** `task changed mid-round` discards.
- **Zero** comma-cascade flips (`Hi → Hi,` then `Hi, → Hi`).
- **Zero** `I am am`-style edge-duplications.

These were the four classes of bugs the legacy AgentLoop's
per-edit guards were defending against. Under AgentRewrite they
can't form by construction (drift dropped via overlap detection;
oscillation impossible because each round re-reads from current
state; cascades impossible because there's only one rewrite per
round; edge-duplication impossible because the rewrite IS the final
text, not a delta to compose).

---

## Things deferred

1. **Token-cost benchmarking on long docs.** Full-rewrite scales
   linearly with doc length. For very long docs (~5000 words)
   this could be expensive vs the legacy per-edit approach. Worth
   measuring and possibly bounding (e.g. "rewrite at most the last
   N paragraphs around the cursor").
2. **Cycling story for multi-word range hunks.** Each applied hunk
   gets one DynDef. For a hunk that replaces 4 words with 5, cycling
   Down reverts the whole hunk. Whether the user wants finer-grain
   reverts (per-word) is unclear — current granularity matches the
   LLM's intended atomic edit.
3. **Cadence under load.** 1.5 s pure timer. If the LLM consistently
   takes 2+ s, rounds back-to-back. Worth measuring whether to
   adapt cadence to latency.

---

## Open follow-ups the user might pick up

- **Commit the AgentRewrite work.** Per CLAUDE.md I waited for
  explicit ask. Suggested commit shape: one bundled commit
  ("feat(agent-task): replace AgentLoop + Judge with AgentRewrite
  (full-buffer rewrite + three-way merge)"), or split into
  (a) the new modules, (b) wire+remove-legacy, (c) docs+benchmarks.

---

## File locator (quick reference)

| Concern | File |
|---|---|
| Diff + merge core | `packages/opencues-runtime/src/modules/word-diff.ts` |
| AgentRewrite module | `packages/opencues-runtime/src/modules/agent-rewrite.ts` |
| Per-task state (still shared) | `packages/opencues-runtime/src/state/agent-task.ts` |
| EXTRACT classifier (TASK_*) | `packages/opencues-core/src/sources/transform-blank-source.ts` |
| Resolver wiring (TASK_* trim) | `packages/opencues-runtime/src/modules/resolver.ts` |
| Architecture doc | `docs/architecture/agent-task.md` |
| Feature doc | `docs/features/agent-task.md` |
| Benchmark cases | `tests/benchmarks/agent-rewrite/cases.ts` |
| Main runner | `tests/benchmarks/agent-rewrite/run.ts` |
| Live-typing benchmark | `tests/benchmarks/agent-rewrite/live-typing.ts` |
